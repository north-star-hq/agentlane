import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

interface Request {
  id?: number;
  method?: string;
  params?: { name: string; arguments: { device_id: string; yaml?: string; files?: string[] } };
}

const env = process.env;
const record = (entry: Record<string, unknown>) => {
  if (env.FAKE_LOG) fs.appendFileSync(env.FAKE_LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
};

if (process.argv.includes('--version')) {
  process.stdout.write('2.11.0-agentenv.fake\n');
  process.exit(0);
}

const screens = path.resolve(import.meta.dirname, '..', 'fixtures', 'ios-26.5');
const screenText = (name: string) => fs.readFileSync(path.join(screens, `${name}.inspect.json`), 'utf8');
const taps = JSON.parse(env.FAKE_TAPS ?? '{}') as Record<string, string>;
const stateFile = env.FAKE_STATE;
let screen = env.FAKE_START ?? 'settings';
if (stateFile && fs.existsSync(stateFile)) screen = fs.readFileSync(stateFile, 'utf8').trim() || screen;
const setScreen = (name: string) => {
  screen = name;
  if (stateFile) fs.writeFileSync(stateFile, name);
};

record({
  event: 'spawn',
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  token: env.MAESTRO_RUNNER_TOKEN,
  javaHome: env.JAVA_HOME,
  pathHead: (env.PATH ?? '').split(path.delimiter)[0],
  path: env.PATH,
  androidHome: env.ANDROID_HOME,
  opts: env.MAESTRO_OPTS,
});
process.stdout.write('kotlin-logging: initializing... (not JSON, like the real one)\n');

const dieAfter = env.FAKE_DIE_AFTER === undefined ? Infinity : Number(env.FAKE_DIE_AFTER);
const unreachableAfter = env.FAKE_UNREACHABLE_AFTER === undefined ? Infinity : Number(env.FAKE_UNREACHABLE_AFTER);
const notConnectedOn = env.FAKE_NOT_CONNECTED_ON === undefined ? -1 : Number(env.FAKE_NOT_CONNECTED_ON);
const JPEG =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
let calls = 0;
let reads = 0;
let tapCount = 0;
let driver: Promise<void> | undefined;
let xcodebuildPid: number | undefined;
const screenshotOf = (name: string) => {
  const file = path.join(screens, `${name}.screenshot.jpg`);
  return fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : JPEG;
};
const startDriver = (udid: string) =>
  (driver ??= new Promise(resolve => {
    const xcodebuild = spawn(
      process.execPath,
      [path.join(import.meta.dirname, 'fake-driver.ts'), 'xcodebuild', 'test-without-building', '-destination', `id=${udid}`],
      { stdio: ['ignore', 'pipe', 'ignore'], env },
    );
    xcodebuildPid = xcodebuild.pid;
    record({ event: 'xcodebuild', child: xcodebuild.pid });
    createInterface({ input: xcodebuild.stdout }).once('line', line => {
      record({ event: 'runner', child: Number(line) });
      resolve();
    });
  }));

const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const text = (value: string, isError = false) => ({ content: [{ type: 'text', text: value }], isError });

function runFlow(yaml: string) {
  const missing = /missing-[\w-]+/.exec(yaml);
  if (missing && !yaml.includes('assertNotVisible')) {
    return text(`Failed to run flow: Element not found: Id matching regex: ${missing[0]}`, true);
  }
  const workDir = process.argv[process.argv.indexOf('--working-dir') + 1];
  for (const match of yaml.matchAll(/takeScreenshot:\s*"?([\w./-]+)"?/g)) {
    if (workDir && match[1]) {
      const file = path.join(workDir, `${match[1]}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(JPEG, 'base64'));
    }
  }
  for (const match of yaml.matchAll(/tapOn:\s*(?:id:\s*|\{\s*id:\s*)?"?([\w.-]+)"?/g)) {
    const next = match[1] === undefined ? undefined : taps[match[1]];
    if (next) setScreen(next);
    if (match[1] === 'home-increment') tapCount += 1;
  }
  return text(JSON.stringify({ success: true, commands_executed: 1, message: 'Flow executed successfully' }));
}

const input = createInterface({ input: process.stdin });
input.on('close', () => {
  record({ event: 'stdin-closed' });
  if (xcodebuildPid !== undefined) process.kill(xcodebuildPid, 'SIGTERM');
  process.exit(0);
});
input.on('line', line => {
  void (async () => {
    const message = JSON.parse(line) as Request;
    if (message.id === undefined) return;
    if (message.method === 'initialize') {
      send({
        id: message.id,
        result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'maestro', version: 'fake' } },
      });
      return;
    }
    if (!message.params) return;
    const { name, arguments: args } = message.params;
    await startDriver(args.device_id);
    calls += 1;
    record({ event: 'call', name, args, n: calls, screen });
    if (calls > dieAfter) process.exit(3);
    if (calls === notConnectedOn) {
      send({
        id: message.id,
        result: text(`Failed to inspect screen: CliError: Device with id ${args.device_id} is not connected`, true),
      });
      return;
    }
    if (calls > unreachableAfter) {
      send({ id: message.id, result: text('Failed to inspect screen: Device became unreachable during deviceInfo', true) });
      return;
    }
    const hangMark = `${env.FAKE_LOG ?? ''}.hang`;
    if (name === env.FAKE_HANG_TOOL && !fs.existsSync(hangMark)) {
      fs.writeFileSync(hangMark, String(process.pid));
      return;
    }
    if (env.FAKE_DELAY_MS) await new Promise(resolve => setTimeout(resolve, Number(env.FAKE_DELAY_MS)));
    if (name === 'inspect_screen') {
      reads += 1;
      const live = screenText(screen)
        .replace(/Open for \d+ s/g, `Open for ${String(40 + reads)} s`)
        .replace(/Taps: \d+/g, `Taps: ${String(tapCount)}`);
      send({ id: message.id, result: text(live) });
    } else if (name === 'take_screenshot')
      send({ id: message.id, result: { content: [{ type: 'image', data: screenshotOf(screen), mimeType: 'image/jpeg' }] } });
    else if (name === 'run')
      send({ id: message.id, result: runFlow(args.yaml ?? fs.readFileSync(args.files?.[0] ?? '', 'utf8')) });
    else send({ id: message.id, result: text(`unknown tool ${name}`, true) });
  })();
});
