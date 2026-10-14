import fs from 'node:fs';
import path from 'node:path';
import { DriverError } from '../driver/errors.ts';
import { runCommand, tail, type Ran } from '../driver/exec.ts';
import { CLI } from '../name.ts';
import { parseAriaSnapshot, type AriaNode } from './aria.ts';
import type { BrowserDriverName } from './kinds.ts';

/** Runs the lane's driver CLI with the lane's variables. */
export type DriverRun = (args: readonly string[], timeoutMs?: number) => Promise<Ran>;

export interface PageRead {
  url: string;
  title: string;
  tree: AriaNode[];
}

/** What the toolkit asks of a lane's browser, through the driver's own CLI. */
export interface BrowserControl {
  readonly driver: BrowserDriverName;
  isOpen(): Promise<boolean>;
  /** Navigates the lane's browser, starting it with the lane's profile when it isn't running. */
  open(url: string): Promise<void>;
  loadState(file: string): Promise<void>;
  read(): Promise<PageRead>;
  screenshot(file: string): Promise<void>;
  /** False when the driver keeps no trace of its own actions. */
  readonly tracesActions: boolean;
  /** Starts a new trace of the driver's actions, ending the one that runs. */
  traceStart(): Promise<void>;
  /** Stops the trace and copies what it wrote into `into`, returning the files kept. */
  traceStop(into: string): Promise<string[]>;
  videoStart(file: string): Promise<void>;
  videoStop(): Promise<void>;
  console(): Promise<string>;
  close(): Promise<void>;
}

const CALL_MS = 60_000;

function failed(driver: string, args: readonly string[], ran: Ran): DriverError {
  const said = tail(`${ran.stdout}\n${ran.stderr}`.trim(), 8);
  return new DriverError(
    `${driver} ${args.join(' ')} ${ran.error ?? `exited ${String(ran.code)}`}${said ? `:\n${said}` : ''}`,
    `${CLI} doctor names what is wrong with the lane's browser or its web app; when it reports ready, close the browser with ${CLI} exec -- ${driver} close, and ${CLI} up opens a new one`,
  );
}

async function ok(driver: string, run: DriverRun, args: readonly string[], timeoutMs = CALL_MS): Promise<Ran> {
  const ran = await run(args, timeoutMs);
  if (ran.code !== 0 || ran.error !== undefined) throw failed(driver, args, ran);
  return ran;
}

function yamlBlock(text: string): string {
  const match = /```yaml\n([\s\S]*?)```/.exec(text);
  return match?.[1] ?? '';
}

function pageField(text: string, field: string): string {
  return new RegExp(`^- Page ${field}: (.*)$`, 'm').exec(text)?.[1]?.trim() ?? '';
}

/** Paths the driver lists as markdown links: `- [Trace](out/traces/x.trace)`, relative to where it ran. */
function linkedFiles(text: string, base: string): string[] {
  return [...text.matchAll(/\]\(([^)]+)\)/g)].flatMap(m => (m[1] ? [path.resolve(base, m[1])] : []));
}

function copyInto(files: readonly string[], into: string): string[] {
  fs.mkdirSync(into, { recursive: true, mode: 0o700 });
  const kept: string[] = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const target = path.join(into, path.basename(file));
    fs.cpSync(file, target, { recursive: true });
    kept.push(target);
  }
  return kept;
}

/**
 * What a live Playwright trace names beside it that tracing-stop doesn't list: its `.stacks` file and the screencast
 * frames it records as `"file":"screencast/<frame>.jpeg"`, relative to the trace's folder.
 */
function traceCompanions(trace: string): string[] {
  const dir = path.dirname(trace);
  const named = new Set([path.basename(trace).replace(/\.trace$/, '.stacks')]);
  const text = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '';
  for (const match of text.matchAll(/"file":"(screencast\/[^"/]+)"/g)) if (match[1]) named.add(match[1]);
  return [...named].map(name => path.join(dir, name));
}

function copyCompanions(traces: readonly string[], into: string): string[] {
  const kept: string[] = [];
  for (const trace of traces) {
    const dir = path.dirname(trace);
    for (const file of traceCompanions(trace)) {
      if (!fs.existsSync(file)) continue;
      const target = path.join(into, path.relative(dir, file));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(file, target);
      kept.push(target);
    }
  }
  return kept;
}

/** playwright-cli 1.64 keeps one trace per session, and refuses a second `tracing-start` with this. */
const TRACE_RUNS = 'Tracing has already been started';

export function playwrightControl(run: DriverRun, cwd: string): BrowserControl {
  const call = (args: readonly string[], timeoutMs?: number) => ok('playwright-cli', run, args, timeoutMs);
  return {
    driver: 'playwright',
    tracesActions: true,
    async isOpen() {
      const ran = await run(['--json', 'list'], CALL_MS);
      if (ran.code !== 0) return false;
      try {
        const listed = JSON.parse(ran.stdout) as { browsers?: { name?: string; status?: string }[] };
        return (listed.browsers ?? []).some(b => b.status === 'open');
      } catch {
        return false;
      }
    },
    async open(url) {
      if (await this.isOpen()) await call(['goto', url]);
      else await call(['open', url], 120_000);
    },
    async loadState(file) {
      await call(['state-load', file]);
    },
    async read() {
      const ran = await call(['snapshot']);
      return {
        url: pageField(ran.stdout, 'URL'),
        title: pageField(ran.stdout, 'Title'),
        tree: parseAriaSnapshot(yamlBlock(ran.stdout)),
      };
    },
    async screenshot(file) {
      await call(['screenshot', `--filename=${file}`]);
    },
    async traceStart() {
      const ran = await run(['tracing-start'], CALL_MS);
      if (ran.code === 0 && ran.error === undefined) return;
      if (!`${ran.stdout}\n${ran.stderr}`.includes(TRACE_RUNS)) throw failed('playwright-cli', ['tracing-start'], ran);
      await call(['tracing-stop']);
      await call(['tracing-start']);
    },
    async traceStop(into) {
      const ran = await call(['tracing-stop']);
      const linked = linkedFiles(ran.stdout, cwd);
      const kept = copyInto(linked, into);
      return [
        ...kept,
        ...copyCompanions(
          linked.filter(file => file.endsWith('.trace')),
          into,
        ),
      ];
    },
    async videoStart(file) {
      await call(['video-start', file]);
    },
    async videoStop() {
      await call(['video-stop']);
    },
    async console() {
      return (await call(['console'])).stdout;
    },
    async close() {
      await call(['close-all']);
    },
  };
}

/** agent-browser's `--json session list`: the sessions whose daemon runs, by name. */
function listsSession(stdout: string, session: string): boolean {
  try {
    const listed = JSON.parse(stdout) as { data?: { sessions?: unknown } };
    const sessions = listed.data?.sessions;
    return Array.isArray(sessions) && sessions.includes(session);
  } catch {
    return false;
  }
}

export function agentBrowserControl(run: DriverRun, session: string): BrowserControl {
  const call = (args: readonly string[], timeoutMs?: number) => ok('agent-browser', run, args, timeoutMs);
  return {
    driver: 'agent-browser',
    tracesActions: false,
    async isOpen() {
      const ran = await run(['--json', 'session', 'list'], CALL_MS);
      return ran.code === 0 && listsSession(ran.stdout, session);
    },
    async open(url) {
      await call(['open', url], 120_000);
    },
    async loadState(file) {
      await call(['state', 'load', file]);
    },
    async read() {
      const snapshot = await call(['snapshot']);
      const url = (await call(['get', 'url'])).stdout.trim();
      const title = (await call(['get', 'title'])).stdout.trim();
      return { url, title, tree: parseAriaSnapshot(snapshot.stdout) };
    },
    async screenshot(file) {
      await call(['screenshot', file]);
    },
    async traceStart() {
      await call(['trace', 'start']);
    },
    async traceStop(into) {
      fs.mkdirSync(into, { recursive: true, mode: 0o700 });
      const file = path.join(into, 'devtools-trace.json');
      await call(['trace', 'stop', file]);
      return fs.existsSync(file) ? [file] : [];
    },
    async videoStart(file) {
      await call(['record', 'start', file]);
    },
    async videoStop() {
      await call(['record', 'stop']);
    },
    async console() {
      const messages = (await call(['console'])).stdout;
      const errors = (await call(['errors'])).stdout;
      return `${messages.trimEnd()}\n${errors.trimEnd()}\n`;
    },
    async close() {
      await call(['close', '--all']);
    },
  };
}

export function controlFor(driver: BrowserDriverName, shim: string, env: NodeJS.ProcessEnv, cwd: string): BrowserControl {
  const run: DriverRun = (args, timeoutMs) => runCommand(shim, args, { env, cwd, timeoutMs: timeoutMs ?? CALL_MS });
  return driver === 'playwright' ? playwrightControl(run, cwd) : agentBrowserControl(run, env.AGENT_BROWSER_SESSION ?? '');
}
