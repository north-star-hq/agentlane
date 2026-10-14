import fs from 'node:fs';
import path from 'node:path';
import { playwrightControl, type BrowserControl, type DriverRun, type PageRead } from '../../src/browser/control.ts';
import type { Ran } from '../../src/driver/exec.ts';
import type { InstalledDriver, InstallState } from '../../src/browser/install.ts';
import type { BrowserDriverName } from '../../src/browser/kinds.ts';
import type { StoredCookie } from '../../src/browser/signin.ts';
import type { BrowserProcessSystem, ProcessEntry } from '../../src/browser/stop.ts';
import { probeUrl, type BrowserTools } from '../../src/browser/tools.ts';
import type { AriaNode } from '../../src/browser/aria.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

/** One browser the fake runs: what the driver's session was started with, read from the driver's environment. */
export interface FakeSession {
  driver: BrowserDriverName;
  session: string;
  profile: string;
  port: number;
  url: string;
  cookies: StoredCookie[];
  tracing: boolean;
  video: string | null;
  daemonPid: number;
  browserPid: number;
  helperPid: number;
  env: NodeJS.ProcessEnv;
}

function node(role: string, name: string, ref: string | null, attributes: Record<string, string | true> = {}): AriaNode {
  return { role, name, ref, attributes, text: null, props: {}, children: [] };
}

function tag(html: string, name: string): string | null {
  return new RegExp(`<${name}[^>]*>([^<]*)</${name}>`).exec(html)?.[1] ?? null;
}

function debugPortOf(driver: BrowserDriverName, env: NodeJS.ProcessEnv): number {
  if (driver === 'agent-browser') return Number(/--remote-debugging-port=(\d+)/.exec(env.AGENT_BROWSER_ARGS ?? '')?.[1]);
  const file = path.join(env.PWTEST_CLI_GLOBAL_CONFIG ?? '', '.playwright', 'cli.config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { browser?: { launchOptions?: { args?: string[] } } };
  const flag = config.browser?.launchOptions?.args?.find(a => a.startsWith('--remote-debugging-port='));
  return Number(flag?.split('=')[1]);
}

/**
 * The machine's browsers as the toolkit sees them, faked: each driver session starts a daemon, a browser on the profile
 * and port its environment names, and a helper, in a fake process table. Pages are fetched from the real server with
 * the session's cookies, so a sign-in reaches the fixture site for real.
 */
export class FakeBrowser implements BrowserTools {
  readonly sessions = new Map<string, FakeSession>();
  private readonly socketDirs = new Set<string>();
  readonly installs: BrowserDriverName[] = [];
  readonly calls: string[] = [];
  readonly table: ProcessEntry[] = [];
  readonly environments = new Map<number, string>();
  installKind: Partial<Record<BrowserDriverName, InstallState['kind']>> = {};
  /**
   * Drive playwright sessions through the toolkit's own playwright-cli control, over a fake playwright-cli that answers
   * as 1.64's does, rather than through a fake control.
   */
  playwrightCli = false;
  /** playwright-cli commands that fail, as a command the browser can't carry out does. */
  readonly failing = new Set<string>();
  /** Processes that ignore SIGTERM. */
  readonly stubborn = new Set<number>();
  /** The system libraries the browsers lack, as a Linux machine reports them; null as off Linux, where none are checked. */
  libraries: string[] | null = null;
  private nextPid = 7_000_000;
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  installed(driver: BrowserDriverName): InstalledDriver {
    const dir = path.join(this.root, 'browsers');
    return {
      driver,
      version: driver === 'playwright' ? '1.64.0' : '0.39.0',
      cli: ['/bin/false'],
      playwrightCore: path.join(dir, 'playwright-core'),
      browsersPath: dir,
      chrome: path.join(dir, 'chrome'),
      headlessShell: path.join(dir, 'chrome-headless-shell'),
      ffmpeg: '',
      overridden: false,
    };
  }

  /** Removes the socket folders its agent-browser sessions made, which can sit outside the test's root, in the per-user temp. */
  removeSocketDirs(): void {
    for (const dir of this.socketDirs) if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
  }

  missingLibraries(): Promise<string[] | null> {
    return Promise.resolve(this.libraries);
  }

  install(driver: BrowserDriverName): Promise<InstalledDriver> {
    this.installs.push(driver);
    return Promise.resolve(this.installed(driver));
  }

  state(driver: BrowserDriverName): InstallState {
    const kind = this.installKind[driver] ?? 'installed';
    if (kind === 'installed') return { kind, driver: this.installed(driver) };
    return kind === 'missing'
      ? { kind, what: `no ${driver} in ${this.root}` }
      : { kind, what: `${driver} 1.63.0 is installed where 1.64.0 is pinned` };
  }

  control(driver: BrowserDriverName, shim: string, env: NodeJS.ProcessEnv, cwd: string): BrowserControl {
    const fake = new FakeControl(this, driver, shim, env);
    return driver === 'playwright' && this.playwrightCli ? playwrightControl(playwrightCli(this, fake, env, cwd), cwd) : fake;
  }

  readonly processes: BrowserProcessSystem = {
    list: () => this.table.map(e => ({ ...e })),
    environment: pid => this.environments.get(pid),
    signal: (pid, signal) => {
      this.calls.push(`signal ${String(pid)} ${signal}`);
      if (signal === 'SIGTERM' && this.stubborn.has(pid)) return;
      this.remove(pid);
    },
  };

  /** A browser's debugging port answers as Chrome does; any other URL is fetched for real. */
  probe(url: string): Promise<{ status: number; body: string } | null> {
    const port = Number(new URL(url).port);
    const session = [...this.sessions.values()].find(s => s.port === port);
    if (session) return Promise.resolve({ status: 200, body: JSON.stringify({ Browser: 'Chrome/148.0.0.0' }) });
    return probeUrl(url);
  }

  listeners(port: number): number[] {
    return [...this.sessions.values()].filter(s => s.port === port).map(s => s.browserPid);
  }

  pid(): number {
    this.nextPid += 1;
    return this.nextPid;
  }

  add(entry: ProcessEntry, environment?: string): void {
    this.table.push(entry);
    if (environment !== undefined) this.environments.set(entry.pid, environment);
  }

  remove(pid: number): void {
    const at = this.table.findIndex(e => e.pid === pid);
    if (at !== -1) this.table.splice(at, 1);
    for (const [name, session] of this.sessions) {
      if (session.browserPid === pid || session.daemonPid === pid) this.sessions.delete(name);
    }
  }

  start(driver: BrowserDriverName, env: NodeJS.ProcessEnv): FakeSession {
    const session = driver === 'playwright' ? env.PLAYWRIGHT_CLI_SESSION : env.AGENT_BROWSER_SESSION;
    const profile = driver === 'playwright' ? env.PLAYWRIGHT_MCP_USER_DATA_DIR : env.AGENT_BROWSER_PROFILE;
    if (!session || !profile) throw new Error(`the ${driver} environment names no session or profile`);
    const port = debugPortOf(driver, env);
    for (const other of this.sessions.values()) {
      if (other.profile === profile) throw new Error(`profile ${profile} is in use by session ${other.session}`);
      if (other.port === port) throw new Error(`port ${String(port)} is in use by session ${other.session}`);
    }
    fs.mkdirSync(profile, { recursive: true });
    const daemonPid = this.pid();
    const browserPid = this.pid();
    const helperPid = this.pid();
    if (driver === 'playwright') {
      this.add({ pid: daemonPid, ppid: 1, pgid: daemonPid, args: `node /pw/lib/cliDaemon.js ${session}` });
    } else {
      this.add(
        { pid: daemonPid, ppid: 1, pgid: daemonPid, args: '/ab/bin/agent-browser-darwin-arm64' },
        `AGENT_BROWSER_DAEMON=1 AGENT_BROWSER_SESSION=${session} AGENT_BROWSER_SOCKET_DIR=${env.AGENT_BROWSER_SOCKET_DIR ?? ''}`,
      );
      fs.mkdirSync(env.AGENT_BROWSER_SOCKET_DIR ?? '', { recursive: true });
      this.socketDirs.add(env.AGENT_BROWSER_SOCKET_DIR ?? '');
      fs.writeFileSync(path.join(env.AGENT_BROWSER_SOCKET_DIR ?? '', `${session}.pid`), String(daemonPid));
    }
    this.add({
      pid: browserPid,
      ppid: daemonPid,
      pgid: daemonPid,
      args: `/browsers/chrome --user-data-dir=${profile} --remote-debugging-port=${String(port)}`,
    });
    this.add({ pid: helperPid, ppid: browserPid, pgid: daemonPid, args: '/browsers/chrome --type=renderer' });
    const started: FakeSession = {
      driver,
      session,
      profile,
      port,
      url: 'about:blank',
      cookies: [],
      tracing: false,
      video: null,
      daemonPid,
      browserPid,
      helperPid,
      env,
    };
    this.sessions.set(session, started);
    return started;
  }
}

class FakeControl implements BrowserControl {
  readonly driver: BrowserDriverName;
  readonly tracesActions: boolean;
  private readonly fake: FakeBrowser;
  private readonly env: NodeJS.ProcessEnv;
  private traces = 0;

  constructor(fake: FakeBrowser, driver: BrowserDriverName, shim: string, env: NodeJS.ProcessEnv) {
    this.fake = fake;
    this.driver = driver;
    this.tracesActions = driver === 'playwright';
    this.env = env;
    if (!fs.existsSync(shim)) throw new Error(`no driver wrapper at ${shim}`);
  }

  private name(): string {
    return (this.driver === 'playwright' ? this.env.PLAYWRIGHT_CLI_SESSION : this.env.AGENT_BROWSER_SESSION) ?? '';
  }

  private session(): FakeSession {
    const found = this.fake.sessions.get(this.name());
    if (!found) throw new Error(`no ${this.driver} session ${this.name()} is open`);
    return found;
  }

  private log(call: string): void {
    this.fake.calls.push(`${this.name()} ${call}`);
  }

  isOpen(): Promise<boolean> {
    return Promise.resolve(this.fake.sessions.has(this.name()));
  }

  open(url: string): Promise<void> {
    this.log(`open ${url}`);
    const session = this.fake.sessions.get(this.name()) ?? this.fake.start(this.driver, this.env);
    session.url = url;
    return Promise.resolve();
  }

  loadState(file: string): Promise<void> {
    this.log(`load ${path.basename(file)}`);
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as { cookies: StoredCookie[] };
    this.session().cookies = state.cookies;
    return Promise.resolve();
  }

  async read(): Promise<PageRead> {
    const session = this.session();
    const url = new URL(session.url);
    const cookie = session.cookies
      .filter(c => c.domain.replace(/^\./, '') === url.hostname)
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
    const html = await (await fetch(url, { headers: cookie ? { cookie } : {} })).text();
    const title = tag(html, 'title') ?? '';
    const tree: AriaNode[] = [node('heading', tag(html, 'h1') ?? '', 'e1', { level: '1' })];
    const served = tag(html, 'p');
    if (served !== null) tree.push(node('paragraph', served, null));
    if (html.includes('<form')) tree.push(node('textbox', 'User', 'e2'), node('button', 'Sign in', 'e3'));
    return { url: session.url, title, tree };
  }

  screenshot(file: string): Promise<void> {
    this.session();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, PNG);
    return Promise.resolve();
  }

  traceStart(): Promise<void> {
    this.log('trace start');
    this.session().tracing = true;
    return Promise.resolve();
  }

  traceStop(into: string): Promise<string[]> {
    this.log('trace stop');
    const session = this.session();
    if (!session.tracing) throw new Error('no trace runs');
    session.tracing = false;
    this.traces += 1;
    fs.mkdirSync(into, { recursive: true });
    const file = path.join(into, `trace-${String(this.traces)}.trace`);
    fs.writeFileSync(file, `trace of ${session.session}\n`);
    return Promise.resolve([file]);
  }

  videoStart(file: string): Promise<void> {
    this.session().video = file;
    return Promise.resolve();
  }

  videoStop(): Promise<void> {
    const session = this.session();
    if (session.video !== null) fs.writeFileSync(session.video, 'webm');
    session.video = null;
    return Promise.resolve();
  }

  console(): Promise<string> {
    return Promise.resolve(`[log] ${this.session().url}\n`);
  }

  close(): Promise<void> {
    this.log('close');
    const session = this.session();
    for (const pid of [session.helperPid, session.browserPid, session.daemonPid]) this.fake.remove(pid);
    return Promise.resolve();
  }
}

/** playwright-cli 1.64 as the toolkit calls it: its markdown answers, its exit codes and its one trace per session. */
function playwrightCli(fake: FakeBrowser, control: FakeControl, env: NodeJS.ProcessEnv, cwd: string): DriverRun {
  const session = env.PLAYWRIGHT_CLI_SESSION ?? '';
  const output = env.PLAYWRIGHT_MCP_OUTPUT_DIR ?? path.join(cwd, 'output');
  let traces = 0;
  const answer = (code: number, stdout: string): Ran => ({ code, stdout, stderr: '', signal: null, error: undefined });
  const error = (text: string): Ran => answer(1, `### Error\nError: ${text}\n`);
  return async args => {
    const [command = '', arg = ''] = args;
    fake.calls.push(`${session} playwright-cli ${args.join(' ')}`);
    if (fake.failing.has(command)) return error(`${command} failed: Target page, context or browser has been closed`);
    const open = fake.sessions.get(session);
    switch (command) {
      case '--json':
        return answer(0, JSON.stringify({ browsers: open ? [{ name: session, status: 'open' }] : [] }));
      case 'open':
      case 'goto':
        await control.open(arg);
        return answer(0, `### Page\n- Page URL: ${arg}\n`);
      case 'state-load':
        await control.loadState(arg);
        return answer(0, '### Result\nState loaded.\n');
      case 'tracing-start':
        if (!open) return error('The browser is not open');
        if (open.tracing) return error('Tracing has already been started.');
        open.tracing = true;
        return answer(0, '### Result\nTrace recording started.\n');
      case 'tracing-stop': {
        if (!open?.tracing) return error('Tracing is not started');
        open.tracing = false;
        traces += 1;
        const file = path.join(output, 'traces', `trace-${String(traces)}.trace`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `trace of ${session}\n`);
        return answer(0, `### Result\nTrace recording stopped.\n- [Trace](${path.relative(cwd, file)})\n`);
      }
      case 'close-all':
      case 'close':
        if (open) await control.close();
        return answer(0, '### Result\nClosed.\n');
      default:
        return error(`unknown command ${command}`);
    }
  };
}
