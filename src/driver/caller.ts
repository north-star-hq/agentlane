import fs from 'node:fs';
import { CLI } from '../name.ts';
import type { ProcessTable } from '../processes.ts';
import { describeOwner, ownerKey, resolveOwner, type Owner } from '../registry/owner.ts';
import { databasePath, stateDir } from '../registry/paths.ts';
import { tcpProbe } from '../registry/ports.ts';
import { NotClaimed } from '../registry/refusal.ts';
import { Registry } from '../registry/registry.ts';
import type { Lane } from '../registry/types.ts';
import { resolveFolder } from '../registry-cli.ts';

export interface Caller {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The folder whose lane to use; the caller's git worktree when absent. */
  worktree?: string | undefined;
  processes: ProcessTable;
  selfPid?: number;
  /** A resolved owner, for a long-lived caller such as the MCP server. */
  owner?: Owner;
  /** What the lane must hold: a device (the default), a browser, or either. */
  need?: 'device' | 'browser' | 'either';
}

export interface CallerLane {
  lane: Lane;
  stateDir: string;
  owner: Owner;
}

function claimCommand(worktree: string): string {
  return `${CLI} claim --boot   (run in ${worktree}; it claims a simulator for this session), then call again`;
}

/**
 * The caller's own lane: the one its session holds for its folder, or, when the session holds exactly one lane
 * with a simulator, that one. The device always comes from the lane, never from the caller.
 */
export function resolveCallerLane(caller: Caller): CallerLane {
  const owner = caller.owner ?? resolveOwner(caller.env, caller.processes, caller.selfPid);
  const folder = resolveFolder(caller.worktree ?? caller.cwd);
  const dir = stateDir(caller.env);
  if (!fs.existsSync(databasePath(dir))) {
    throw new NotClaimed(`${describeOwner(owner)} holds no lane (there is no registry yet)`, claimCommand(folder.worktree));
  }
  const registry = Registry.open({ dir, processes: caller.processes, ports: tcpProbe, devices: {} });
  try {
    const need = caller.need ?? 'device';
    const holds = (c: { device: unknown; browser: unknown }) =>
      need === 'device' ? c.device !== null : need === 'browser' ? c.browser !== null : c.device !== null || c.browser !== null;
    let lane = registry.find(owner, folder.worktree);
    if (!lane && caller.worktree === undefined) {
      const key = ownerKey(owner);
      const own = registry.status().lanes.filter(c => c.ownerKey === key && holds(c));
      const only = own.length === 1 ? own[0] : undefined;
      if (only) lane = registry.find(owner, only.worktree);
      else if (own.length > 1) {
        throw new NotClaimed(
          `${describeOwner(owner)} holds no lane in ${folder.worktree}, and ${String(own.length)} lanes elsewhere (${own.map(c => c.worktree).join(', ')})`,
          `pass the folder whose simulator you mean (--worktree <dir>), or ${claimCommand(folder.worktree)}`,
        );
      }
    }
    if (!lane) throw new NotClaimed(`${describeOwner(owner)} holds no lane in ${folder.worktree}`, claimCommand(folder.worktree));
    if (need === 'browser' && !lane.browser) {
      throw new NotClaimed(
        `lane ${lane.id} in ${lane.worktree} holds no browser`,
        `${CLI} up --platform web   (it claims a browser and opens the web app in it)`,
      );
    }
    if (!holds(lane)) {
      throw new NotClaimed(
        `lane ${lane.id} in ${lane.worktree} holds ports but no simulator${need === 'either' ? ' and no browser' : ''}`,
        need === 'either' ? `${CLI} up` : `${CLI} release, then ${CLI} claim --boot`,
      );
    }
    return { lane, stateDir: dir, owner };
  } finally {
    registry.close();
  }
}
