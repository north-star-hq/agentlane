import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  androidToolchain,
  CacheKeyError,
  cacheDirFor,
  computeKey,
  xcodeVersion,
  type CacheInput,
  type KeyOptions,
} from '../../src/cache/index.ts';
import { androidBuildEnvironment, systemToolchain } from '../../src/up/preflight.ts';
import { git, tempDir, writeFiles } from './helpers.ts';

const PODFILE_LOCK = `PODS:
  - hermes-engine (0.85.0)
  - React-Core (0.85.0)

EXTERNAL SOURCES:
  hermes-engine:
    :podspec: "../node_modules/react-native/sdks/hermes-engine/hermes-engine.podspec"

SPEC CHECKSUMS:
  hermes-engine: 683e3bc38d9b55846ce953470a18c9069ecbd410
  React-Core: 1111111111111111111111111111111111111111
  React-Core-prebuilt: 4cf2ae1dc0fee466834afd67ae5e7c463ae6f968
  ReactNativeDependencies: bfcc3902643f8a8ca815ad02064f642a9b489bc8

COCOAPODS: 1.16.2
`;

const INPUTS: CacheInput[] = [
  { kind: 'files', paths: ['app/ios', 'app/modules', 'app/package.json', '**/*.podspec'], exclude: ['app/ios/Podfile.lock'] },
  {
    kind: 'command',
    run: "grep -Ev '^  (hermes-engine|React-Core-prebuilt|ReactNativeDependencies): [0-9a-f]+$' app/ios/Podfile.lock",
  },
];

function repoWithWorktree(t: TestContext): { main: string; second: string } {
  const base = tempDir(t);
  const main = path.join(base, 'main');
  fs.mkdirSync(main);
  git(main, 'init', '-q');
  writeFiles(main, {
    '.gitignore': '.env\nbuild/\n',
    'app/ios/AppDelegate.swift': 'class AppDelegate {}\n',
    'app/ios/Podfile.lock': PODFILE_LOCK,
    'app/modules/glass/ios/Glass.swift': 'struct Glass {}\n',
    'app/modules/glass/Glass.podspec': 'Pod::Spec.new\n',
    'vendor/Extra.podspec': 'Pod::Spec.new\n',
    'app/package.json': '{"name":"app"}\n',
    'app/src/App.tsx': 'export const App = 1;\n',
    'README.md': '# readme\n',
  });
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');
  const second = path.join(base, 'second');
  git(main, 'worktree', 'add', '-q', second);
  for (const root of [main, second]) writeFiles(root, { '.env': 'API_URL=http://localhost:8080\n' });
  return { main, second };
}

function options(root: string, overrides: Partial<KeyOptions> = {}): KeyOptions {
  return {
    root,
    inputs: INPUTS,
    platform: 'ios',
    variant: 'Debug',
    toolchain: 'Xcode 26.6 Build version 17F42',
    envFile: '.env',
    ...overrides,
  };
}

test('two worktrees of one repo with the same inputs get the same key and share one cache dir', async t => {
  const { main, second } = repoWithWorktree(t);
  const key = await computeKey(options(main));
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(await computeKey(options(second)), key);
  const mainDir = await cacheDirFor(main);
  assert.equal(await cacheDirFor(second), mainDir);
  assert.equal(mainDir, path.join(main, '.git', 'agentlane', 'build-cache'));
});

test('each declared input moves the key and undeclared changes do not', async t => {
  const { main, second } = repoWithWorktree(t);
  const base = await computeKey(options(main));
  const lock = path.join(second, 'app/ios/Podfile.lock');
  const cases: { name: string; moves: boolean; apply: () => void; revert: () => void; with?: Partial<KeyOptions> }[] = [
    {
      name: 'a declared file changes',
      moves: true,
      apply: () => {
        fs.appendFileSync(path.join(second, 'app/ios/AppDelegate.swift'), '// changed\n');
      },
      revert: () => git(second, 'checkout', '--', 'app/ios/AppDelegate.swift'),
    },
    {
      name: 'a declared glob match changes',
      moves: true,
      apply: () => {
        fs.appendFileSync(path.join(second, 'vendor/Extra.podspec'), '# changed\n');
      },
      revert: () => git(second, 'checkout', '--', 'vendor/Extra.podspec'),
    },
    {
      name: 'an untracked file appears under a declared directory',
      moves: true,
      apply: () => {
        writeFiles(second, { 'app/modules/glass/ios/New.swift': 'struct New {}\n' });
      },
      revert: () => {
        fs.rmSync(path.join(second, 'app/modules/glass/ios/New.swift'));
      },
    },
    {
      name: 'a declared file is deleted',
      moves: true,
      apply: () => {
        fs.rmSync(path.join(second, 'app/package.json'));
      },
      revert: () => git(second, 'checkout', '--', 'app/package.json'),
    },
    {
      name: "a declared file's executable bit flips",
      moves: true,
      apply: () => {
        fs.chmodSync(path.join(second, 'app/ios/AppDelegate.swift'), 0o755);
      },
      revert: () => {
        fs.chmodSync(path.join(second, 'app/ios/AppDelegate.swift'), 0o644);
      },
    },
    {
      name: "a command input's output changes",
      moves: true,
      apply: () => {
        fs.writeFileSync(lock, PODFILE_LOCK.replace('React-Core: 1111', 'React-Core: 2222'));
      },
      revert: () => git(second, 'checkout', '--', 'app/ios/Podfile.lock'),
    },
    {
      name: "the env file's contents change",
      moves: true,
      apply: () => {
        writeFiles(second, { '.env': 'API_URL=http://localhost:9090\n' });
      },
      revert: () => {
        writeFiles(second, { '.env': 'API_URL=http://localhost:8080\n' });
      },
    },
    {
      name: 'the env file is missing',
      moves: true,
      apply: () => {
        fs.rmSync(path.join(second, '.env'));
      },
      revert: () => {
        writeFiles(second, { '.env': 'API_URL=http://localhost:8080\n' });
      },
    },
    {
      name: 'the Xcode version changes',
      moves: true,
      apply: () => undefined,
      revert: () => undefined,
      with: { toolchain: 'Xcode 26.7' },
    },
    { name: 'the variant changes', moves: true, apply: () => undefined, revert: () => undefined, with: { variant: 'Release' } },
    { name: 'the platform changes', moves: true, apply: () => undefined, revert: () => undefined, with: { platform: 'android' } },
    {
      name: 'only the filtered checksum lines change',
      moves: false,
      apply: () => {
        fs.writeFileSync(
          lock,
          PODFILE_LOCK.replace('hermes-engine: 683e', 'hermes-engine: 999e').replace('Dependencies: bfcc', 'Dependencies: 0000'),
        );
      },
      revert: () => git(second, 'checkout', '--', 'app/ios/Podfile.lock'),
    },
    {
      name: 'an undeclared file changes',
      moves: false,
      apply: () => {
        fs.appendFileSync(path.join(second, 'app/src/App.tsx'), 'export const B = 2;\n');
        fs.appendFileSync(path.join(second, 'README.md'), 'more\n');
      },
      revert: () => git(second, 'checkout', '--', 'app/src/App.tsx', 'README.md'),
    },
    {
      name: 'an ignored file appears under a declared directory',
      moves: false,
      apply: () => {
        writeFiles(second, { 'app/ios/build/Output.o': 'binary\n' });
      },
      revert: () => {
        fs.rmSync(path.join(second, 'app/ios/build'), { recursive: true });
      },
    },
  ];
  for (const c of cases) {
    c.apply();
    const key = await computeKey(options(second, c.with));
    c.revert();
    if (c.moves) assert.notEqual(key, base, `${c.name} should change the key`);
    else assert.equal(key, base, `${c.name} should leave the key alone`);
    assert.equal(await computeKey(options(second)), base, `reverting "${c.name}" should restore the key`);
  }
});

test('a failing command input refuses to produce a key', async t => {
  const { main } = repoWithWorktree(t);
  await assert.rejects(
    computeKey(options(main, { inputs: [{ kind: 'command', run: 'echo partial; echo broken >&2; exit 3' }] })),
    (error: unknown) =>
      error instanceof CacheKeyError && error.message.includes('exit code 3') && error.message.includes('broken'),
  );
});

test("an input scoped to one platform enters only that platform's key and never runs for another", async t => {
  const { main } = repoWithWorktree(t);
  const iosOnly: CacheInput = { kind: 'command', run: 'echo ran >> ios-probe.log; pod-like-tool --version', platforms: ['ios'] };
  const android = await computeKey(options(main, { platform: 'android', inputs: [...INPUTS, iosOnly] }));
  assert.equal(android, await computeKey(options(main, { platform: 'android' })));
  assert.equal(fs.existsSync(path.join(main, 'ios-probe.log')), false, 'the iOS-only command ran for android');
  await assert.rejects(
    computeKey(options(main, { inputs: [...INPUTS, iosOnly] })),
    (error: unknown) => error instanceof CacheKeyError && error.message.includes('pod-like-tool'),
  );
  assert.equal(fs.readFileSync(path.join(main, 'ios-probe.log'), 'utf8'), 'ran\n');
});

test('command inputs run with the environment they are given', async t => {
  const { main } = repoWithWorktree(t);
  const input: CacheInput = { kind: 'command', run: 'printf %s "$AGENTLANE_PLATFORM"' };
  const withIos = await computeKey(
    options(main, { inputs: [input], env: { PATH: process.env.PATH, AGENTLANE_PLATFORM: 'ios' } }),
  );
  const withOther = await computeKey(
    options(main, { inputs: [input], env: { PATH: process.env.PATH, AGENTLANE_PLATFORM: 'other' } }),
  );
  assert.notEqual(withIos, withOther);
});

test('xcodeVersion joins the lines xcodebuild -version prints', async t => {
  const bin = tempDir(t);
  fs.writeFileSync(path.join(bin, 'xcodebuild'), '#!/bin/sh\nprintf "Xcode 26.6\\nBuild version 17F42\\n"\n', { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
  t.after(() => {
    process.env.PATH = savedPath;
  });
  assert.equal(await xcodeVersion(), 'Xcode 26.6 Build version 17F42');
});

function androidMachine(t: TestContext): { javaHome: string; sdkRoot: string } {
  const machine = tempDir(t);
  const javaHome = path.join(machine, 'jdk');
  fs.mkdirSync(path.join(javaHome, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(javaHome, 'bin', 'java'),
    '#!/bin/sh\nprintf \'openjdk version "17.0.20" 2026-07-21\\nOpenJDK Runtime Environment Homebrew (build 17.0.20+0)\\n\' >&2\n',
    { mode: 0o755 },
  );
  const sdkRoot = path.join(machine, 'sdk');
  writeFiles(sdkRoot, {
    'build-tools/36.0.0/source.properties': 'Pkg.Desc=Android SDK Build-Tools 36\nPkg.Revision=36.0.0\n',
    'platforms/android-36/source.properties': 'Pkg.Desc=Android SDK Platform 36\nPkg.Revision=2\n',
    'ndk/27.1.12297006/source.properties': 'Pkg.Desc = Android NDK\nPkg.Revision = 27.1.12297006\n',
    'platform-tools/source.properties': 'Pkg.Revision=36.0.0\n',
  });
  return { javaHome, sdkRoot };
}

test('the Android toolchain names the JDK, the SDK packages a build uses, and a generated Gradle wrapper as such', async t => {
  const { main } = repoWithWorktree(t);
  writeFiles(main, { '.gitignore': '.env\nbuild/\n/android\n' });
  writeFiles(main, { 'android/gradle/wrapper/gradle-wrapper.properties': 'distributionUrl=gradle-8.13-bin.zip\n' });
  const machine = androidMachine(t);
  assert.equal(
    await androidToolchain({ root: main, ...machine }),
    'jdk openjdk version "17.0.20" 2026-07-21 OpenJDK Runtime Environment Homebrew (build 17.0.20+0); ' +
      'gradle generated by the build; ' +
      'sdk build-tools/36.0.0 36.0.0, platforms/android-36 2, ndk/27.1.12297006 27.1.12297006',
  );
});

test('the Android toolchain changes with the Gradle wrapper a project tracks and with an SDK package updated in place', async t => {
  const { main } = repoWithWorktree(t);
  const wrapper = 'android/gradle/wrapper/gradle-wrapper.properties';
  writeFiles(main, {
    [wrapper]: 'distributionBase=GRADLE_USER_HOME\ndistributionUrl=https\\://services.gradle.org/gradle-8.13-bin.zip\n',
  });
  git(main, 'add', wrapper);
  const machine = androidMachine(t);
  const before = await androidToolchain({ root: main, ...machine });
  assert.match(before, /; gradle https\\:\/\/services\.gradle\.org\/gradle-8\.13-bin\.zip;/);

  writeFiles(main, { [wrapper]: 'distributionUrl=https\\://services.gradle.org/gradle-8.14-bin.zip\n' });
  const newerGradle = await androidToolchain({ root: main, ...machine });
  assert.notEqual(newerGradle, before);

  writeFiles(machine.sdkRoot, { 'platforms/android-36/source.properties': 'Pkg.Revision=3\n' });
  const newerPlatform = await androidToolchain({ root: main, ...machine });
  assert.match(newerPlatform, /platforms\/android-36 3/);
  assert.notEqual(newerPlatform, newerGradle);
});

test('an Android build runs with JAVA_HOME at the JDK its key names: the one found, else the one the caller names', async t => {
  const { main } = repoWithWorktree(t);
  const machine = androidMachine(t);
  writeFiles(machine.sdkRoot, { 'platform-tools/adb': '', 'emulator/emulator': '' });
  const pinned = path.join(tempDir(t), 'jdk');
  fs.mkdirSync(path.join(pinned, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pinned, 'bin', 'java'), '#!/bin/sh\nprintf \'openjdk version "17.0.9"\\n\' >&2\n', { mode: 0o755 });
  const found = { findJava17: () => Promise.resolve({ home: machine.javaHome, version: '17.0.20' }) };
  const cases = [
    { caller: {}, home: machine.javaHome, version: '17.0.20' },
    { caller: { JAVA_HOME: pinned }, home: pinned, version: '17.0.9' },
    { caller: { AGENTLANE_JAVA_HOME: pinned, JAVA_HOME: machine.javaHome }, home: pinned, version: '17.0.9' },
  ];
  for (const { caller, home, version } of cases) {
    const env = await androidBuildEnvironment({ ANDROID_HOME: machine.sdkRoot, ...caller }, found);
    assert.equal(env.JAVA_HOME, home, JSON.stringify(caller));
    assert.match(await systemToolchain.androidToolchain(main, env), new RegExp(`^jdk openjdk version "${version}"`));
  }
  assert.deepEqual(await androidBuildEnvironment({}, { findJava17: () => Promise.resolve(null) }), {});
});

test('the Android toolchain fails as a key error when the JDK does not run', async t => {
  const { main } = repoWithWorktree(t);
  const machine = androidMachine(t);
  await assert.rejects(
    androidToolchain({ root: main, sdkRoot: machine.sdkRoot, javaHome: path.join(machine.javaHome, 'missing') }),
    (error: unknown) => error instanceof CacheKeyError && error.message.includes('bin/java -version failed'),
  );
});
