import fs from 'node:fs';
import path from 'node:path';
import { envName, TOOL } from '../name.ts';
import type { Word } from './shell.ts';
import { splitCommands } from './shell.ts';

export type DevicePlatform = 'ios' | 'android';

export type BrowserDriver = 'playwright' | 'agent-browser';

export type Aim =
  | { kind: 'device'; platform: DevicePlatform; ref: string }
  | { kind: 'booted' }
  | { kind: 'every'; platform: DevicePlatform }
  | { kind: 'unselected' }
  | { kind: 'browser-session'; driver: BrowserDriver; session: string }
  | { kind: 'browser-port'; driver: BrowserDriver; port: number }
  | { kind: 'every-browser'; driver: BrowserDriver }
  | { kind: 'container' };

export interface AimedCommand {
  aim: Aim;
  command: string;
  cwd: string | null;
}

interface Scope {
  env: Map<string, string | null>;
  cwd: string | null;
  containersOnly: boolean;
}

/** The leading assignment, or variable in the hook's environment, that lets a container start through the guard. */
export const ALLOW_CONTAINER_ENV = envName('ALLOW_CONTAINER');

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn', 'bun']);
const PASS_THROUGH = new Set(['exec', 'nohup', 'setsid', 'builtin', 'noglob']);
const PACKAGE_MANAGER_WITH_VALUE = new Set(['-C', '--dir', '--prefix', '--cwd', '--filter', '-F', '-w', '--workspace']);
const PACKAGE_MANAGER_CWD = new Set(['-C', '--dir', '--prefix', '--cwd']);
const LIFECYCLE_SCRIPTS = new Map([
  ['start', 'start'],
  ['test', 'test'],
  ['t', 'test'],
  ['restart', 'restart'],
  ['stop', 'stop'],
]);
const MAX_SCRIPT_DEPTH = 8;

const CONTAINER_GLOBAL_WITH_VALUE = new Set([
  '-c',
  '--config',
  '--context',
  '-H',
  '--host',
  '-l',
  '--log-level',
  '--tlscacert',
  '--tlscert',
  '--tlskey',
  '--connection',
  '--url',
  '--identity',
  '--root',
  '--runroot',
  '--storage-driver',
  '--storage-opt',
  '--cgroup-manager',
  '--events-backend',
  '--hooks-dir',
  '--network-cmd-path',
  '--network-config-dir',
  '--runtime',
  '--runtime-flag',
  '--tmpdir',
  '--module',
  '--ssh',
  '--conmon',
  '--imagestore',
  '--volumepath',
  '--db-backend',
  '--out',
  '--cni-config-dir',
  '--registries-conf',
  '--cdi-spec-dir',
]);
const COMPOSE_GLOBAL_WITH_VALUE = new Set([
  '-f',
  '--file',
  '-p',
  '--project-name',
  '--profile',
  '--env-file',
  '--project-directory',
  '--ansi',
  '--parallel',
  '--progress',
  '--podman-path',
  '--podman-args',
  '--podman-pull-args',
  '--podman-push-args',
  '--podman-build-args',
  '--podman-inspect-args',
  '--podman-run-args',
  '--podman-start-args',
  '--podman-stop-args',
  '--podman-rm-args',
  '--podman-volume-args',
  '--pod-args',
  '--in-pod',
  '--x-podman',
]);
const CONTAINER_COMMANDS = new Set(
  (
    'attach build builder buildx bake checkpoint commit compose config container context cp create debug ' +
    'desktop diff events exec export extension history image images import info init inspect kill load ' +
    'login logout logs ls manifest model network node pause plugin port prune ps pull push rename restart ' +
    'rm rmi run save sbom scout search secret service stack start stats stop swarm system tag top trust ' +
    'unpause update version volume wait help ai mcp offload auto-update artifact farm generate ' +
    'healthcheck kube machine mount play pod quadlet unmount umount unshare untag varlink'
  ).split(' '),
);
const COMPOSE_COMMANDS = new Set(
  (
    'attach build commit config cp create down events exec export images kill logs ls pause port ps ' +
    'publish pull push restart rm run scale start stats stop top unpause up version volumes wait watch ' +
    'alpha bridge viz help systemd'
  ).split(' '),
);
/** The flags of `run` in docker, podman and compose that take no value; their parsers give every other flag the next word. */
const RUN_BOOLEAN_FLAGS = new Set([
  '--detach',
  '--disable-content-trust',
  '--help',
  '--init',
  '--interactive',
  '--no-healthcheck',
  '--oom-kill-disable',
  '--privileged',
  '--publish-all',
  '--quiet',
  '--read-only',
  '--rm',
  '--sig-proxy',
  '--tty',
  '--use-api-socket',
  '--env-host',
  '--http-proxy',
  '--no-hosts',
  '--passwd',
  '--read-only-tmpfs',
  '--replace',
  '--rmi',
  '--rootfs',
  '--tls-verify',
  '--build',
  '--no-deps',
  '--remove-orphans',
  '--service-ports',
  '--use-aliases',
  '--quiet-pull',
  '--no-TTY',
  '--quiet-build',
]);
const RUN_BOOLEAN_SHORTS = /^[ditTPq]*/;
const UP_BOOLEAN_SHORTS = /^[dV]*/;
const TRUE = new Set(['1', 't', 'T', 'true', 'TRUE', 'True']);

const ADB_READ_ONLY = new Set([
  'devices',
  'version',
  'help',
  'start-server',
  'keygen',
  'mdns',
  'track-devices',
  'host-features',
  'get-state',
  'get-serialno',
  'get-devpath',
  'pair',
]);
const ADB_WITH_VALUE = new Set(['-s', '-t', '-H', '-P', '-L', '-p', '--one-device']);
const SIMCTL_NO_DEVICE = new Set(['list', 'help', 'create', 'runtime']);
const PLAYWRIGHT_SESSION_ENV = 'PLAYWRIGHT_CLI_SESSION';
const AGENT_BROWSER_SESSION_ENV = 'AGENT_BROWSER_SESSION';

/** The browser driver a command word runs: its CLI by name or path, or its npm package as npx names it. */
function browserDriverOf(word: Word | undefined): BrowserDriver | null {
  if (!word?.literal) return null;
  const name = path.basename(word.text);
  if (name === 'playwright-cli' || /^@playwright\/cli(@[^/]*)?$/.test(word.text)) return 'playwright';
  if (name === 'agent-browser' || /^agent-browser@[^/]*$/.test(word.text)) return 'agent-browser';
  return null;
}

/** A debugging port from a CDP endpoint: a bare port, or a URL or host with one. */
function portOf(endpoint: string): number | null {
  const bare = /^\d{1,5}$/.exec(endpoint);
  const port = bare ? Number(endpoint) : Number(/:(\d{1,5})(?:[/?#]|$)/.exec(endpoint)?.[1] ?? Number.NaN);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

function value(word: Word | undefined, scope: Scope): string | null {
  if (!word) return null;
  if (word.literal) return word.text;
  const variable = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(word.text);
  if (!variable?.[1]) return null;
  return scope.env.get(variable[1]) ?? null;
}

function base(word: Word | undefined): string | null {
  return word?.literal ? path.basename(word.text) : null;
}

function joined(words: readonly Word[]): string {
  return words.map(w => (/[\s"'$]/.test(w.text) && w.literal ? JSON.stringify(w.text) : w.text)).join(' ');
}

function skipOptions(words: readonly Word[], start: number, withValue: ReadonlySet<string>): number {
  let i = start;
  while (i < words.length) {
    const text = words[i]?.text ?? '';
    if (text === '--') return i + 1;
    if (!words[i]?.literal || !text.startsWith('-') || text === '-') return i;
    i += withValue.has(text) ? 2 : 1;
  }
  return i;
}

/**
 * The index of the subcommand: the first word that names one, past the options before it and any word that names none,
 * such as the value of a global option this list doesn't know.
 */
function subcommandAt(
  args: readonly Word[],
  start: number,
  withValue: ReadonlySet<string>,
  known: ReadonlySet<string>,
  scope: Scope,
): number {
  let i = start;
  while (i < args.length) {
    const t = value(args[i], scope);
    if (t !== null && known.has(t)) return i;
    i += t !== null && withValue.has(t) ? 2 : 1;
  }
  return i;
}

/** Whether `run`'s options, up to the image or service, detach: `-d`, `--detach[=true]`, or `d` in a cluster like `-itd`. */
function runDetaches(args: readonly Word[], scope: Scope): boolean {
  for (let i = 0; i < args.length; i++) {
    const t = value(args[i], scope);
    if (t === null || t === '--' || !t.startsWith('-') || t === '-') return false;
    if (t.startsWith('--')) {
      const [flag = '', given] = t.split(/=(.*)/s);
      if (flag === '--detach' && (given === undefined || TRUE.has(given))) return true;
      if (given === undefined && !RUN_BOOLEAN_FLAGS.has(flag)) i++;
      continue;
    }
    const cluster = t.slice(1);
    const flags = RUN_BOOLEAN_SHORTS.exec(cluster)?.[0] ?? '';
    if (flags.includes('d')) return true;
    if (flags.length === cluster.length - 1) i++;
  }
  return false;
}

/** Whether `compose up` detaches: `-d`, `--detach`, or `--wait`, which compose documents as implying detached mode. */
function upDetaches(args: readonly Word[], scope: Scope): boolean {
  return args.some(word => {
    const t = value(word, scope);
    if (t === null || !t.startsWith('-') || t === '-') return false;
    const [flag = '', given] = t.split(/=(.*)/s);
    if (flag === '--detach' || flag === '--wait') return given === undefined || TRUE.has(given);
    if (t.startsWith('--')) return false;
    return (UP_BOOLEAN_SHORTS.exec(t.slice(1))?.[0] ?? '').includes('d');
  });
}

function nearestScripts(cwd: string | null): { dir: string; scripts: Record<string, unknown> } | null {
  if (cwd === null) return null;
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
    } catch {
      if (path.dirname(dir) === dir) return null;
      continue;
    }
    try {
      const { scripts } = JSON.parse(text) as { scripts?: unknown };
      return typeof scripts === 'object' && scripts !== null ? { dir, scripts: scripts as Record<string, unknown> } : null;
    } catch {
      return null;
    }
  }
}

class Interpreter {
  readonly aims: AimedCommand[] = [];
  private readonly scope: Scope;
  private depth = 0;

  constructor(env: NodeJS.ProcessEnv, cwd: string | null) {
    this.scope = { env: new Map(Object.entries(env).map(([k, v]) => [k, v ?? null])), cwd, containersOnly: false };
  }

  script(text: string, scope: Scope = this.scope): void {
    for (const command of splitCommands(text)) this.command(command.words, scope);
  }

  private aim(aim: Aim, words: readonly Word[], scope: Scope): void {
    if (scope.containersOnly && aim.kind !== 'container') return;
    this.aims.push({ aim, command: joined(words), cwd: scope.cwd });
  }

  command(words: readonly Word[], outer: Scope): void {
    let i = 0;
    const local: Scope = { ...outer, env: new Map(outer.env) };
    for (; i < words.length; i++) {
      const word = words[i];
      const match = word?.literal ? ASSIGNMENT.exec(word.text) : null;
      if (!match?.[1]) {
        const raw = word ? /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(word.text) : null;
        if (!raw?.[1]) break;
        local.env.set(raw[1], null);
        continue;
      }
      local.env.set(match[1], match[2] ?? '');
    }
    const rest = words.slice(i);
    if (rest.length === 0) {
      for (const [k, v] of local.env) outer.env.set(k, v);
      return;
    }
    this.run(rest, local, outer);
  }

  private run(words: readonly Word[], scope: Scope, outer: Scope): void {
    const head = base(words[0]);
    if (head === null) return;
    const args = words.slice(1);
    const driver = browserDriverOf(words[0]);
    if (driver !== null) {
      this.browser(driver, words, args, scope);
      return;
    }
    switch (head) {
      case 'export':
        for (const w of args) {
          const m = w.literal ? ASSIGNMENT.exec(w.text) : null;
          if (m?.[1]) outer.env.set(m[1], m[2] ?? '');
        }
        return;
      case 'cd':
        outer.cwd = this.cd(args, outer);
        return;
      case 'env':
        this.env(args, scope);
        return;
      case 'command':
        if (args[0]?.text === '-v' || args[0]?.text === '-V') return;
        this.command(args.slice(skipOptions(args, 0, new Set())), scope);
        return;
      case 'nice':
        this.command(args.slice(skipOptions(args, 0, new Set(['-n']))), scope);
        return;
      case 'timeout':
      case 'gtimeout': {
        const at = skipOptions(args, 0, new Set(['-s', '-k', '--signal', '--kill-after']));
        this.command(args.slice(at + 1), scope);
        return;
      }
      case 'sudo':
      case 'doas':
        this.command(args.slice(skipOptions(args, 0, new Set(['-u', '-g', '-C', '-h', '-p', '-r', '-t', '-D', '-U']))), scope);
        return;
      case 'xargs':
        this.command(
          args.slice(skipOptions(args, 0, new Set(['-n', '-I', '-L', '-P', '-s', '-E', '-d', '-a', '-J', '-R', '-S']))),
          scope,
        );
        return;
      case 'caffeinate':
        this.command(args.slice(skipOptions(args, 0, new Set(['-t', '-w']))), scope);
        return;
      case 'stdbuf':
        this.command(args.slice(skipOptions(args, 0, new Set(['-i', '-o', '-e']))), scope);
        return;
      case 'arch':
        this.command(args.slice(skipOptions(args, 0, new Set(['-arch']))), scope);
        return;
      case 'watch': {
        const at = skipOptions(args, 0, new Set(['-n', '--interval']));
        this.script(
          args
            .slice(at)
            .map(w => w.text)
            .join(' '),
          scope,
        );
        return;
      }
      case 'eval':
        this.script(args.map(w => w.text).join(' '), scope);
        return;
      case 'xcrun':
        this.xcrun(words, args, scope);
        return;
      case 'simctl':
        this.simctl(words, args, scope);
        return;
      case 'adb':
      case 'adb.exe':
        this.adb(words, args, scope);
        return;
      case 'emulator':
        this.emulator(words, args, scope);
        return;
      case 'avdmanager':
        this.avdmanager(words, args, scope);
        return;
      case 'docker':
      case 'podman':
        this.container(words, args, scope);
        return;
      case 'docker-compose':
      case 'podman-compose':
        this.compose(words, args, scope);
        return;
      default:
        break;
    }
    if (PASS_THROUGH.has(head)) {
      this.command(args.slice(skipOptions(args, 0, new Set(['-a']))), scope);
      return;
    }
    if (SHELLS.has(head)) {
      const c = args.findIndex(w => w.literal && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w.text));
      const script = c === -1 ? null : value(args[c + 1], scope);
      if (script !== null) this.script(script, { ...scope, env: new Map(scope.env) });
      return;
    }
    if (RUNNERS.has(head)) {
      this.command(args.slice(skipOptions(args, 0, new Set(['-p', '--package', '-c']))), scope);
      return;
    }
    if (PACKAGE_MANAGERS.has(head) && (args[0]?.text === 'exec' || args[0]?.text === 'dlx' || args[0]?.text === 'x')) {
      this.command(args.slice(skipOptions(args, 1, new Set())), scope);
      return;
    }
    if (PACKAGE_MANAGERS.has(head)) {
      this.packageScript(head, args, scope);
      return;
    }
    if (head === TOOL && args[0]?.text === 'exec') {
      this.command(args.slice(skipOptions(args, 1, new Set())), scope);
    }
  }

  /**
   * playwright-cli takes its session as `-s=<name>`, `-s <name>`, `--session[=]<name>` or PLAYWRIGHT_CLI_SESSION, and
   * `kill-all` stops every Playwright daemon on the machine; `attach --cdp=<endpoint>` joins a running browser. Its
   * parser (minimist) lets any other option take the next word as its value, so `kill-all` counts wherever it stands.
   * agent-browser takes `--session[=]<name>` or AGENT_BROWSER_SESSION, and `--cdp <endpoint>` or `connect <endpoint>`.
   */
  private browser(driver: BrowserDriver, words: readonly Word[], args: readonly Word[], scope: Scope): void {
    const texts = args.map(w => value(w, scope));
    let session: string | null | undefined;
    const ports: number[] = [];
    const positionals: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      if (t === null || t === undefined) continue;
      const flag = /^(-s|--session|--cdp)(?:=(.*))?$/s.exec(t);
      if (flag?.[1] === '-s' && driver !== 'playwright') {
        positionals.push(t);
        continue;
      }
      if (flag?.[1]) {
        const given = flag[2] ?? texts[i + 1] ?? null;
        if (flag[2] === undefined) i++;
        if (flag[1] === '--cdp') {
          const port = given === null ? null : portOf(given);
          if (port !== null) ports.push(port);
        } else session = given;
        continue;
      }
      if (!t.startsWith('-')) positionals.push(t);
    }
    const [command, target] = positionals;
    if (driver === 'playwright' && positionals.includes('kill-all')) {
      this.aim({ kind: 'every-browser', driver }, words, scope);
      return;
    }
    if (driver === 'agent-browser' && command === 'connect' && target !== undefined) {
      const port = portOf(target);
      if (port !== null) ports.push(port);
    }
    for (const port of ports) this.aim({ kind: 'browser-port', driver, port }, words, scope);
    if (session === undefined)
      session = scope.env.get(driver === 'playwright' ? PLAYWRIGHT_SESSION_ENV : AGENT_BROWSER_SESSION_ENV);
    if (session) this.aim({ kind: 'browser-session', driver, session }, words, scope);
  }

  private container(words: readonly Word[], args: readonly Word[], scope: Scope): void {
    const at = subcommandAt(args, 0, CONTAINER_GLOBAL_WITH_VALUE, CONTAINER_COMMANDS, scope);
    let sub = value(args[at], scope);
    let rest = args.slice(at + 1);
    if (sub === 'container') {
      const inner = subcommandAt(rest, 0, new Set(), CONTAINER_COMMANDS, scope);
      sub = value(rest[inner], scope);
      rest = rest.slice(inner + 1);
    }
    if (sub === 'compose') {
      this.compose(words, rest, scope);
      return;
    }
    const texts = rest.map(w => value(w, scope));
    const starts =
      (sub === 'run' && runDetaches(rest, scope)) ||
      ((sub === 'start' || sub === 'restart') && !texts.includes('--help')) ||
      (sub === 'pod' && (texts[0] === 'start' || texts[0] === 'restart')) ||
      (((sub === 'kube' && texts[0] === 'play') || (sub === 'play' && texts[0] === 'kube')) && !texts.includes('--down'));
    if (starts) this.startsContainer(words, scope);
  }

  private compose(words: readonly Word[], args: readonly Word[], scope: Scope): void {
    const at = subcommandAt(args, 0, COMPOSE_GLOBAL_WITH_VALUE, COMPOSE_COMMANDS, scope);
    const sub = value(args[at], scope);
    const rest = args.slice(at + 1);
    const starts =
      (sub === 'up' && upDetaches(rest, scope)) ||
      (sub === 'run' && runDetaches(rest, scope)) ||
      sub === 'start' ||
      sub === 'restart';
    if (starts) this.startsContainer(words, scope);
  }

  private startsContainer(words: readonly Word[], scope: Scope): void {
    if (scope.env.get(ALLOW_CONTAINER_ENV) === '1') return;
    this.aim({ kind: 'container' }, words, scope);
  }

  /**
   * npm runs a script with `run`, `run-script` or a lifecycle command, along with its pre- and post-scripts; pnpm, yarn
   * and bun also run one named as the command itself. Each runs the script through `sh -c` in the folder of the nearest
   * package.json.
   */
  private packageScript(manager: string, args: readonly Word[], scope: Scope): void {
    if (this.depth >= MAX_SCRIPT_DEPTH) return;
    let cwd = scope.cwd;
    let i = 0;
    while (i < args.length) {
      const t = args[i]?.literal ? (args[i]?.text ?? '') : '';
      if (!t.startsWith('-') || t === '-') break;
      const [flag = '', given] = t.split(/=(.*)/s);
      if (PACKAGE_MANAGER_CWD.has(flag)) {
        const dir = given ?? value(args[i + 1], scope);
        cwd = dir === null || (cwd === null && !path.isAbsolute(dir)) ? null : path.resolve(cwd ?? '/', dir);
      }
      i += given === undefined && PACKAGE_MANAGER_WITH_VALUE.has(flag) ? 2 : 1;
    }
    const sub = value(args[i], scope);
    if (sub === null) return;
    let name: string | null | undefined;
    if (sub === 'run' || sub === 'run-script') name = value(args[skipOptions(args, i + 1, new Set())], scope);
    else if (manager !== 'bun' && LIFECYCLE_SCRIPTS.has(sub)) name = LIFECYCLE_SCRIPTS.get(sub);
    else if (manager !== 'npm') name = sub;
    if (!name) return;
    const found = nearestScripts(cwd);
    if (found === null) return;
    const names = manager === 'npm' ? [`pre${name}`, name, `post${name}`] : [name];
    const inner: Scope = { env: new Map(scope.env), cwd: found.dir, containersOnly: true };
    this.depth++;
    try {
      for (const key of names) {
        const body = found.scripts[key];
        if (typeof body === 'string') this.script(body, inner);
      }
    } finally {
      this.depth--;
    }
  }

  private cd(args: readonly Word[], scope: Scope): string | null {
    const target = args.find(w => !(w.literal && w.text.startsWith('-') && w.text !== '-'));
    if (!target) return scope.env.get('HOME') ?? null;
    const dir = value(target, scope);
    if (dir === null || dir === '-') return null;
    const expanded = dir.startsWith('~/') ? path.join(scope.env.get('HOME') ?? '~', dir.slice(2)) : dir;
    if (path.isAbsolute(expanded)) return path.normalize(expanded);
    return scope.cwd === null ? null : path.resolve(scope.cwd, expanded);
  }

  private env(args: readonly Word[], scope: Scope): void {
    const local: Scope = { ...scope, env: new Map(scope.env) };
    let i = 0;
    while (i < args.length) {
      const w = args[i];
      if (!w?.literal) break;
      const t = w.text;
      if (t === '-i' || t === '--ignore-environment' || t === '-') local.env = new Map();
      else if (t === '-u' || t === '--unset') {
        local.env.delete(args[i + 1]?.text ?? '');
        i++;
      } else if (t.startsWith('--unset=')) local.env.delete(t.slice('--unset='.length));
      else if (t === '-C' || t === '--chdir') {
        local.cwd = this.cd([args[i + 1] ?? { text: '-', literal: true }], local);
        i++;
      } else if (t === '-S' || t === '--split-string') {
        this.script([args[i + 1]?.text ?? '', ...args.slice(i + 2).map(a => a.text)].join(' '), local);
        return;
      } else if (t === '-P') i++;
      else if (t === '--') {
        i++;
        break;
      } else if (!t.startsWith('-')) break;
      i++;
    }
    this.command(args.slice(i), local);
  }

  private xcrun(words: readonly Word[], args: readonly Word[], scope: Scope): void {
    let i = 0;
    while (i < args.length) {
      const t = args[i]?.text ?? '';
      if (!args[i]?.literal) return;
      if (['--find', '-f', '-find'].includes(t) || t.startsWith('--show-sdk') || t.startsWith('-show-sdk')) return;
      if (['--sdk', '-sdk', '--toolchain', '-toolchain'].includes(t)) i += 2;
      else if (t.startsWith('-')) i++;
      else break;
    }
    if (base(args[i]) === 'simctl') this.simctl(words, args.slice(i + 1), scope);
  }

  private simctl(words: readonly Word[], args: readonly Word[], scope: Scope): void {
    const at = skipOptions(args, 0, new Set(['--set', '--profiles']));
    const sub = value(args[at], scope);
    if (sub === null || SIMCTL_NO_DEVICE.has(sub)) return;
    const rest = args.slice(at + 1).map(w => value(w, scope));
    if (['shutdown', 'erase', 'delete'].includes(sub) && rest.includes('all')) {
      this.aim({ kind: 'every', platform: 'ios' }, words, scope);
      return;
    }
    if (sub === 'delete' && rest.includes('unavailable')) {
      this.aim({ kind: 'every', platform: 'ios' }, words, scope);
      return;
    }
    for (const ref of rest) {
      if (ref === null || ref.startsWith('-')) continue;
      if (ref === 'booted') this.aim({ kind: 'booted' }, words, scope);
      else this.aim({ kind: 'device', platform: 'ios', ref }, words, scope);
    }
  }

  private adb(words: readonly Word[], args: readonly Word[], scope: Scope): void {
    let serial: string | null | undefined;
    let unselected = false;
    let usb = false;
    let i = 0;
    while (i < args.length) {
      const w = args[i];
      const t = w?.text ?? '';
      if (!w?.literal) {
        if (i === 0) return;
        break;
      }
      if (!t.startsWith('-')) break;
      if (t === '-s' || t === '--one-device') {
        serial = value(args[i + 1], scope);
        i += 2;
      } else if (t.startsWith('-s') && t.length > 2) {
        serial = t.slice(2);
        i++;
      } else if (t === '-t' || (t.startsWith('-t') && t.length > 2) || t === '-e') {
        unselected = true;
        i += t === '-t' ? 2 : 1;
      } else if (t === '-d') {
        usb = true;
        i++;
      } else i += ADB_WITH_VALUE.has(t) ? 2 : 1;
    }
    const command = value(args[i], scope);
    if (command === null) return;
    const rest = args.slice(i + 1).map(w => value(w, scope));
    if (ADB_READ_ONLY.has(command) || command === '--version') return;
    if (rest[0] === '--list' && (command === 'forward' || command === 'reverse')) return;
    const selected = serial !== undefined || unselected || usb;
    if (
      command === 'kill-server' ||
      command === 'connect' ||
      (command === 'disconnect' && rest.length === 0) ||
      (command === 'reconnect' && rest[0] === 'offline') ||
      (command === 'forward' && rest[0] === '--remove-all' && !selected)
    ) {
      this.aim({ kind: 'every', platform: 'android' }, words, scope);
      return;
    }
    if (command === 'disconnect') {
      for (const ref of rest) if (ref !== null) this.aim({ kind: 'device', platform: 'android', ref }, words, scope);
      return;
    }
    if (serial === undefined && !unselected && !usb) {
      const fromEnv = scope.env.get('ANDROID_SERIAL');
      if (fromEnv) serial = fromEnv;
    }
    if (serial !== undefined && serial !== null) this.aim({ kind: 'device', platform: 'android', ref: serial }, words, scope);
    else if (serial === undefined && !usb) this.aim({ kind: 'unselected' }, words, scope);
  }

  private emulator(words: readonly Word[], args: readonly Word[], scope: Scope): void {
    for (let i = 0; i < args.length; i++) {
      const t = value(args[i], scope);
      if (t === null) continue;
      if (t === '-avd') {
        const avd = value(args[i + 1], scope);
        if (avd) this.aim({ kind: 'device', platform: 'android', ref: avd }, words, scope);
      } else if (t.startsWith('@') && t.length > 1) {
        this.aim({ kind: 'device', platform: 'android', ref: t.slice(1) }, words, scope);
      } else if (t === '-port') {
        const port = value(args[i + 1], scope);
        if (port) this.aim({ kind: 'device', platform: 'android', ref: `emulator-${port}` }, words, scope);
      }
    }
  }

  private avdmanager(words: readonly Word[], args: readonly Word[], scope: Scope): void {
    const texts = args.map(w => value(w, scope));
    if (!texts.includes('delete') && !texts.includes('move')) return;
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      if (t === '-n' || t === '--name') {
        const name = texts[i + 1];
        if (name) this.aim({ kind: 'device', platform: 'android', ref: name }, words, scope);
      } else if (t?.startsWith('--name=')) {
        this.aim({ kind: 'device', platform: 'android', ref: t.slice('--name='.length) }, words, scope);
      }
    }
  }
}

export function aimsOf(script: string, env: NodeJS.ProcessEnv, cwd: string | null): AimedCommand[] {
  const interpreter = new Interpreter(env, cwd);
  interpreter.script(script);
  return interpreter.aims;
}
