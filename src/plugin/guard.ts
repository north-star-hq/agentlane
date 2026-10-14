import { CLI, TOOL } from '../name.ts';
import { formatAge, formatTime } from '../registry/format.ts';
import { describeOwner, isProven } from '../registry/owner.ts';
import type { LaneStatus } from '../registry/types.ts';
import type { Aim, AimedCommand, BrowserDriver, DevicePlatform } from './aims.ts';
import { aimsOf } from './aims.ts';

export interface GuardContext {
  self: string | null;
  cwd: string;
  lanes: readonly LaneStatus[];
  now: number;
  worktreeOf: (dir: string) => string | null;
  sessionName: (lane: LaneStatus) => string | null;
}

export type Verdict = { allow: true } | { allow: false; reason: string };

const KIND: Record<DevicePlatform, string> = { ios: 'simulator', android: 'emulator' };

function deviceLabel(lane: LaneStatus): string {
  const device = lane.device;
  if (!device) return 'a device';
  return `${KIND[device.platform]} ${device.name} (${device.serial ?? device.id})`;
}

const DRIVER: Record<BrowserDriver, string> = { playwright: 'playwright-cli', 'agent-browser': 'agent-browser' };

function browserLabel(lane: LaneStatus): string {
  const browser = lane.browser;
  if (!browser) return 'a browser';
  return `${DRIVER[browser.driver]} session ${browser.session} (debugging port ${String(browser.debugPort)})`;
}

function isBrowserAim(aim: Aim): aim is Extract<Aim, { kind: 'browser-session' | 'browser-port' | 'every-browser' }> {
  return aim.kind === 'browser-session' || aim.kind === 'browser-port' || aim.kind === 'every-browser';
}

function matches(lane: LaneStatus, platform: DevicePlatform, ref: string): boolean {
  const device = lane.device;
  if (device?.platform !== platform) return false;
  return device.id.toLowerCase() === ref.toLowerCase() || device.name === ref || device.serial === ref;
}

class Judge {
  private readonly ctx: GuardContext;
  private readonly held: LaneStatus[];
  private readonly browsers: LaneStatus[];
  private readonly worktrees = new Map<string, string | null>();

  constructor(ctx: GuardContext) {
    this.ctx = ctx;
    this.held = ctx.lanes.filter(c => c.device !== null && !isProven(c.ownerState));
    this.browsers = ctx.lanes.filter(c => c.browser !== null && !isProven(c.ownerState));
  }

  private worktree(cwd: string | null): string | null {
    if (cwd === null) return null;
    if (!this.worktrees.has(cwd)) this.worktrees.set(cwd, this.ctx.worktreeOf(cwd));
    return this.worktrees.get(cwd) ?? null;
  }

  private mine(lane: LaneStatus, cwd: string | null): boolean {
    if (this.ctx.self === null || lane.ownerKey !== this.ctx.self) return false;
    const folder = this.worktree(cwd);
    return folder === null || lane.worktree === folder;
  }

  own(platform: DevicePlatform, cwd: string | null): LaneStatus | null {
    return this.held.find(c => c.device?.platform === platform && this.mine(c, cwd)) ?? null;
  }

  ownBrowser(cwd: string | null): LaneStatus | null {
    return this.browsers.find(c => this.mine(c, cwd)) ?? null;
  }

  others(aimed: AimedCommand): LaneStatus[] {
    const { aim, cwd } = aimed;
    const theirs = (c: LaneStatus) => !this.mine(c, cwd);
    switch (aim.kind) {
      case 'device':
        return this.held.filter(c => matches(c, aim.platform, aim.ref) && theirs(c));
      case 'booted':
        return this.held.filter(
          c => c.device?.platform === 'ios' && (c.deviceState === 'booted' || c.deviceState === 'unknown') && theirs(c),
        );
      case 'every':
        return this.held.filter(c => c.device?.platform === aim.platform && theirs(c));
      case 'unselected':
        return this.held.filter(c => c.device?.platform === 'android' && theirs(c));
      case 'browser-session':
        return this.browsers.filter(c => c.browser?.session === aim.session && theirs(c));
      case 'browser-port':
        return this.browsers.filter(c => (c.browser?.debugPort === aim.port || c.browser?.streamPort === aim.port) && theirs(c));
      case 'every-browser':
        return this.browsers.filter(c => c.browser?.driver === aim.driver && theirs(c));
    }
  }

  holder(lane: LaneStatus, aim: Aim): string {
    const name = this.ctx.sessionName(lane);
    const who = `${describeOwner(lane.owner)}${name ? ` "${name}"` : ''}`;
    const sibling = this.ctx.self !== null && lane.ownerKey === this.ctx.self ? ' (this session, for another folder)' : '';
    const label = isBrowserAim(aim) ? `its browser, ${browserLabel(lane)}` : deviceLabel(lane);
    return `  held by ${who}${sibling} in ${lane.worktree}, since ${formatTime(lane.createdAt)}; ${label}, lane ${lane.id}, last used ${formatAge(this.ctx.now - lane.lastUsedAt)} ago (${lane.lastAction})`;
  }
}

function summary(aimed: AimedCommand, holders: readonly LaneStatus[]): string {
  const quoted = aimed.command.length > 120 ? `${aimed.command.slice(0, 117)}...` : aimed.command;
  const [first] = holders;
  switch (aimed.aim.kind) {
    case 'device':
      return `\`${quoted}\` aims at ${first ? deviceLabel(first) : 'a device'}, which this session doesn't hold here`;
    case 'booted':
      return `\`${quoted}\` aims at "booted", and a simulator this session doesn't hold here is booted`;
    case 'every':
      return `\`${quoted}\` acts on every ${KIND[aimed.aim.platform]}, and other lanes hold some`;
    case 'unselected':
      return `\`${quoted}\` names no device, so adb picks the only one running, and other lanes hold emulators`;
    case 'browser-session':
      return `\`${quoted}\` aims at the ${DRIVER[aimed.aim.driver]} session ${aimed.aim.session}, another lane's browser`;
    case 'browser-port':
      return `\`${quoted}\` attaches to port ${String(aimed.aim.port)}, another lane's browser`;
    case 'every-browser':
      return `\`${quoted}\` stops every Playwright browser on this Mac, and other lanes hold some`;
  }
}

function browserRecovery(aimed: AimedCommand, holders: readonly LaneStatus[], judge: Judge, self: string | null): string[] {
  const own = judge.ownBrowser(aimed.cwd);
  const lines: string[] = [];
  if (aimed.aim.kind === 'every-browser') lines.push(`${CLI} release   (stops this lane's browser and nothing else)`);
  if (own?.browser)
    lines.push(
      `drop the session and port flags and run it under ${CLI} exec, which binds the driver to your own browser (${own.browser.session}, "$AGENTLANE_BROWSER_SESSION")`,
    );
  else lines.push(`${CLI} up --platform web   (claims a browser of your own; then run the driver under ${CLI} exec)`);
  for (const lane of holders) {
    if (self !== null && lane.ownerKey === self)
      lines.push(`cd ${lane.worktree}   (that lane is this session's, for that folder)`);
    else lines.push(`${CLI} release --lane ${lane.id} --force   (only if you know that session no longer needs it)`);
  }
  lines.push(`${CLI} status   (every lane with its owner)`);
  return lines;
}

function recovery(aimed: AimedCommand, holders: readonly LaneStatus[], judge: Judge, self: string | null): string[] {
  if (isBrowserAim(aimed.aim)) return browserRecovery(aimed, holders, judge, self);
  const platform: DevicePlatform = aimed.aim.kind === 'device' || aimed.aim.kind === 'every' ? aimed.aim.platform : 'ios';
  const effective = aimed.aim.kind === 'unselected' ? 'android' : platform;
  const own = judge.own(effective, aimed.cwd);
  const lines: string[] = [];
  const how = effective === 'android' ? 'adb -s <serial>' : 'its UDID instead of "booted" or "all"';
  if (own?.device)
    lines.push(
      `aim at your own ${KIND[effective]}: ${own.device.serial ?? own.device.id} (${how}; "$AGENTLANE_DEVICE" under ${CLI} exec)`,
    );
  else
    lines.push(
      `${CLI} up   (or ${TOOL} claim: get a ${KIND[effective]} of your own, then aim at "$AGENTLANE_DEVICE" with ${how})`,
    );
  for (const lane of holders) {
    if (self !== null && lane.ownerKey === self)
      lines.push(`cd ${lane.worktree}   (that lane is this session's, for that folder)`);
    else lines.push(`${CLI} release --lane ${lane.id} --force   (only if you know that session no longer needs it)`);
  }
  lines.push(`${CLI} status   (every lane with its owner)`);
  return lines;
}

export function guard(script: string, env: NodeJS.ProcessEnv, ctx: GuardContext): Verdict {
  const aims = aimsOf(script, env, ctx.cwd);
  if (aims.length === 0) return { allow: true };
  const judge = new Judge(ctx);
  for (const aimed of aims) {
    const holders = judge.others(aimed);
    if (holders.length === 0) continue;
    const lines = [
      `${TOOL}: blocked: ${summary(aimed, holders)}.`,
      ...holders.map(c => judge.holder(c, aimed.aim)),
      'to recover:',
    ];
    for (const line of recovery(aimed, holders, judge, ctx.self)) lines.push(`  ${line}`);
    return { allow: false, reason: lines.join('\n') };
  }
  return { allow: true };
}
