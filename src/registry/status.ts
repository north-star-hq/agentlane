import type { Clock } from '../clock.ts';
import type { BackendDevice, DeviceBackend, Platform } from '../devices/backend.ts';
import type { ProcessTable } from '../processes.ts';
import type { RegistryConfig } from './config.ts';
import { judgeProcess, ownerState, worktreeState } from './owner.ts';
import { pendingTeardowns } from './resources.ts';
import { endedFromHistory, loadLaneInfo } from './rows.ts';
import type { Store } from './store.ts';
import { int, optText, text } from './store.ts';
import type { LaneInfo, LaneStatus, DeviceState, PoolDeviceStatus, QueueEntry, StatusReport } from './types.ts';

export interface StatusSources {
  dir: string;
  config: RegistryConfig;
  processes: ProcessTable;
  devices: Partial<Record<Platform, DeviceBackend>>;
  clock: Clock;
}

const RECENT_MS = 24 * 3_600_000;

export function readStatus(store: Store | null, sources: StatusSources): StatusReport {
  const now = sources.clock.now();
  const report: StatusReport = {
    stateDir: sources.dir,
    now,
    config: sources.config,
    lanes: [],
    pool: [],
    queue: [],
    recent: [],
    teardowns: [],
  };
  if (!store) return report;
  const db = store.db;
  const lanes = db
    .prepare('SELECT id FROM claims ORDER BY created_at')
    .all()
    .map(row => loadLaneInfo(db, text(row, 'id')))
    .filter((c): c is LaneInfo => c !== null);
  const table = sources.processes.startTimes(lanes.flatMap(c => (c.owner.process ? [c.owner.process.pid] : [])));
  const listed = new Map<Platform, Map<string, BackendDevice> | null>();
  for (const backend of Object.values(sources.devices)) {
    if (db.prepare('SELECT 1 FROM devices WHERE platform = ? LIMIT 1').get(backend.platform) === undefined) continue;
    try {
      listed.set(backend.platform, new Map(backend.list().map(d => [d.id, d])));
    } catch {
      listed.set(backend.platform, null);
    }
  }
  const stateOf = (platform: Platform, id: string): DeviceState => {
    const devices = listed.get(platform);
    if (!devices) return 'unknown';
    const device = devices.get(id);
    if (!device) return 'missing';
    return device.booted ? 'booted' : 'shutdown';
  };
  report.lanes = lanes.map((lane): LaneStatus => ({
    ...lane,
    ownerState: ownerState(judgeProcess(lane.owner.process, table), worktreeState(lane.worktree)),
    idleMs: now - lane.lastUsedAt,
    deviceState: lane.device ? stateOf(lane.device.platform, lane.device.id) : null,
  }));
  report.pool = db
    .prepare('SELECT * FROM devices ORDER BY created_at, name')
    .all()
    .map((row): PoolDeviceStatus => {
      const platform = text(row, 'platform') as Platform;
      const id = optText(row, 'device_id');
      return {
        name: text(row, 'name'),
        platform,
        id,
        deviceTypeName: text(row, 'device_type_name'),
        runtimeName: text(row, 'runtime_name'),
        laneId: optText(row, 'claim_id'),
        state: id === null ? 'creating' : stateOf(platform, id),
      };
    });
  report.queue = db
    .prepare('SELECT * FROM queue ORDER BY ticket')
    .all()
    .map((row): QueueEntry => ({
      ticket: int(row, 'ticket'),
      owner: text(row, 'owner_label'),
      worktree: text(row, 'worktree'),
      enqueuedAt: int(row, 'enqueued_at'),
      waiterPid: int(row, 'waiter_pid'),
    }));
  report.recent = db
    .prepare('SELECT * FROM history WHERE ended_at >= ? ORDER BY seq DESC LIMIT 20')
    .all(now - RECENT_MS)
    .map(endedFromHistory);
  report.teardowns = pendingTeardowns(db);
  return report;
}
