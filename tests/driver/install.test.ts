import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DriverError } from '../../src/driver/errors.ts';
import {
  distributionVersion,
  ensureMaestro,
  findJdk17,
  installedMaestro,
  maestroBuild,
  maestroHome,
  type Downloader,
} from '../../src/driver/install.ts';
import { describeMaestroBuild } from '../../src/up/doctor.ts';
import { MAESTRO_RELEASE, type MaestroRelease } from '../../src/driver/release.ts';
import { tempDir } from '../support/fakes.ts';
import { makeZip } from '../support/zip.ts';

const VERSION = '9.9.9-agentenv.test';

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

function build(root: string, printed = VERSION): { zip: Buffer; release: MaestroRelease; dir: string } {
  const zip = makeZip([
    { name: 'maestro/bin/maestro', data: `#!/bin/sh\necho "${printed}"\n`, mode: 0o100755 },
    { name: 'maestro/lib/maestro.jar', data: 'jar' },
    { name: 'maestro/NOTICE', data: 'notice' },
  ]);
  const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
  const release: MaestroRelease = {
    ...MAESTRO_RELEASE,
    version: VERSION,
    asset: `maestro-${VERSION}.zip`,
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

test('JDK 17 is required: a JAVA_HOME of another version or with no java is refused, naming the fix', async () => {
  const root = fs.realpathSync(tempDir('jdk'));
  assert.equal((await findJdk17({ JAVA_HOME: fakeJdk(root) })).javaHome, path.join(root, 'jdk-17'));
  await assert.rejects(findJdk17({ JAVA_HOME: fakeJdk(root, '21') }), (error: unknown) => {
    assert.ok(error instanceof DriverError);
    assert.match(error.message, /is Java 21, and Maestro runs on JDK 17/);
    assert.match(error.fix, /brew install openjdk@17/);
    return true;
  });
  await assert.rejects(findJdk17({ JAVA_HOME: path.join(root, 'nothing') }), /has no working bin\/java/);
  const { env } = world();
  const { release, dir } = build(root);
  await assert.rejects(
    ensureMaestro({ env: { ...env, JAVA_HOME: path.join(root, 'nothing') }, release, download: serving(dir) }),
    /bin\/java/,
  );
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
