import { randomBytes } from 'node:crypto';
import type { BrowserDriverName } from '../browser/kinds.ts';
import { BROWSER_DEBUG_SERVICE, BROWSER_PORT_TYPE, BROWSER_SERVICES, BROWSER_STREAM_SERVICE } from '../browser/kinds.ts';
import type { Clock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import type { BackendDevice, DeviceBackend, DeviceSpec, Platform } from '../devices/backend.ts';
import { CLI, TOOL } from '../name.ts';
import type { ProcessIdentity, ProcessTable } from '../processes.ts';
import { identityOf } from '../processes.ts';
import type { RegistryConfig } from './config.ts';
import { DEVICE_MEMORY_MB, EMULATOR_PORTS, EMULATOR_SERVICE, emulatorSerial, loadConfig, poolCap } from './config.ts';
import { formatAge, formatTime } from './format.ts';
import type { Owner } from './owner.ts';
import { describeOwner, describeState, isProven, judgeProcess, ownerKey, ownerState, worktreeState } from './owner.ts';
import { configPath, diskNames } from './paths.ts';
import type { PortProbe } from './ports.ts';
import type { FreePoolDevice, PruneListing, PruneResult } from './prune.ts';
import { deletePoolDevice, listPrunable } from './prune.ts';
import type { Holder } from './refusal.ts';
import { NotClaimed, Refusal, UsageError } from './refusal.ts';
import type { TeardownChoice } from './resources.ts';
import {
  endTeardown,
  failResource,
  failTeardown,
  finishResource,
  holdersBeforeLock,
  pendingTeardowns,
  startResource,
  takeTeardowns,
} from './resources.ts';
import { loadLane, ownerFromRow } from './rows.ts';
import { readStatus } from './status.ts';
import type { Row } from './store.ts';
import { int, optInt, optText, Store, text } from './store.ts';
import type {
  Lane,
  ClaimedPort,
  LaneOutcome,
  LaneRef,
  LaneRequest,
  EndedBrowser,
  EndedLane,
  EndReason,
  PendingTeardown,
  ResourceSpec,
  ResourceStart,
  ResourceTeardown,
  ResourceValues,
  ServiceProcess,
  ServiceRequest,
  StatusReport,
} from './types.ts';

export const STEPS = [
  'claim:inspected',
  'claim:locked',
  'claim:swept',
  'claim:ticketed',
  'claim:reserved',
  'claim:reserve-committed',
  'claim:retired-device',
  'claim:created-device',
  'claim:took-over',
  'claim:inserted',
  'claim:committed',
  'claim:waiting',
  'claim:booted',
  'release:locked',
  'release:ended',
  'release:committed',
  'touch:locked',
] as const;

export type Step = (typeof STEPS)[number];

export interface RegistryOptions {
  dir: string;
  processes: ProcessTable;
  ports: PortProbe;
  devices?: Partial<Record<Platform, DeviceBackend>>;
  config?: RegistryConfig;
  clock?: Clock;
  pollMs?: number;
  lockWaitMs?: number;
  self?: ProcessIdentity;
  onStep?: (step: Step) => void;
}

interface Verdicts {
  table: ReadonlyMap<number, string> | undefined;
  lanes: ReadonlySet<string>;
  reservations: ReadonlySet<string>;
  tickets: ReadonlySet<number>;
}

interface Caller {
  key: string;
  label: string;
  worktree: string;
}

interface Progress {
  tookOver: EndedLane[];
  freed: EndedLane[];
  notes: string[];
  replacedDriver: BrowserDriverName | null;
}

interface Wait {
  kind: 'wait';
  platform: Platform;
  holders: Holder[];
  pool: string;
}

type AttemptResult =
  { kind: 'done'; lane: Lane; created: boolean } | { kind: 'reserved' } | Wait | { kind: 'refused'; refusal: Refusal };

type DevicePlan = { kind: 'assign'; name: string } | { kind: 'reserved' } | Wait;

interface EmulatorPortPlan {
  add: number | null;
  drop: number | null;
}

interface PortPlan {
  picks: ClaimedPort[];
  takeovers: string[];
}

export const HISTORY_KEEP_MS = 7 * 24 * 3_600_000;

const NOUN: Readonly<Record<Platform, string>> = { ios: 'simulator', android: 'emulator' };

function emulatorConsolePorts(): number[] {
  const ports: number[] = [];
  for (let p = EMULATOR_PORTS.last - 1; p >= EMULATOR_PORTS.first; p -= 2) ports.push(p);
  return ports;
}

function gigabytes(mb: number): string {
  return `${String(Math.round(mb / 100) / 10)} GB`;
}

function listOrNothing(backend: DeviceBackend | undefined): BackendDevice[] {
  try {
    return backend?.list() ?? [];
  } catch {
    return [];
  }
}
const DEFAULT_LOCK_WAIT_MS = 120_000;

export class Registry {
  readonly dir: string;
  readonly config: RegistryConfig;
  private readonly store: Store;
  private readonly processes: ProcessTable;
  private readonly probe: PortProbe;
  private readonly backends: Partial<Record<Platform, DeviceBackend>>;
  private readonly clock: Clock;
  private readonly pollMs: number;
  private readonly onStep: (step: Step) => void;
  private selfIdentity: ProcessIdentity | undefined;
  private claiming = false;

  private constructor(options: RegistryOptions, config: RegistryConfig, store: Store) {
    this.dir = options.dir;
    this.config = config;
    this.store = store;
    this.processes = options.processes;
    this.probe = options.ports;
    this.backends = options.devices ?? {};
    this.clock = options.clock ?? systemClock;
    this.pollMs = options.pollMs ?? 500;
    this.onStep = options.onStep ?? (() => undefined);
    this.selfIdentity = options.self;
  }

  static open(options: RegistryOptions): Registry {
    const config = options.config ?? loadConfig(options.dir);
    return new Registry(options, config, Store.open(options.dir, options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS));
  }

  close(): void {
    this.store.close();
  }

  private step(step: Step): void {
    this.onStep(step);
  }

  private self(): ProcessIdentity {
    this.selfIdentity ??= identityOf(this.processes, process.pid);
    if (!this.selfIdentity) throw new Error(`ps could not read this process's start time (pid ${String(process.pid)})`);
    return this.selfIdentity;
  }

  private backend(platform: Platform): DeviceBackend {
    const backend = this.backends[platform];
    if (backend) return backend;
    throw new UsageError(
      platform === 'ios' ? 'iOS simulators are unavailable on this machine' : 'Android emulators are unavailable on this machine',
      'claim without a device (--no-device)',
    );
  }

  private caller(owner: Owner, worktree: string): Caller {
    const caller = { key: ownerKey(owner), label: describeOwner(owner), worktree };
    this.store.actor = { who: caller.label, folder: worktree };
    return caller;
  }

  private snapshotBeforeLock(): Verdicts {
    const db = this.store.db;
    const pids: number[] = [];
    const lanes = new Set<string>();
    for (const row of db.prepare('SELECT id, owner_pid FROM claims').all()) {
      lanes.add(text(row, 'id'));
      const pid = optInt(row, 'owner_pid');
      if (pid !== null) pids.push(pid);
    }
    const reservations = new Set<string>();
    for (const row of db.prepare('SELECT name, creator_pid FROM devices WHERE device_id IS NULL').all()) {
      reservations.add(text(row, 'name'));
      pids.push(int(row, 'creator_pid'));
    }
    const tickets = new Set<number>();
    for (const row of db.prepare('SELECT ticket, waiter_pid FROM queue').all()) {
      tickets.add(int(row, 'ticket'));
      pids.push(int(row, 'waiter_pid'));
    }
    return { table: pids.length === 0 ? new Map() : this.processes.startTimes(pids), lanes, reservations, tickets };
  }

  private verdictFor(row: Row, verdicts: Verdicts) {
    return verdicts.lanes.has(text(row, 'id')) ? judgeProcess(ownerFromRow(row).process, verdicts.table) : 'alive';
  }

  private candidatePorts(services: readonly ServiceRequest[], platform: Platform | null): number[] {
    const ports = new Set<number>();
    if (platform === 'android') for (let p = EMULATOR_PORTS.first; p <= EMULATOR_PORTS.last; p++) ports.add(p);
    for (const type of new Set(services.map(s => s.type))) {
      const block = this.config.blocks[type];
      if (!block) continue;
      for (let p = block.first; p <= block.last; p++) ports.add(p);
    }
    return [...ports];
  }

  private validate(request: LaneRequest): void {
    const names = new Set<string>();
    for (const s of request.services) {
      if (names.has(s.name)) throw new UsageError(`service '${s.name}' is listed twice`, 'list each service once');
      if (s.name === EMULATOR_SERVICE) {
        throw new UsageError(
          `the service name '${EMULATOR_SERVICE}' is taken by the Android emulator's console port`,
          'give the service another name',
        );
      }
      if (BROWSER_SERVICES.includes(s.name)) {
        throw new UsageError(
          `the service name '${s.name}' is taken by the lane's browser ports`,
          'give the service another name',
        );
      }
      names.add(s.name);
      if (!this.config.blocks[s.type]) {
        throw new UsageError(
          `there is no port block for service type '${s.type}'`,
          `use one of ${Object.keys(this.config.blocks).join(', ')}, or add "ports": {"${s.type}": [first, last]} to ${configPath(this.dir)}`,
        );
      }
    }
  }

  async claim(request: LaneRequest): Promise<LaneOutcome> {
    if (this.claiming) throw new Error('a Registry claims one lane at a time');
    this.claiming = true;
    try {
      return await this.claimOnce(request);
    } finally {
      this.claiming = false;
    }
  }

  private async claimOnce(request: LaneRequest): Promise<LaneOutcome> {
    this.validate(request);
    const backend = request.device ? this.backend(request.device.platform) : null;
    const spec = backend && request.device ? backend.resolveSpec(request.device) : null;
    const caller = this.caller(request.owner, request.worktree);
    const me = this.self();
    const deadline = this.clock.now() + request.waitMs;
    const progress: Progress = { tookOver: [], freed: [], notes: [], replacedDriver: null };
    try {
      for (;;) {
        const verdicts = this.snapshotBeforeLock();
        const listening = await this.probe.listening(
          this.candidatePorts([...request.services, ...browserServices(request)], request.device?.platform ?? null),
        );
        this.step('claim:inspected');
        const result = this.store.write(() => this.attempt(request, caller, spec, backend, me, verdicts, listening, progress));
        if (result.kind === 'refused') throw result.refusal;
        if (result.kind === 'reserved') {
          this.step('claim:reserve-committed');
          continue;
        }
        if (result.kind === 'done') {
          this.step('claim:committed');
          const device = result.lane.device;
          const held = device ? this.backends[device.platform] : undefined;
          if (request.device && held && (request.boot || device?.platform === 'android')) {
            await this.boot(held, result.lane, result.created, caller, progress);
          }
          return { lane: result.lane, created: result.created, ...progress };
        }
        this.step('claim:waiting');
        const left = deadline - this.clock.now();
        if (left <= 0) throw this.poolBusy(result, request);
        await this.clock.sleep(Math.min(this.pollMs, left));
      }
    } catch (error) {
      this.abandon(me, backend);
      throw error;
    }
  }

  private async boot(backend: DeviceBackend, lane: Lane, created: boolean, caller: Caller, progress: Progress): Promise<void> {
    if (!lane.device) return;
    try {
      await backend.boot(lane.device.id, lane.ports.find(p => p.service === EMULATOR_SERVICE)?.port);
      this.step('claim:booted');
    } catch (error) {
      if (created) {
        this.store.write(() => {
          const row = this.store.db.prepare('SELECT * FROM claims WHERE id = ? AND token = ?').get(lane.id, lane.token);
          if (row) this.endAndShutDown([row], 'released', caller, progress.notes);
        });
      }
      throw error;
    }
  }

  cancelPending(): Error | null {
    return this.abandon(this.self(), null);
  }

  private abandon(me: ProcessIdentity, backend: DeviceBackend | null): Error | null {
    try {
      this.store.write(() => {
        const db = this.store.db;
        db.prepare('DELETE FROM queue WHERE waiter_pid = ? AND waiter_start = ?').run(me.pid, me.start);
        const rows = db
          .prepare('SELECT * FROM devices WHERE device_id IS NULL AND creator_pid = ? AND creator_start = ?')
          .all(me.pid, me.start);
        if (rows.length === 0) return;
        for (const row of rows) {
          this.settleReservation(row, listOrNothing(backend ?? this.backends[text(row, 'platform') as Platform]));
        }
      });
      return null;
    } catch (cleanupError) {
      return cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
    }
  }

  private attempt(
    request: LaneRequest,
    caller: Caller,
    spec: DeviceSpec | null,
    backend: DeviceBackend | null,
    me: ProcessIdentity,
    verdicts: Verdicts,
    listening: ReadonlySet<number>,
    progress: Progress,
  ): AttemptResult {
    this.step('claim:locked');
    const db = this.store.db;
    const now = this.clock.now();
    progress.freed.push(...this.sweep(verdicts, now, caller));
    const listed = this.reconcileAll(verdicts, backend, progress.notes);
    this.step('claim:swept');

    const existing = db.prepare('SELECT * FROM claims WHERE owner_key = ? AND worktree = ?').get(caller.key, caller.worktree);
    const existingId = existing ? text(existing, 'id') : null;
    let needDevice = request.device !== null;
    let held: Row | undefined;
    if (existingId !== null) {
      held = db.prepare('SELECT * FROM devices WHERE claim_id = ?').get(existingId);
      const platform = held ? (text(held, 'platform') as Platform) : null;
      if (held && platform === request.device?.platform && listed && !listed.has(text(held, 'device_id'))) {
        db.prepare('DELETE FROM devices WHERE name = ?').run(text(held, 'name'));
        progress.notes.push(`your ${NOUN[platform]} ${text(held, 'name')} no longer exists; claiming another`);
        held = undefined;
      } else if (held) {
        needDevice = false;
      }
    }

    const heldBrowser = existingId === null ? undefined : db.prepare('SELECT * FROM browsers WHERE claim_id = ?').get(existingId);
    const browserChange = request.browser
      ? existingId !== null && heldBrowser !== undefined && text(heldBrowser, 'driver') !== request.browser.driver
        ? `this lane's browser is driven by ${request.browser.driver} now, not ${text(heldBrowser, 'driver')}`
        : null
      : null;
    const wanted = [...request.services, ...browserServices(request)].filter(
      s => existingId === null || !db.prepare('SELECT 1 FROM ports WHERE claim_id = ? AND service = ?').get(existingId, s.name),
    );
    const refuse = (refusal: Refusal): AttemptResult => {
      this.dropTicket(me);
      this.dropReservation(me);
      return { kind: 'refused', refusal };
    };
    const portPlan = this.planPorts(wanted, listening, now, caller, verdicts);
    if (portPlan instanceof Refusal) return refuse(portPlan);
    const emulator = this.planEmulatorPort(request, existingId, held, needDevice, listed, listening, now);
    if (emulator instanceof Refusal) return refuse(emulator);

    let deviceName: string | null = null;
    if (needDevice && spec && backend && listed) {
      const strict = request.device?.strict === true;
      const plan = this.planDevice(spec, strict, backend, listed, me, verdicts, now, caller, progress, 0);
      if (plan.kind !== 'assign') return plan;
      deviceName = plan.name;
    }

    let tookOverPorts = false;
    for (const id of portPlan.takeovers) {
      const row = db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
      if (!row) continue;
      progress.tookOver.push(this.end(row, 'taken-over', caller, now));
      tookOverPorts = true;
    }
    if (tookOverPorts) this.step('claim:took-over');

    const action = request.action ?? 'claim';
    let laneId: string;
    if (existingId !== null) {
      laneId = existingId;
      db.prepare(
        'UPDATE claims SET last_used_at = ?, last_action = ?, owner_pid = ?, owner_start = ?, owner_session = ? WHERE id = ?',
      ).run(
        now,
        action,
        request.owner.process?.pid ?? null,
        request.owner.process?.start ?? null,
        request.owner.sessionId,
        laneId,
      );
    } else {
      do laneId = randomBytes(4).toString('hex');
      while (
        db.prepare('SELECT 1 FROM resources WHERE claim_id = ?').get(laneId) ||
        db.prepare('SELECT 1 FROM browsers WHERE claim_id = ?').get(laneId)
      );
      db.prepare(
        `INSERT INTO claims (id, token, owner_key, owner_kind, owner_pid, owner_start, owner_session, owner_thread,
           project_root, worktree, created_at, last_used_at, last_action)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        laneId,
        randomBytes(24).toString('base64url'),
        caller.key,
        request.owner.kind,
        request.owner.process?.pid ?? null,
        request.owner.process?.start ?? null,
        request.owner.sessionId,
        request.owner.threadId,
        request.projectRoot,
        request.worktree,
        now,
        now,
        action,
      );
    }
    for (const pick of portPlan.picks) {
      db.prepare('INSERT INTO ports (port, type, service, claim_id) VALUES (?, ?, ?, ?)').run(
        pick.port,
        pick.type,
        pick.service,
        laneId,
      );
    }
    if (request.browser) {
      if (heldBrowser === undefined) {
        db.prepare('INSERT INTO browsers (claim_id, driver, session, worktree, created_at) VALUES (?, ?, ?, ?, ?)').run(
          laneId,
          request.browser.driver,
          browserSession(laneId),
          request.worktree,
          now,
        );
      } else if (browserChange !== null) {
        db.prepare('UPDATE browsers SET driver = ? WHERE claim_id = ?').run(request.browser.driver, laneId);
        progress.notes.push(browserChange);
        progress.replacedDriver = text(heldBrowser, 'driver') as BrowserDriverName;
      }
      if (!browserServices(request).some(s => s.name === BROWSER_STREAM_SERVICE)) {
        db.prepare('DELETE FROM ports WHERE claim_id = ? AND service = ?').run(laneId, BROWSER_STREAM_SERVICE);
      }
    }
    if (deviceName !== null) db.prepare('UPDATE devices SET claim_id = ? WHERE name = ?').run(laneId, deviceName);
    if (emulator.drop !== null) db.prepare('DELETE FROM ports WHERE port = ?').run(emulator.drop);
    if (emulator.add !== null && (deviceName !== null || !needDevice)) {
      db.prepare('INSERT INTO ports (port, type, service, claim_id) VALUES (?, ?, ?, ?)').run(
        emulator.add,
        EMULATOR_SERVICE,
        EMULATOR_SERVICE,
        laneId,
      );
    }
    this.dropTicket(me);
    this.step('claim:inserted');
    const lane = loadLane(db, laneId);
    if (!lane) throw new Error(`lane ${laneId} vanished inside its own transaction`);
    return { kind: 'done', lane, created: existingId === null };
  }

  private ticketOf(me: ProcessIdentity): number | null {
    const row = this.store.db
      .prepare('SELECT MIN(ticket) AS ticket FROM queue WHERE waiter_pid = ? AND waiter_start = ?')
      .get(me.pid, me.start);
    return row ? optInt(row, 'ticket') : null;
  }

  private dropTicket(me: ProcessIdentity): void {
    this.store.db.prepare('DELETE FROM queue WHERE waiter_pid = ? AND waiter_start = ?').run(me.pid, me.start);
  }

  private dropReservation(me: ProcessIdentity): void {
    this.store.db
      .prepare('DELETE FROM devices WHERE device_id IS NULL AND creator_pid = ? AND creator_start = ?')
      .run(me.pid, me.start);
  }

  private sweep(verdicts: Verdicts, now: number, caller: Caller): EndedLane[] {
    const db = this.store.db;
    const freed: EndedLane[] = [];
    for (const row of db.prepare('SELECT * FROM claims').all()) {
      const state = ownerState(this.verdictFor(row, verdicts), worktreeState(text(row, 'worktree')));
      if (isProven(state)) freed.push(this.end(row, state, caller, now));
    }
    for (const row of db.prepare('SELECT * FROM queue').all()) {
      const ticket = int(row, 'ticket');
      if (!verdicts.tickets.has(ticket)) continue;
      const verdict = judgeProcess({ pid: int(row, 'waiter_pid'), start: text(row, 'waiter_start') }, verdicts.table);
      if (isProven(verdict)) db.prepare('DELETE FROM queue WHERE ticket = ?').run(ticket);
    }
    db.prepare('DELETE FROM history WHERE ended_at < ?').run(now - HISTORY_KEEP_MS);
    return freed;
  }

  private reconcileAll(verdicts: Verdicts, wanted: DeviceBackend | null, notes: string[]): Map<string, BackendDevice> | null {
    let wantedList: Map<string, BackendDevice> | null = null;
    for (const backend of Object.values(this.backends)) {
      if (backend === wanted) {
        wantedList = this.reconcile(backend, verdicts, notes);
        continue;
      }
      if (!this.store.db.prepare('SELECT 1 FROM devices WHERE platform = ? LIMIT 1').get(backend.platform)) continue;
      try {
        this.reconcile(backend, verdicts, notes);
      } catch (error) {
        notes.push(`could not check the ${backend.platform} pool: ${(error as Error).message}`);
      }
    }
    return wantedList;
  }

  private reconcile(backend: DeviceBackend, verdicts: Verdicts, notes: string[]): Map<string, BackendDevice> {
    const db = this.store.db;
    const listed = backend.list();
    const byId = new Map(listed.map(d => [d.id, d]));
    for (const row of db.prepare('SELECT * FROM devices WHERE platform = ?').all(backend.platform)) {
      const name = text(row, 'name');
      const id = optText(row, 'device_id');
      if (id === null) {
        if (!verdicts.reservations.has(name)) continue;
        const verdict = judgeProcess({ pid: int(row, 'creator_pid'), start: text(row, 'creator_start') }, verdicts.table);
        if (isProven(verdict)) notes.push(this.settleReservation(row, listed));
        continue;
      }
      const device = byId.get(id);
      const claimed = optText(row, 'claim_id') !== null;
      if (!device) {
        if (!claimed) {
          db.prepare('DELETE FROM devices WHERE name = ?').run(name);
          notes.push(`forgot pool ${NOUN[backend.platform]} ${name}: it no longer exists`);
        }
        continue;
      }
      if (!claimed && device.booted) {
        try {
          backend.shutdown(id);
          device.booted = false;
          notes.push(`shut down unclaimed pool ${NOUN[backend.platform]} ${name}`);
        } catch (error) {
          notes.push(`could not shut down unclaimed pool ${NOUN[backend.platform]} ${name}: ${(error as Error).message}`);
        }
      }
    }
    return byId;
  }

  private settleReservation(row: Row, listed: readonly BackendDevice[]): string {
    const db = this.store.db;
    const name = text(row, 'name');
    const noun = NOUN[text(row, 'platform') as Platform];
    const named = listed.filter(d => d.name === name);
    const only = named.length === 1 ? named[0] : undefined;
    if (only && !db.prepare('SELECT 1 FROM devices WHERE device_id = ?').get(only.id)) {
      db.prepare('UPDATE devices SET device_id = ?, creator_pid = NULL, creator_start = NULL WHERE name = ?').run(only.id, name);
      return `adopted pool ${noun} ${name} (${only.id}), left when claiming was interrupted`;
    }
    db.prepare('DELETE FROM devices WHERE name = ?').run(name);
    return `dropped the reservation for ${name}, left when claiming was interrupted`;
  }

  private idleLanes(now: number, caller: Caller, verdicts: Verdicts): Row[] {
    return this.store.db
      .prepare('SELECT * FROM claims WHERE last_used_at < ? AND owner_key != ? ORDER BY last_used_at ASC')
      .all(now - this.config.idleMs, caller.key)
      .filter(row => !isProven(this.verdictFor(row, verdicts)));
  }

  private planPorts(
    wanted: readonly ServiceRequest[],
    listening: ReadonlySet<number>,
    now: number,
    caller: Caller,
    verdicts: Verdicts,
  ): PortPlan | Refusal {
    const held = new Map<number, string>();
    for (const row of this.store.db.prepare('SELECT port, claim_id FROM ports').all())
      held.set(int(row, 'port'), text(row, 'claim_id'));
    const idle = wanted.length > 0 ? this.idleLanes(now, caller, verdicts) : [];
    const picks: ClaimedPort[] = [];
    const takeovers: string[] = [];
    for (const service of wanted) {
      const block = this.config.blocks[service.type];
      if (!block) continue;
      const usable = (p: number) => !listening.has(p) && !picks.some(x => x.port === p);
      let port: number | undefined;
      for (let p = block.first; p <= block.last && port === undefined; p++) {
        const holder = held.get(p);
        if (usable(p) && (holder === undefined || takeovers.includes(holder))) port = p;
      }
      for (const row of idle) {
        if (port !== undefined) break;
        const id = text(row, 'id');
        if (takeovers.includes(id)) continue;
        const theirs = [...held].find(([p, c]) => c === id && p >= block.first && p <= block.last && usable(p));
        if (theirs) {
          takeovers.push(id);
          port = theirs[0];
        }
      }
      if (port === undefined) return this.portsExhausted(service.type, held, listening, now);
      picks.push({ service: service.name, type: service.type, port });
    }
    return { picks, takeovers };
  }

  private planEmulatorPort(
    request: LaneRequest,
    laneId: string | null,
    held: Row | undefined,
    needDevice: boolean,
    listed: Map<string, BackendDevice> | null,
    listening: ReadonlySet<number>,
    now: number,
  ): EmulatorPortPlan | Refusal {
    const none = { add: null, drop: null };
    if (request.device?.platform !== 'android' || !listed) return none;
    if (!needDevice && (!held || text(held, 'platform') !== 'android')) return none;
    const row =
      laneId === null
        ? undefined
        : this.store.db.prepare('SELECT port FROM ports WHERE claim_id = ? AND service = ?').get(laneId, EMULATOR_SERVICE);
    const current = row ? int(row, 'port') : null;
    if (current !== null) {
      const running = held ? listed.get(text(held, 'device_id'))?.serial : undefined;
      const occupied = running !== emulatorSerial(current) && (listening.has(current) || listening.has(current + 1));
      if (!occupied) return none;
    }
    const taken = new Set(
      this.store.db
        .prepare('SELECT port FROM ports WHERE port BETWEEN ? AND ?')
        .all(EMULATOR_PORTS.first, EMULATOR_PORTS.last)
        .map(r => int(r, 'port')),
    );
    const running = new Set([...listed.values()].flatMap(d => (d.serial ? [d.serial] : [])));
    const free = (p: number) =>
      !taken.has(p) && !taken.has(p + 1) && !listening.has(p) && !listening.has(p + 1) && !running.has(emulatorSerial(p));
    const pick = emulatorConsolePorts().find(free);
    if (pick === undefined) return this.emulatorPortsExhausted(listening, now);
    return { add: pick, drop: current };
  }

  private emulatorPortsExhausted(listening: ReadonlySet<number>, now: number): Refusal {
    const db = this.store.db;
    const rows = db
      .prepare(
        'SELECT DISTINCT c.* FROM claims c JOIN ports p ON p.claim_id = c.id WHERE p.port BETWEEN ? AND ? ORDER BY c.last_used_at',
      )
      .all(EMULATOR_PORTS.first, EMULATOR_PORTS.last);
    const holders = rows.map(row => this.holderOf(row, now));
    const foreign = emulatorConsolePorts().filter(p => listening.has(p) || listening.has(p + 1));
    if (foreign.length > 0) {
      holders.push({
        who: `emulators or other processes the registry did not start, on console ports ${foreign.sort((a, b) => a - b).join(', ')}`,
        folder: '(unknown)',
        since: '(unknown)',
        detail: 'adb devices lists the emulators among them',
      });
    }
    const range = `${String(EMULATOR_PORTS.first)}-${String(EMULATOR_PORTS.last)}`;
    const mostIdle = rows[0];
    return new Refusal(
      'ports-exhausted',
      `no free Android emulator console and adb port pair in ${range}, the only ports a running adb server scans`,
      holders.length > 0 ? holders : [{ who: 'no lane the registry can see', folder: this.dir, since: formatTime(now) }],
      [
        mostIdle
          ? `${CLI} release   (run by the session holding lane ${text(mostIdle, 'id')}, in ${text(mostIdle, 'worktree')})`
          : `${CLI} status`,
        `lsof -nP -iTCP:${range} -sTCP:LISTEN   (names the processes on those ports)`,
      ],
    );
  }

  private memoryInUse(pool: readonly Row[], isMine: (row: Row) => boolean): number {
    let used = 0;
    for (const row of pool) {
      const busy = optText(row, 'claim_id') !== null || optText(row, 'device_id') === null;
      if (busy && !isMine(row)) used += DEVICE_MEMORY_MB[text(row, 'platform') as Platform];
    }
    return used;
  }

  private poolSummary(pool: readonly Row[]): string {
    const counts = (platform: Platform) => {
      const rows = pool.filter(r => text(r, 'platform') === platform);
      const claimed = rows.filter(r => optText(r, 'claim_id') !== null).length;
      return `${String(claimed)} of ${String(rows.length)} ${NOUN[platform]}s claimed (at most ${String(poolCap(this.config, platform))})`;
    };
    const used = this.memoryInUse(pool, () => false);
    return `${counts('ios')}, ${counts('android')}; ${gigabytes(used)} of the ${gigabytes(this.config.memoryBudgetMb)} memory budget in use`;
  }

  private planDevice(
    spec: DeviceSpec,
    strict: boolean,
    backend: DeviceBackend,
    listed: Map<string, BackendDevice>,
    me: ProcessIdentity,
    verdicts: Verdicts,
    now: number,
    caller: Caller,
    progress: Progress,
    depth: number,
  ): DevicePlan {
    const db = this.store.db;
    const platform = backend.platform;
    const noun = NOUN[platform];
    let ticket = this.ticketOf(me);
    if (ticket === null) {
      const inserted = db
        .prepare(
          'INSERT INTO queue (waiter_pid, waiter_start, owner_key, owner_label, worktree, enqueued_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(me.pid, me.start, caller.key, caller.label, caller.worktree, now);
      ticket = Number(inserted.lastInsertRowid);
      this.step('claim:ticketed');
    }
    const aheadRow = db
      .prepare(
        `SELECT COUNT(*) AS ahead FROM queue q WHERE q.ticket < ? AND NOT EXISTS (
           SELECT 1 FROM devices d WHERE d.device_id IS NULL AND d.creator_pid = q.waiter_pid AND d.creator_start = q.waiter_start)`,
      )
      .get(ticket);
    const ahead = aheadRow ? int(aheadRow, 'ahead') : 0;
    const pool = db.prepare('SELECT * FROM devices ORDER BY created_at, name').all();
    const isMine = (r: Row) =>
      optText(r, 'device_id') === null && optInt(r, 'creator_pid') === me.pid && optText(r, 'creator_start') === me.start;
    const rows = pool.filter(r => text(r, 'platform') === platform);
    const mine = rows.find(isMine);
    const free = rows.filter(r => {
      const id = optText(r, 'device_id');
      return id !== null && optText(r, 'claim_id') === null && listed.has(id);
    });
    const others = rows.length - (mine ? 1 : 0);
    const room = Math.max(0, poolCap(this.config, platform) - others);
    const spareMemory = this.config.memoryBudgetMb - this.memoryInUse(pool, isMine);
    const fits = Math.floor(spareMemory / DEVICE_MEMORY_MB[platform]);
    const wait = (): Wait => {
      this.dropReservation(me);
      return { kind: 'wait', platform, holders: this.poolHolders(now, ticket), pool: this.poolSummary(pool) };
    };
    if (ahead > 0 && Math.min(free.length + room, fits) <= ahead) return wait();
    if (fits > 0) {
      const match = free.find(r => text(r, 'device_type') === spec.deviceType && text(r, 'runtime') === spec.runtime);
      if (match) {
        this.dropReservation(me);
        return { kind: 'assign', name: text(match, 'name') };
      }
      const score = (r: Row) =>
        (text(r, 'device_type') === spec.deviceType ? 2 : 0) + (text(r, 'runtime') === spec.runtime ? 1 : 0);
      const spare = [...free].sort((a, b) => score(b) - score(a))[0];
      if (spare && room === 0 && !strict) {
        this.dropReservation(me);
        progress.notes.push(
          `took free pool ${noun} ${text(spare, 'name')} (${text(spare, 'device_type_name')}, ${text(spare, 'runtime_name')}) though ${spec.deviceTypeName}, ${spec.runtimeName} was asked for: the pool is full, and a device type is a preference unless the lane is strict`,
        );
        return { kind: 'assign', name: text(spare, 'name') };
      }
      if (room > 0 || spare) {
        if (!mine) return this.reserve(spec, backend, listed, me, now);
        if (depth > 0) return { kind: 'reserved' };
        if (room === 0 && spare) {
          const retired = text(spare, 'device_id');
          backend.delete(retired);
          listed.delete(retired);
          db.prepare('DELETE FROM devices WHERE name = ?').run(text(spare, 'name'));
          progress.notes.push(
            `replaced unclaimed pool ${noun} ${text(spare, 'name')} (${text(spare, 'device_type_name')}, ${text(spare, 'runtime_name')}): the lane is strict and needs ${spec.deviceTypeName}, ${spec.runtimeName}`,
          );
          this.step('claim:retired-device');
        }
        const name = text(mine, 'name');
        const id = backend.create(name, spec);
        this.step('claim:created-device');
        db.prepare('UPDATE devices SET device_id = ?, creator_pid = NULL, creator_start = NULL WHERE name = ?').run(id, name);
        listed.set(id, { id, name, deviceType: spec.deviceType, runtime: spec.runtime, booted: false });
        progress.notes.push(`created pool ${noun} ${name} (${spec.deviceTypeName}, ${spec.runtimeName}, ${id})`);
        return { kind: 'assign', name };
      }
    }
    if (depth === 0) {
      const deviceSlot = free.length + room > 0;
      const idle = this.idleLanes(now, caller, verdicts).find(row => {
        const device = db.prepare('SELECT platform FROM devices WHERE claim_id = ?').get(text(row, 'id'));
        if (!device) return false;
        const theirs = text(device, 'platform') as Platform;
        if (theirs === platform) return true;
        return deviceSlot && spareMemory + DEVICE_MEMORY_MB[theirs] >= DEVICE_MEMORY_MB[platform];
      });
      if (idle) {
        progress.tookOver.push(this.end(idle, 'taken-over', caller, now));
        this.step('claim:took-over');
        return this.planDevice(spec, strict, backend, listed, me, verdicts, now, caller, progress, depth + 1);
      }
    }
    return wait();
  }

  private reserve(
    spec: DeviceSpec,
    backend: DeviceBackend,
    listed: Map<string, BackendDevice>,
    me: ProcessIdentity,
    now: number,
  ): DevicePlan {
    const db = this.store.db;
    const taken = new Set([...listed.values()].map(d => d.name));
    let name: string;
    do {
      name = `${diskNames(this.dir).pool[backend.platform]}${randomBytes(3).toString('hex')}`;
    } while (taken.has(name) || db.prepare('SELECT 1 FROM devices WHERE name = ?').get(name));
    db.prepare(
      `INSERT INTO devices (name, platform, device_id, device_type, device_type_name, runtime, runtime_name,
         creator_pid, creator_start, claim_id, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(name, backend.platform, spec.deviceType, spec.deviceTypeName, spec.runtime, spec.runtimeName, me.pid, me.start, now);
    this.step('claim:reserved');
    return { kind: 'reserved' };
  }

  private end(row: Row, reason: EndReason, by: Caller, now: number): EndedLane {
    const db = this.store.db;
    const id = text(row, 'id');
    const device = db.prepare('SELECT name FROM devices WHERE claim_id = ?').get(id);
    const processes = db
      .prepare('SELECT * FROM processes WHERE claim_id = ? ORDER BY service')
      .all(id)
      .map(p => ({ service: text(p, 'service'), pid: int(p, 'pid'), start: text(p, 'start'), cwd: optText(p, 'cwd') }));
    const ended: EndedLane = {
      id,
      owner: describeOwner(ownerFromRow(row)),
      worktree: text(row, 'worktree'),
      device: device ? text(device, 'name') : null,
      reason,
      createdAt: int(row, 'created_at'),
      lastUsedAt: int(row, 'last_used_at'),
      lastAction: text(row, 'last_action'),
      endedAt: now,
      by: by.label,
      ...(processes.length > 0 ? { processes } : {}),
    };
    db.prepare(
      `INSERT INTO history (claim_id, owner_key, owner_label, worktree, device, reason, created_at, last_used_at, last_action,
         by_owner_key, by_label, by_worktree, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      text(row, 'owner_key'),
      ended.owner,
      ended.worktree,
      ended.device,
      reason,
      ended.createdAt,
      ended.lastUsedAt,
      ended.lastAction,
      by.key,
      by.label,
      by.worktree,
      now,
    );
    db.prepare('DELETE FROM claims WHERE id = ?').run(id);
    return ended;
  }

  private endAndShutDown(rows: readonly Row[], reason: EndReason, by: Caller, notes: string[]): EndedLane[] {
    const db = this.store.db;
    const now = this.clock.now();
    return rows.map(row => {
      const device = db.prepare('SELECT * FROM devices WHERE claim_id = ?').get(text(row, 'id'));
      const ended = this.end(row, reason, by, now);
      this.step('release:ended');
      const backend = device ? this.backends[text(device, 'platform') as Platform] : undefined;
      if (device && backend) {
        try {
          backend.shutdown(text(device, 'device_id'));
        } catch (error) {
          notes.push(`could not shut down ${text(device, 'name')}: ${(error as Error).message}`);
        }
      }
      return ended;
    });
  }

  private holderOf(row: Row, now: number): Holder {
    return {
      who: describeOwner(ownerFromRow(row)),
      folder: text(row, 'worktree'),
      since: formatTime(int(row, 'created_at')),
      detail: `lane ${text(row, 'id')}, last used ${formatAge(now - int(row, 'last_used_at'))} ago (${text(row, 'last_action')})`,
    };
  }

  private poolHolders(now: number, ticket: number): Holder[] {
    const db = this.store.db;
    const holders: Holder[] = [];
    const claimed = db
      .prepare(
        'SELECT c.*, d.name AS device_name, d.platform AS device_platform FROM claims c JOIN devices d ON d.claim_id = c.id ORDER BY c.created_at',
      )
      .all();
    for (const row of claimed) {
      const holder = this.holderOf(row, now);
      holders.push({ ...holder, detail: `${text(row, 'device_name')}, ${holder.detail ?? ''}` });
    }
    for (const row of db.prepare('SELECT * FROM devices WHERE device_id IS NULL').all()) {
      holders.push({
        who: `a process claiming a lane (pid ${String(int(row, 'creator_pid'))})`,
        folder: `(creating ${text(row, 'platform') === 'android' ? 'an emulator' : 'a simulator'})`,
        since: formatTime(int(row, 'created_at')),
        detail: text(row, 'name'),
      });
    }
    for (const row of db.prepare('SELECT * FROM queue WHERE ticket < ? ORDER BY ticket').all(ticket)) {
      holders.push({
        who: `${text(row, 'owner_label')}, queued ahead of you`,
        folder: text(row, 'worktree'),
        since: formatTime(int(row, 'enqueued_at')),
      });
    }
    return holders;
  }

  private poolBusy(wait: Wait, request: LaneRequest): Refusal {
    const waited = request.waitMs > 0 ? `waited ${formatAge(request.waitMs)} in the queue` : 'did not wait (--timeout 0)';
    const named =
      wait.holders.length > 0
        ? wait.holders
        : [{ who: 'no lane the registry can see', folder: this.dir, since: formatTime(this.clock.now()) }];
    const cap = wait.platform === 'ios' ? 'poolSize' : 'emulatorPoolSize';
    return new Refusal(
      'pool-busy',
      `no pool ${NOUN[wait.platform]} is free and none can be reclaimed (${wait.pool}); ${waited}`,
      named,
      [
        `${CLI} claim --timeout 1800   (wait up to 30 minutes for a slot)`,
        `${CLI} release   (run by a holder's session, in its folder)`,
        `set "${cap}": ${String(poolCap(this.config, wait.platform) + 1)} or "memoryBudgetGB": ${String(Math.ceil((this.config.memoryBudgetMb + DEVICE_MEMORY_MB[wait.platform]) / 1000))} in ${configPath(this.dir)}   (allow one more ${NOUN[wait.platform]})`,
      ],
    );
  }

  private portsExhausted(type: string, held: Map<number, string>, listening: ReadonlySet<number>, now: number): Refusal {
    const db = this.store.db;
    const block = this.config.blocks[type];
    const holders: Holder[] = [];
    const rows: Row[] = [];
    const foreign: number[] = [];
    for (let p = block?.first ?? 0; block && p <= block.last; p++) {
      const id = held.get(p);
      if (id === undefined) {
        if (listening.has(p)) foreign.push(p);
        continue;
      }
      if (rows.some(r => text(r, 'id') === id)) continue;
      const row = db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
      if (row) rows.push(row);
    }
    rows.sort((a, b) => int(a, 'last_used_at') - int(b, 'last_used_at'));
    for (const row of rows) holders.push(this.holderOf(row, now));
    if (foreign.length > 0) {
      holders.push({
        who: `processes the registry did not start, listening on ${foreign.join(', ')}`,
        folder: '(unknown)',
        since: '(unknown)',
        detail: `lsof -nP -iTCP:${String(foreign[0])} -sTCP:LISTEN names them`,
      });
    }
    const range = block ? `${String(block.first)}-${String(block.last)}` : '';
    const mostIdle = rows[0];
    return new Refusal(
      'ports-exhausted',
      `no free ${type} port in ${range}`,
      holders.length > 0 ? holders : [{ who: 'no lane the registry can see', folder: this.dir, since: formatTime(now) }],
      [
        mostIdle
          ? `${CLI} release   (run by the session holding lane ${text(mostIdle, 'id')}, in ${text(mostIdle, 'worktree')})`
          : `${CLI} status`,
        `set "ports": {"${type}": [first, last]} in ${configPath(this.dir)}   (a wider block)`,
      ],
    );
  }

  private laneGone(id: string): Refusal {
    const row = this.store.db.prepare('SELECT * FROM history WHERE claim_id = ? ORDER BY seq DESC LIMIT 1').get(id);
    const recovery = [`${CLI} claim   (a new lane for this session and folder)`];
    if (!row) {
      return new Refusal(
        'lane-gone',
        `lane ${id} does not exist`,
        [{ who: 'nobody', folder: '(no record)', since: '(no record)', detail: `the registry has no record of lane ${id}` }],
        recovery,
      );
    }
    const reason = text(row, 'reason') as EndReason;
    const when = formatTime(int(row, 'ended_at'));
    let detail: string;
    if (reason === 'taken-over') detail = `took it over after it sat idle since ${formatTime(int(row, 'last_used_at'))}`;
    else if (reason === 'released' || reason === 'forced') detail = `${reason} it`;
    else detail = `freed it: ${describeState(reason)}`;
    return new Refusal(
      'lane-gone',
      `lane ${id} has ended`,
      [{ who: text(row, 'by_label'), folder: text(row, 'by_worktree'), since: when, detail }],
      recovery,
    );
  }

  private requireLane(ref: LaneRef): Row {
    const row = this.store.db.prepare('SELECT * FROM claims WHERE id = ?').get(ref.id);
    if (!row) throw this.laneGone(ref.id);
    if (text(row, 'token') !== ref.token) {
      throw new Refusal(
        'token-mismatch',
        `the token given for lane ${ref.id} is not its token`,
        [this.holderOf(row, this.clock.now())],
        [`${CLI} claim   (run by the owning session in ${text(row, 'worktree')}; it prints the lane's token)`],
      );
    }
    return row;
  }

  find(owner: Owner, worktree: string): Lane | null {
    const row = this.store.db
      .prepare('SELECT id FROM claims WHERE owner_key = ? AND worktree = ?')
      .get(ownerKey(owner), worktree);
    return row ? loadLane(this.store.db, text(row, 'id')) : null;
  }

  release(ref: LaneRef, by: Owner, notes: string[] = []): EndedLane {
    const caller = this.caller(by, '');
    const [ended] = this.store.write(() => {
      this.step('release:locked');
      const row = this.requireLane(ref);
      caller.worktree = text(row, 'worktree');
      return this.endAndShutDown([row], 'released', caller, notes);
    });
    this.step('release:committed');
    if (!ended) throw new Error(`releasing lane ${ref.id} ended nothing`);
    return ended;
  }

  releaseOwn(owner: Owner, worktree: string | null, notes: string[] = []): EndedLane[] {
    const caller = this.caller(owner, worktree ?? '');
    const ended = this.store.write(() => {
      this.step('release:locked');
      const db = this.store.db;
      const rows =
        worktree === null
          ? db.prepare('SELECT * FROM claims WHERE owner_key = ? ORDER BY created_at').all(caller.key)
          : db.prepare('SELECT * FROM claims WHERE owner_key = ? AND worktree = ?').all(caller.key, worktree);
      return this.endAndShutDown(rows, 'released', caller, notes);
    });
    this.step('release:committed');
    return ended;
  }

  releaseById(id: string, by: Owner, force: boolean, notes: string[] = []): EndedLane {
    const caller = this.caller(by, '');
    const verdicts = this.snapshotBeforeLock();
    const [ended] = this.store.write(() => {
      this.step('release:locked');
      const row = this.store.db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
      if (!row) throw this.laneGone(id);
      caller.worktree = text(row, 'worktree');
      if (text(row, 'owner_key') === caller.key) return this.endAndShutDown([row], 'released', caller, notes);
      const state = ownerState(this.verdictFor(row, verdicts), worktreeState(text(row, 'worktree')));
      if (isProven(state)) return this.endAndShutDown([row], state, caller, notes);
      if (force) return this.endAndShutDown([row], 'forced', caller, notes);
      const now = this.clock.now();
      const forced = `${CLI} release --lane ${id} --force`;
      if (state === 'cant-tell') {
        throw new Refusal(
          'owner-unknown',
          `lane ${id} belongs to an owner the registry can't tell is alive or not, so it won't free it on its own`,
          [this.holderOf(row, now)],
          [`${forced}   (if you know that session is finished)`, `${CLI} status   (every lane with its owner)`],
        );
      }
      throw new Refusal(
        'held-by-live-owner',
        `lane ${id} belongs to a session that is still running`,
        [this.holderOf(row, now)],
        [
          `${CLI} release   (run by that session, in ${text(row, 'worktree')})`,
          `${forced}   (only if you know that session no longer needs it)`,
        ],
      );
    });
    this.step('release:committed');
    if (!ended) throw new Error(`releasing lane ${id} ended nothing`);
    return ended;
  }

  touch(ref: LaneRef, action: string): Lane {
    return this.store.write(() => {
      this.step('touch:locked');
      this.requireLane(ref);
      this.store.db
        .prepare('UPDATE claims SET last_used_at = ?, last_action = ? WHERE id = ?')
        .run(this.clock.now(), action, ref.id);
      const lane = loadLane(this.store.db, ref.id);
      if (!lane) throw new Error(`lane ${ref.id} vanished inside its own transaction`);
      return lane;
    });
  }

  touchOwn(owner: Owner, worktree: string, action: string): Lane {
    this.caller(owner, worktree);
    const lane = this.find(owner, worktree);
    if (!lane)
      throw new NotClaimed(`${describeOwner(owner)} holds no lane in ${worktree}`, `${CLI} claim   (run in ${worktree})`);
    return this.touch({ id: lane.id, token: lane.token }, action);
  }

  recordProcess(ref: LaneRef, proc: ServiceProcess): void {
    this.store.write(() => {
      this.requireLane(ref);
      this.store.db
        .prepare('INSERT OR REPLACE INTO processes (claim_id, service, pid, start, cwd) VALUES (?, ?, ?, ?, ?)')
        .run(ref.id, proc.service, proc.pid, proc.start, proc.cwd);
    });
  }

  forgetProcess(ref: LaneRef, service: string): void {
    this.store.write(() => {
      this.requireLane(ref);
      this.store.db.prepare('DELETE FROM processes WHERE claim_id = ? AND service = ?').run(ref.id, service);
    });
  }

  /** Records what the resource's teardown needs before its create runs; `kept` when this lane already has it. */
  startResource(ref: LaneRef, spec: ResourceSpec): ResourceStart {
    const holders = holdersBeforeLock(this.store.db, this.processes);
    return this.store.write(() => {
      const row = this.requireLane(ref);
      return startResource(
        this.store.db,
        { id: ref.id, worktree: text(row, 'worktree') },
        spec,
        this.self(),
        holders,
        this.clock.now(),
      );
    });
  }

  finishResource(lane: string, name: string, exports: ResourceValues): void {
    this.store.write(() => {
      finishResource(this.store.db, lane, name, exports, this.self());
    });
  }

  failResource(lane: string, name: string, problem: string): void {
    this.store.write(() => {
      failResource(this.store.db, lane, name, problem, this.self());
    });
  }

  /** Leases the resources of ended lanes to this process for teardown, last created first. */
  takeTeardowns(choice: TeardownChoice = {}): ResourceTeardown[] {
    const holders = holdersBeforeLock(this.store.db, this.processes);
    return this.store.write(() => takeTeardowns(this.store.db, this.self(), holders, this.clock.now(), choice));
  }

  finishTeardown(lane: string, name: string): void {
    this.store.write(() => {
      endTeardown(this.store.db, lane, name, this.self());
    });
  }

  failTeardown(lane: string, name: string, problem: string): void {
    this.store.write(() => {
      failTeardown(this.store.db, lane, name, problem, this.self(), this.clock.now());
    });
  }

  /** The browsers of lanes that have ended, however they ended: their processes may still run. */
  endedBrowsers(): EndedBrowser[] {
    return this.store.db
      .prepare('SELECT * FROM browsers b WHERE NOT EXISTS (SELECT 1 FROM claims c WHERE c.id = b.claim_id) ORDER BY created_at')
      .all()
      .map(row => ({
        lane: text(row, 'claim_id'),
        driver: text(row, 'driver') as EndedBrowser['driver'],
        session: text(row, 'session'),
        worktree: text(row, 'worktree'),
        createdAt: int(row, 'created_at'),
      }));
  }

  /** Forgets an ended lane's browser once nothing of it runs; a live lane's browser is never forgotten. */
  forgetBrowser(lane: string): void {
    this.store.write(() => {
      this.store.db
        .prepare('DELETE FROM browsers WHERE claim_id = ? AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.id = ?)')
        .run(lane, lane);
    });
  }

  pendingTeardowns(): PendingTeardown[] {
    return pendingTeardowns(this.store.db);
  }

  prunable(): PruneListing {
    return listPrunable(this.store, this.dir, this.backends);
  }

  pruneDevice(device: FreePoolDevice): PruneResult {
    return this.store.write(() => deletePoolDevice(this.store.db, this.backends[device.platform], device));
  }

  status(): StatusReport {
    return readStatus(this.store, {
      dir: this.dir,
      config: this.config,
      processes: this.processes,
      devices: this.backends,
      clock: this.clock,
    });
  }
}

export function browserSession(laneId: string): string {
  return `${TOOL}-${laneId}`;
}

function browserServices(request: LaneRequest): ServiceRequest[] {
  if (!request.browser) return [];
  const debug = { name: BROWSER_DEBUG_SERVICE, type: BROWSER_PORT_TYPE };
  return request.browser.driver === 'agent-browser'
    ? [debug, { name: BROWSER_STREAM_SERVICE, type: BROWSER_PORT_TYPE }]
    : [debug];
}

export function readRegistryStatus(options: Omit<RegistryOptions, 'ports'>): StatusReport {
  const config = options.config ?? loadConfig(options.dir);
  const store = Store.openExisting(options.dir, options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS);
  try {
    return readStatus(store, {
      dir: options.dir,
      config,
      processes: options.processes,
      devices: options.devices ?? {},
      clock: options.clock ?? systemClock,
    });
  } finally {
    store?.close();
  }
}
