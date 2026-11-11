import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { resolveToolchain } from '../../src/driver/client.ts';
import { DriverError } from '../../src/driver/errors.ts';
import {
  distributionVersion,
  ensureMaestro,
  findJdk17,
  installedMaestro,
  JAVA_HOME_TOOL,
  MAESTRO_OVERRIDE_ENV,
  maestroBuild,
  maestroHome,
  registeredJdk17,
  type Downloader,
  type JdkSearch,
} from '../../src/driver/install.ts';
import { JAVA_HOME_ENV } from '../../src/hooks/env.ts';
import type { Lane } from '../../src/registry/types.ts';
import { describeMaestroBuild } from '../../src/up/doctor.ts';
import { maestroShim } from '../../src/up/maestro-env.ts';
import { FORMER, TOOL } from '../../src/name.ts';
import { lanesRoot } from '../../src/registry/paths.ts';
import { Store } from '../../src/registry/store.ts';
import { MAESTRO_RELEASE, type MaestroRelease } from '../../src/driver/release.ts';
import type { RunningCommand } from '../../src/driver/superseded.ts';
import type { ProcessTable } from '../../src/processes.ts';
import { runningCommands, tempDir } from '../support/fakes.ts';
import { makeZip } from '../support/zip.ts';

const VERSION = '9.9.9-agentenv.test';

const noJdk17: JdkSearch = () => Promise.resolve(undefined);
const finding =
  (home: string): JdkSearch =>
  () =>
    Promise.resolve({ home, origin: `the search's ${home}` });

function fakeJdk(root: string, spec = '17'): string {
  const home = path.join(root, `jdk-${spec}`);
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'bin', 'java'),
    `#!/bin/sh\necho "    java.specification.version = ${spec}" >&2\necho "    java.home = ${home}" >&2\n`,
    { mode: 0o755 },
  );
  return home;
}

function build(root: string, printed?: string, version = VERSION): { zip: Buffer; release: MaestroRelease; dir: string } {
  const zip = makeZip([
    { name: 'maestro/bin/maestro', data: `#!/bin/sh\necho "${printed ?? version}"\n`, mode: 0o100755 },
    { name: 'maestro/lib/maestro.jar', data: 'jar' },
    { name: 'maestro/NOTICE', data: 'notice' },
  ]);
  const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
  const release: MaestroRelease = {
    ...MAESTRO_RELEASE,
    version,
    asset: `maestro-${version}.zip`,
    size: zip.length,
    sha256,
  };
  const dir = path.join(root, 'served');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, release.asset), zip);
  fs.writeFileSync(path.join(dir, `${release.asset}.sha256`), `${sha256}  ${release.asset}\n`);
  return { zip, release, dir };
}

function serving(dir: string, edit?: (zip: string, checksum: string) => void): Downloader {
  return (release, into) => {
    fs.mkdirSync(into, { recursive: true });
    const zip = path.join(into, release.asset);
    const checksum = `${zip}.sha256`;
    fs.copyFileSync(path.join(dir, release.asset), zip);
    fs.copyFileSync(path.join(dir, `${release.asset}.sha256`), checksum);
    edit?.(zip, checksum);
    return Promise.resolve({ zip, checksumFile: checksum });
  };
}

function world() {
  const root = fs.realpathSync(tempDir('install'));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    AGENTLANE_STATE_DIR: path.join(root, 'state', 'agentlane'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    CODEX_HOME: path.join(root, 'codex'),
    JAVA_HOME: fakeJdk(root),
  };
  return { root, env };
}

test('first use downloads the pinned build, checks it, unpacks it and checks --version; later uses find it installed', async () => {
  const { root, env } = world();
  const { release, dir } = build(root);
  const lines: string[] = [];
  const installed = await ensureMaestro({ env, release, download: serving(dir), log: line => lines.push(line) });
  assert.equal(installed.installedNow, true);
  assert.equal(installed.home, path.join(root, 'data', 'agentlane', 'maestro', VERSION));
  assert.equal(installed.binary, path.join(installed.home, 'maestro', 'bin', 'maestro'));
  assert.ok(fs.statSync(installed.binary).mode & 0o100);
  assert.match(lines[0] ?? '', /^downloading Maestro 9\.9\.9-agentenv\.test/);
  const marker = JSON.parse(fs.readFileSync(path.join(installed.home, '.installed'), 'utf8')) as { sha256: string };
  assert.equal(marker.sha256, release.sha256);
  let downloads = 0;
  const again = await ensureMaestro({
    env,
    release,
    download: () => {
      downloads += 1;
      return Promise.reject(new Error('should not download'));
    },
  });
  assert.equal(again.installedNow, false);
  assert.equal(downloads, 0);
  assert.equal(installedMaestro(env, release)?.binary, installed.binary);
  assert.deepEqual(fs.readdirSync(path.dirname(installed.home)).sort(), [VERSION]);
});

async function refused(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DriverError, String(error));
    assert.match(error.message, pattern);
    assert.match(error.fix, /retry|upgrade|download/);
    return true;
  });
}

test('a corrupted download is refused and nothing is installed', async () => {
  const { root, env } = world();
  const { release, dir } = build(root);
  const corrupt = serving(dir, zip => {
    const bytes = fs.readFileSync(zip);
    bytes[40] = (bytes[40] ?? 0) ^ 0xff;
    fs.writeFileSync(zip, bytes);
  });
  await refused(ensureMaestro({ env, release, download: corrupt }), /hashes to sha256 [0-9a-f]{64}, but agentlane pins/);
  assert.equal(fs.existsSync(maestroHome(env, release)), false);
  assert.deepEqual(fs.readdirSync(path.dirname(maestroHome(env, release))), []);
});

test('a download that matches its own checksum file but not the pinned hash is refused', async () => {
  const { root, env } = world();
  const { release, dir } = build(root);
  const wrongPin = { ...release, sha256: '0'.repeat(64) };
  await refused(ensureMaestro({ env, release: wrongPin, download: serving(dir) }), /but agentlane pins 0{64}/);
  assert.equal(fs.existsSync(maestroHome(env, release)), false);
});

test('a release whose checksum file disagrees with the pin is refused, even when the zip matches the pin', async () => {
  const { root, env } = world();
  const { release, dir } = build(root);
  const download = serving(dir, (_zip, checksum) => {
    fs.writeFileSync(checksum, `${'a'.repeat(64)}  ${release.asset}\n`);
  });
  await refused(ensureMaestro({ env, release, download }), /the release's own checksum file says a{64}/);
});

test('a download of the wrong size is refused before hashing', async () => {
  const { root, env } = world();
  const { release, dir } = build(root);
  await refused(
    ensureMaestro({ env, release: { ...release, size: release.size + 1 }, download: serving(dir) }),
    /bytes, but the pinned asset is/,
  );
});

test('a zip from disk is checked against the pin like a download', async () => {
  const { root, env } = world();
  const { release, dir } = build(root);
  const installed = await ensureMaestro({ env, release, from: path.join(dir, release.asset) });
  assert.equal(installed.installedNow, true);
  await refused(
    ensureMaestro({ env, release: { ...release, sha256: 'f'.repeat(64) }, from: path.join(dir, release.asset) }),
    /pins f{64}/,
  );
});

test(
  'a zip from disk carrying macOS quarantine installs with no quarantine on any file',
  { skip: process.platform !== 'darwin' && 'com.apple.quarantine and xattr are macOS’s' },
  async () => {
    const { root, env } = world();
    const { release, dir } = build(root);
    const zip = path.join(dir, release.asset);
    execFileSync('xattr', ['-w', 'com.apple.quarantine', '0081;00000000;Safari;', zip]);
    const installed = await ensureMaestro({ env, release, from: zip });
    assert.doesNotMatch(execFileSync('xattr', ['-lr', installed.home], { encoding: 'utf8' }), /com\.apple\.quarantine/);
  },
);

test('a build whose --version is not the pinned version is refused', async () => {
  const { root, env } = world();
  const { release, dir } = build(root, '1.0.0');
  await assert.rejects(ensureMaestro({ env, release, download: serving(dir) }), /prints '1\.0\.0' for --version/);
  assert.equal(fs.existsSync(maestroHome(env, release)), false);
});

const OLDER = '9.9.8-agentenv.test';
const NEWER = '9.10.0-agentenv.test';

function nobodyRunning(): RunningCommand[] {
  return [];
}

test('installing and checking a newer build removes the older one, and the newer one runs', async () => {
  const { root, env } = world();
  const older = build(root, undefined, OLDER);
  const a = await ensureMaestro({ env, release: older.release, download: serving(older.dir), commandLines: nobodyRunning });
  const newer = build(root);
  const lines: string[] = [];
  const b = await ensureMaestro({
    env,
    release: newer.release,
    download: serving(newer.dir),
    commandLines: nobodyRunning,
    log: line => lines.push(line),
  });
  assert.equal(fs.existsSync(a.home), false);
  assert.deepEqual(fs.readdirSync(path.dirname(b.home)), [VERSION]);
  assert.equal(execFileSync(b.binary, ['--version'], { encoding: 'utf8' }).trim(), VERSION);
  assert.ok(lines.includes(`removed ${a.home}, which this version supersedes`), lines.join('\n'));
  assert.equal(installedMaestro(env, older.release), undefined);
});

test('a failed install of a newer build leaves the older one installed', async () => {
  const { root, env } = world();
  const older = build(root, undefined, OLDER);
  const a = await ensureMaestro({ env, release: older.release, download: serving(older.dir), commandLines: nobodyRunning });
  const newer = build(root, '1.0.0');
  await assert.rejects(
    ensureMaestro({ env, release: newer.release, download: serving(newer.dir), commandLines: nobodyRunning }),
    /prints '1\.0\.0' for --version/,
  );
  const corrupt = serving(newer.dir, zip => {
    fs.appendFileSync(zip, '\0');
  });
  await assert.rejects(ensureMaestro({ env, release: newer.release, download: corrupt, commandLines: nobodyRunning }), /bytes/);
  assert.equal(installedMaestro(env, older.release)?.binary, a.binary);
  assert.equal(execFileSync(a.binary, ['--version'], { encoding: 'utf8' }).trim(), OLDER);
});

test('an install keeps the builds a running process uses, another process is installing, or that are newer', async () => {
  const { root, env } = world();
  const homes = new Map<string, string>();
  for (const version of [NEWER, '9.9.6-agentenv.test', '9.9.7-agentenv.test', OLDER]) {
    const served = build(path.join(root, version), undefined, version);
    const installed = await ensureMaestro({
      env,
      release: served.release,
      download: serving(served.dir),
      commandLines: () => undefined,
    });
    homes.set(version, installed.home);
  }
  const base = path.join(root, 'data', 'agentlane', 'maestro');
  assert.equal(fs.readdirSync(base).length, 4, 'a process table ps cannot read keeps every build');

  const installer = { pid: 999_999, start: 'Mon Oct 12 00:00:00 2026' };
  const processes: ProcessTable = {
    startTimes: pids =>
      new Map(
        pids.flatMap(pid =>
          pid === process.pid ? [[pid, 'me'] as const] : pid === installer.pid ? [[pid, installer.start] as const] : [],
        ),
      ),
    info: () => undefined,
    cwd: () => undefined,
  };
  const installing = path.join(base, '.9.9.7-agentenv.test.lock');
  fs.writeFileSync(installing, JSON.stringify(installer));
  const running = `java -classpath ${homes.get(OLDER) ?? ''}/maestro/lib/* maestro.cli.AppKt mcp --no-viewer`;
  const current = build(root);
  const lines: string[] = [];
  await ensureMaestro({
    env,
    release: current.release,
    download: serving(current.dir),
    processes,
    commandLines: runningCommands(running),
    log: line => lines.push(line),
  });
  assert.deepEqual(
    fs
      .readdirSync(base)
      .filter(name => !name.startsWith('.'))
      .sort(),
    [NEWER, '9.9.7-agentenv.test', OLDER, VERSION].sort(),
    lines.join('\n'),
  );
  assert.ok(lines.includes(`kept ${homes.get(OLDER) ?? ''}, which a running process uses`), lines.join('\n'));
  assert.ok(
    lines.includes(`kept ${homes.get('9.9.7-agentenv.test') ?? ''}, which another process is installing`),
    lines.join('\n'),
  );
  assert.ok(lines.includes(`removed ${homes.get('9.9.6-agentenv.test') ?? ''}, which this version supersedes`), lines.join('\n'));
  assert.deepEqual(JSON.parse(fs.readFileSync(installing, 'utf8')), installer, 'the other installer still holds its lock');
});

test('a build a real running process was started from is kept', async () => {
  const { root, env } = world();
  const older = build(root, undefined, OLDER);
  const a = await ensureMaestro({ env, release: older.release, download: serving(older.dir) });
  const child = spawn('/bin/sh', ['-c', 'sleep 30; :', a.binary], { stdio: 'ignore' });
  try {
    const current = build(root);
    await ensureMaestro({ env, release: current.release, download: serving(current.dir) });
    assert.equal(installedMaestro(env, older.release)?.binary, a.binary);
  } finally {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
  }
  const again = build(path.join(root, 'again'), undefined, '9.9.10-agentenv.test');
  await ensureMaestro({ env, release: again.release, download: serving(again.dir) });
  assert.equal(fs.existsSync(a.home), false, 'once the process is gone the next install removes the build');
});

/** A lane recorded in the registry in `dir`, whose `bin/maestro` runs `binary`, as `up` writes it. */
function laneUp(dir: string, id: string, binary: string): { end: () => void } {
  const store = Store.open(dir, 5000);
  try {
    store.write(() => {
      store.db
        .prepare(
          `INSERT INTO claims (id, token, owner_key, owner_kind, owner_pid, owner_start, owner_session, owner_thread,
             project_root, worktree, created_at, last_used_at, last_action)
           VALUES (?, 'token', ?, 'session', NULL, NULL, 's', NULL, '/w', '/w', 0, 0, 'up')`,
        )
        .run(id, `owner-${id}`);
    });
  } finally {
    store.close();
  }
  const lane = path.join(lanesRoot(dir), id);
  fs.mkdirSync(path.join(lane, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(lane, 'bin', 'maestro'),
    maestroShim({
      maestro: binary,
      device: 'UDID',
      laneId: id,
      evidence: path.join(lane, 'evidence'),
      runs: path.join(lane, 'runs'),
    }),
    { mode: 0o755 },
  );
  return {
    end: () => {
      const ending = Store.open(dir, 5000);
      try {
        ending.write(() => {
          ending.db.prepare('DELETE FROM claims WHERE id = ?').run(id);
        });
      } finally {
        ending.close();
      }
    },
  };
}

for (const registry of [TOOL, FORMER.tool]) {
  test(`a build a lane recorded in the ${registry} registry runs is kept with no process running it, until the lane ends`, async () => {
    const { root, env } = world();
    const older = build(root, undefined, OLDER);
    const a = await ensureMaestro({ env, release: older.release, download: serving(older.dir), commandLines: nobodyRunning });
    const lane = laneUp(path.join(root, 'state', registry), '0a1b2c3d', a.binary);
    const shim = path.join(lanesRoot(path.join(root, 'state', registry)), '0a1b2c3d', 'bin', 'maestro');
    const current = build(root);
    const lines: string[] = [];
    await ensureMaestro({
      env,
      release: current.release,
      download: serving(current.dir),
      commandLines: nobodyRunning,
      log: line => lines.push(line),
    });
    assert.equal(installedMaestro(env, older.release)?.binary, a.binary, lines.join('\n'));
    assert.ok(lines.includes(`kept ${a.home}, which a lane that is up runs`), lines.join('\n'));
    assert.equal(execFileSync(shim, ['--version'], { encoding: 'utf8' }).trim(), OLDER);

    lane.end();
    const later = build(path.join(root, 'later'), undefined, NEWER);
    await ensureMaestro({ env, release: later.release, download: serving(later.dir), commandLines: nobodyRunning });
    assert.equal(fs.existsSync(a.home), false, 'once the lane has ended the next install removes the build');
  });
}

test('a registry that cannot be read keeps every build', async () => {
  const { root, env } = world();
  const older = build(root, undefined, OLDER);
  const a = await ensureMaestro({ env, release: older.release, download: serving(older.dir), commandLines: nobodyRunning });
  fs.mkdirSync(path.join(root, 'state', FORMER.tool), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', FORMER.tool, 'registry.sqlite'), 'not a database');
  const current = build(root);
  const lines: string[] = [];
  await ensureMaestro({
    env,
    release: current.release,
    download: serving(current.dir),
    commandLines: nobodyRunning,
    log: line => lines.push(line),
  });
  assert.equal(installedMaestro(env, older.release)?.binary, a.binary, lines.join('\n'));
  assert.match(lines.join('\n'), /a registry could not say whether a lane uses them/);
});

test('an install removes a build of the former name and keeps a later build, across the two names', async () => {
  const { root, env } = world();
  const homes = new Map<string, string>();
  for (const version of ['9.9.9-agentenv.3', '9.9.9-agentlane.2']) {
    const served = build(path.join(root, version), undefined, version);
    homes.set(
      version,
      (await ensureMaestro({ env, release: served.release, download: serving(served.dir), commandLines: () => undefined })).home,
    );
  }
  const current = build(path.join(root, 'current'), undefined, '9.9.9-agentlane.1');
  await ensureMaestro({ env, release: current.release, download: serving(current.dir), commandLines: nobodyRunning });
  assert.equal(fs.existsSync(homes.get('9.9.9-agentenv.3') ?? ''), false);
  assert.equal(fs.existsSync(homes.get('9.9.9-agentlane.2') ?? ''), true);
});

test('AGENTLANE_JAVA_HOME names the JDK 17 ahead of a JAVA_HOME of another version, and one of another version is refused', async () => {
  const root = fs.realpathSync(tempDir('jdk'));
  const jdk17 = fakeJdk(root);
  const jdk21 = fakeJdk(root, '21');
  const found = await findJdk17({ AGENTLANE_JAVA_HOME: jdk17, JAVA_HOME: jdk21 });
  assert.equal(found.javaHome, path.join(root, 'jdk-17'));
  assert.equal(found.origin, `AGENTLANE_JAVA_HOME=${jdk17}`);
  await assert.rejects(findJdk17({ AGENTLANE_JAVA_HOME: jdk21, JAVA_HOME: jdk17 }, finding(jdk17)), (error: unknown) => {
    assert.ok(error instanceof DriverError);
    assert.match(error.message, /^AGENTLANE_JAVA_HOME=.* is Java 21, and Maestro runs on JDK 17/);
    assert.match(error.fix, /set AGENTLANE_JAVA_HOME to a JDK 17 home/);
    return true;
  });
});

test('a JAVA_HOME of another version or with no java is passed over, and named when no JDK 17 is found', async () => {
  const root = fs.realpathSync(tempDir('jdk'));
  const jdk17 = fakeJdk(root);
  const jdk21 = fakeJdk(root, '21');
  assert.equal((await findJdk17({ JAVA_HOME: jdk17 }, noJdk17)).javaHome, jdk17);
  assert.deepEqual(await findJdk17({ JAVA_HOME: jdk21 }, finding(jdk17)), { javaHome: jdk17, origin: `the search's ${jdk17}` });
  await assert.rejects(findJdk17({ JAVA_HOME: jdk21 }, noJdk17), (error: unknown) => {
    assert.ok(error instanceof DriverError);
    assert.equal(error.message.split('\n')[0], `no JDK 17 found (JAVA_HOME=${jdk21} is Java 21); Maestro runs on JDK 17`);
    assert.match(error.fix, /brew install openjdk@17/);
    return true;
  });
  await assert.rejects(
    findJdk17({ JAVA_HOME: path.join(root, 'nothing') }, finding(jdk21)),
    /the search's .*jdk-21 is Java 21 \(JAVA_HOME=.*nothing has no working bin\/java\), and Maestro runs on JDK 17\n/,
  );
  const { env } = world();
  const { release, dir } = build(root);
  await assert.rejects(
    ensureMaestro({
      env: { ...env, JAVA_HOME: path.join(root, 'nothing') },
      release,
      download: serving(dir),
      searchJdk17: noJdk17,
    }),
    /no JDK 17 found \(JAVA_HOME=.*nothing has no working bin\/java\)/,
  );
});

/** A java_home that, like macOS's, prints the default JDK when no JDK 17 is registered, unless it is passed -F. */
function fakeJavaHome(root: string, registered: string | null, fallback: string): string {
  const tool = path.join(root, `java_home-${registered === null ? 'none' : 'jdk17'}`);
  const none = `echo 'Unable to find any JVMs matching version "17".' >&2\ncase " $* " in *" -F "*) exit 1 ;; esac\necho "${fallback}"`;
  fs.writeFileSync(tool, `#!/bin/sh\n${registered === null ? none : `echo "${registered}"`}\n`, { mode: 0o755 });
  return tool;
}

test('a JDK 17 macOS has registered is found, and with none registered the default JDK java_home falls back to is not', async () => {
  const root = fs.realpathSync(tempDir('java-home'));
  try {
    const jdk17 = fakeJdk(root);
    const jdk21 = fakeJdk(root, '21');
    assert.equal(await registeredJdk17(fakeJavaHome(root, jdk17, jdk21)), jdk17);
    assert.equal(await registeredJdk17(fakeJavaHome(root, null, jdk21)), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('maestro/build.sh takes Homebrew’s JDK 17 when macOS has none registered, not the default JDK java_home falls back to', () => {
  const root = fs.realpathSync(tempDir('build-jdk'));
  try {
    const jdk = (name: string, spec: string) => {
      const home = path.join(root, name);
      fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
      const java = `#!/bin/sh\necho "    java.specification.version = ${spec}" >&2\necho "    java.home = ${home}" >&2\n`;
      fs.writeFileSync(path.join(home, 'bin', 'java'), java, { mode: 0o755 });
      fs.writeFileSync(path.join(home, 'bin', 'javac'), '#!/bin/sh\n', { mode: 0o755 });
      return home;
    };
    const brew17 = jdk('brew-openjdk17', '17');
    const default21 = jdk('jdk-21', '21');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'brew'), `#!/bin/sh\necho "${brew17}"\n`, { mode: 0o755 });
    const script = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'maestro', 'build.sh'), 'utf8');
    const find = /^find_jdk17\(\) \{\n.*?\n\}\n/ms.exec(script)?.[0] ?? '';
    assert.ok(find.includes(JAVA_HOME_TOOL), 'build.sh asks java_home');
    const run = `set -euo pipefail\ndie() { echo "die: $*"; exit 1; }\n${find.replaceAll(JAVA_HOME_TOOL, fakeJavaHome(root, null, default21))}find_jdk17\necho "$JAVA_HOME from $java_origin"\n`;
    const found = execFileSync('bash', ['-c', run], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root },
    });
    assert.equal(found.trim(), `${brew17} from Homebrew's openjdk@17 (${brew17})`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor names the Maestro the driver runs, and a local build reads as not the release', async () => {
  const root = tempDir('maestro-build');
  const distribution = (name: string, version: string | undefined) => {
    const home = path.join(root, name, 'maestro');
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(home, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(home, 'bin', 'maestro'), '#!/bin/sh\n', { mode: 0o755 });
    if (version !== undefined) {
      fs.writeFileSync(
        path.join(home, 'lib', 'maestro-cli-2.11.0.jar'),
        makeZip([
          { name: 'version.properties', data: `#Mon Oct 12 02:12:29 UTC 2026\nbuildVersion=${version}\nversion=2.11.0\n` },
        ]),
      );
    }
    return path.join(home, 'bin', 'maestro');
  };
  const local = distribution('local', '2.11.0-agentenv.1+local.f69cd6f');
  assert.equal(await distributionVersion(local), '2.11.0-agentenv.1+local.f69cd6f');
  const localBuild = await maestroBuild({ AGENTLANE_MAESTRO: local, XDG_DATA_HOME: root });
  assert.deepEqual(localBuild, {
    kind: 'override',
    binary: local,
    version: '2.11.0-agentenv.1+local.f69cd6f',
    local: true,
    release: MAESTRO_RELEASE.version,
  });
  assert.equal(
    describeMaestroBuild(localBuild),
    `NOT the release: a local build, 2.11.0-agentenv.1+local.f69cd6f, from AGENTLANE_MAESTRO=${local} (the release is ${MAESTRO_RELEASE.version})`,
  );

  const lookalike = distribution('lookalike', MAESTRO_RELEASE.version);
  assert.match(
    describeMaestroBuild(await maestroBuild({ AGENTLANE_MAESTRO: lookalike })),
    new RegExp(
      `^NOT the pinned install: .* says ${MAESTRO_RELEASE.version.replaceAll('.', '\\.')}, but nothing checked it against the release's sha256$`,
    ),
  );
  const unreadable = distribution('unreadable', undefined);
  assert.match(describeMaestroBuild(await maestroBuild({ AGENTLANE_MAESTRO: unreadable })), /^NOT the release: .*can't be read$/);

  const none = await maestroBuild({ XDG_DATA_HOME: path.join(root, 'empty') });
  assert.deepEqual(none, { kind: 'not-installed', version: MAESTRO_RELEASE.version });
  assert.ok(
    describeMaestroBuild(none).startsWith(`the pinned release ${MAESTRO_RELEASE.version}, not installed yet`),
    describeMaestroBuild(none),
  );
});

test('the driver starts on a JDK its caller already found, and searches for one only when given none', async () => {
  const root = fs.realpathSync(tempDir('jdk'));
  const found = fakeJdk(root);
  const target = {
    stateDir: root,
    lane: {} as Lane,
    env: { [MAESTRO_OVERRIDE_ENV]: '/fake/maestro', [JAVA_HOME_ENV]: path.join(root, 'nothing') },
  };
  assert.deepEqual(await resolveToolchain({ ...target, javaHome: found }), { maestro: '/fake/maestro', javaHome: found });
  await assert.rejects(resolveToolchain(target), /has no working bin\/java/);
});

test('the driver up starts and a later restart both run on JDK 17 when JAVA_HOME names another version', async () => {
  const root = fs.realpathSync(tempDir('jdk'));
  const jdk17 = fakeJdk(root);
  const target = {
    stateDir: root,
    lane: {} as Lane,
    env: { [MAESTRO_OVERRIDE_ENV]: '/fake/maestro', JAVA_HOME: fakeJdk(root, '21') },
    install: { searchJdk17: finding(jdk17) },
  };
  assert.equal((await resolveToolchain({ ...target, javaHome: jdk17 })).javaHome, jdk17);
  assert.equal((await resolveToolchain(target)).javaHome, jdk17);
});

test('a first-use install from a driver start runs on the JDK its caller found, not on JAVA_HOME', async () => {
  const root = fs.realpathSync(tempDir('jdk'));
  const jdk17 = fakeJdk(root);
  const { release, dir } = build(root);
  const toolchain = await resolveToolchain({
    stateDir: root,
    lane: {} as Lane,
    env: { PATH: process.env.PATH, HOME: root, XDG_DATA_HOME: path.join(root, 'data'), JAVA_HOME: fakeJdk(root, '21') },
    javaHome: jdk17,
    install: { release, download: serving(dir), searchJdk17: noJdk17 },
  });
  assert.deepEqual(toolchain, {
    maestro: path.join(root, 'data', 'agentlane', 'maestro', VERSION, 'maestro', 'bin', 'maestro'),
    javaHome: jdk17,
  });
});
