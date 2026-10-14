import { spawn } from 'node:child_process';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const [mode, ...rest] = process.argv.slice(2);

if (mode === 'xcodebuild') {
  const udid = rest.find(word => word.startsWith('id='))?.slice(3) ?? 'unknown';
  const runnerPath = `/fake/Library/Developer/CoreSimulator/Devices/${udid}/data/Containers/Bundle/Application/F/maestro-driver-iosUITests-Runner.app/maestro-driver-iosUITests-Runner`;
  const runner = spawn(process.execPath, [import.meta.filename, 'runner', String(process.pid), runnerPath], {
    detached: true,
    stdio: 'ignore',
  });
  runner.unref();
  process.stdout.write(`${String(runner.pid)}\n`);
  setInterval(() => undefined, 1000);
} else if (mode === 'runner') {
  const parent = Number(rest[0]);
  setInterval(() => {
    if (!alive(parent)) process.exit(0);
  }, 50);
} else {
  process.stderr.write(`fake-driver: unknown mode ${String(mode)}\n`);
  process.exit(2);
}
