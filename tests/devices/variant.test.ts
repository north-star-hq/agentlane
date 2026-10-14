import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { judgeIosVariant, parseDebuggable, readIosBundle } from '../../src/devices/variant.ts';

function bundle(t: TestContext, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'variant-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dir = path.join(root, 'Shop.app');
  fs.mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test('an iOS bundle with a debug dylib reads as Debug, one that embeds main.jsbundle without it as Release', t => {
  const debug = readIosBundle(bundle(t, { Shop: 'x', 'Shop.debug.dylib': '', '__preview.dylib': '' }));
  assert.deepEqual(judgeIosVariant(debug, 'Debug', undefined), { ok: true, detail: 'Debug: it has Shop.debug.dylib' });
  const release = readIosBundle(bundle(t, { Shop: 'y', 'main.jsbundle': '' }));
  assert.deepEqual(judgeIosVariant(release, 'Debug', undefined), {
    ok: false,
    detail: 'Release, not the Debug build up makes: it embeds main.jsbundle and has no Shop.debug.dylib',
  });
  assert.equal(judgeIosVariant(release, 'Release', undefined).ok, true);
});

test("the executable comes from Info.plist's CFBundleExecutable, and its hash proves the build up installed", t => {
  const app = bundle(t, {
    'Info.plist': '<plist><dict><key>CFBundleExecutable</key><string>Main</string></dict></plist>',
    Main: 'binary',
    'Main.debug.dylib': '',
  });
  const facts = readIosBundle(app);
  assert.equal(facts.executable, 'Main');
  assert.equal(facts.debugDylib, true);
  assert.ok(facts.sha256);
  assert.equal(judgeIosVariant(facts, 'Debug', { variant: 'Debug', sha256: facts.sha256 }).ok, true);
  const other = judgeIosVariant(facts, 'Debug', { variant: 'Debug', sha256: '0'.repeat(64) });
  assert.equal(other.ok, false);
  assert.match(
    other.detail,
    /^not the Debug build up installed: Main has sha256 \w{12}, not 000000000000, and it reads as Debug/,
  );
});

test('dumpsys flags say whether an Android package is debuggable', () => {
  assert.equal(parseDebuggable('  Package [com.x] (abc):\n    flags=[ DEBUGGABLE HAS_CODE ALLOW_CLEAR_USER_DATA ]\n'), true);
  assert.equal(parseDebuggable('    flags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ]\n'), false);
  assert.equal(parseDebuggable('Unable to find package: com.x\n'), undefined);
});
