import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { missingLibraries, notFound, systemLdd, type Ldd } from '../../src/browser/libraries.ts';

const LDD_CHROME_ON_BARE_DEBIAN = `\tlinux-vdso.so.1 (0x0000ffff8f5d0000)
\tlibdl.so.2 => /lib/aarch64-linux-gnu/libdl.so.2 (0x0000ffff8f580000)
\tlibnss3.so => not found
\tlibnssutil3.so => not found
\tlibglib-2.0.so.0 => /lib/aarch64-linux-gnu/libglib-2.0.so.0 (0x0000ffff8f400000)
\tlibatk-1.0.so.0 => not found
\tlibasound.so.2 => not found
\t/lib/ld-linux-aarch64.so.1 (0x0000ffff8f593000)
`;

function browserFolder(t: { after: (fn: () => void) => void }): { chrome: string; shell: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlane-libraries-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const dir of ['chrome-linux-arm64', 'chrome-headless-shell-linux-arm64']) fs.mkdirSync(path.join(root, dir));
  const chrome = path.join(root, 'chrome-linux-arm64', 'chrome');
  const shell = path.join(root, 'chrome-headless-shell-linux-arm64', 'chrome-headless-shell');
  for (const file of [chrome, shell, path.join(root, 'chrome-linux-arm64', 'libvulkan.so.1')]) fs.writeFileSync(file, '');
  fs.writeFileSync(path.join(root, 'chrome-linux-arm64', 'chrome_100_percent.pak'), '');
  return { chrome, shell };
}

test('notFound names each library ldd could not resolve, and nothing ldd resolved', () => {
  assert.deepEqual(notFound(LDD_CHROME_ON_BARE_DEBIAN), ['libnss3.so', 'libnssutil3.so', 'libatk-1.0.so.0', 'libasound.so.2']);
  assert.deepEqual(notFound(LDD_CHROME_ON_BARE_DEBIAN.replaceAll(/=> not found/g, '=> /usr/lib/x.so (0x1)')), []);
});

test('missingLibraries checks each browser and the shared libraries beside it, with its own folder on the library path', async t => {
  const { chrome, shell } = browserFolder(t);
  const asked: string[] = [];
  const ldd: Ldd = (file, libraryPath) => {
    asked.push(`${path.basename(file)} ${libraryPath.map(p => path.basename(p)).join(':')}`);
    if (file === chrome) return Promise.resolve(LDD_CHROME_ON_BARE_DEBIAN);
    if (file === shell) return Promise.resolve('\tlibnss3.so => not found\n\tlibgbm.so.1 => not found\n');
    return Promise.resolve('\tlibX11.so.6 => not found\n');
  };
  assert.deepEqual(await missingLibraries([chrome, shell, ''], ldd), [
    'libX11.so.6',
    'libasound.so.2',
    'libatk-1.0.so.0',
    'libgbm.so.1',
    'libnss3.so',
    'libnssutil3.so',
  ]);
  assert.deepEqual(asked.sort(), [
    'chrome chrome-linux-arm64',
    'chrome-headless-shell chrome-headless-shell-linux-arm64',
    'libvulkan.so.1 chrome-linux-arm64',
  ]);
});

test('missingLibraries is empty when every library resolves, and null when ldd cannot run or no browser is there', async t => {
  const { chrome, shell } = browserFolder(t);
  assert.deepEqual(await missingLibraries([chrome, shell], () => Promise.resolve('\tlibc.so.6 => /lib/libc.so.6 (0x1)\n')), []);
  assert.equal(await missingLibraries([chrome, shell], () => Promise.resolve(null)), null);
  assert.equal(await missingLibraries(['', `${chrome}-absent`], () => Promise.resolve('\tlibnss3.so => not found\n')), null);
});

test('the system ldd resolves every library node links', { skip: process.platform !== 'linux' && 'ldd is Linux’s' }, async () => {
  assert.deepEqual(await missingLibraries([process.execPath], systemLdd), []);
});
