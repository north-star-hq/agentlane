import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { acceptSavedLogin, describeSavedLogin, SignInFailed, storageStateProblems } from '../../src/browser/signin.ts';
import { tempDir } from '../support/fakes.ts';

const URL_ = 'http://localhost:41300/app';
const COOKIE = {
  name: 'sid',
  value: 'v-SECRET',
  domain: 'localhost',
  path: '/',
  expires: -1,
  httpOnly: true,
  secure: false,
  sameSite: 'Lax',
};

function written(content: string): string {
  const dir = tempDir('signin');
  const file = path.join(dir, 'signin.json');
  fs.writeFileSync(file, content, { mode: 0o644 });
  return file;
}

function failure(file: string, url: string | null = URL_): SignInFailed {
  try {
    acceptSavedLogin(file, url);
  } catch (error) {
    assert.ok(error instanceof SignInFailed, String(error));
    return error;
  }
  assert.fail('the saved login was accepted');
}

test('a saved login in storage-state format is accepted, made readable by its owner alone, and described without its values', () => {
  const file = written(
    JSON.stringify({
      cookies: [COOKIE, { ...COOKIE, name: 'pref', domain: '.localhost' }],
      origins: [{ origin: 'http://localhost:41300', localStorage: [{ name: 'token', value: 'ls-SECRET' }] }],
    }),
  );
  const login = acceptSavedLogin(file, URL_);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(login, { file, cookies: 2, domains: ['localhost', '.localhost'], origins: ['http://localhost:41300'] });
  const said = describeSavedLogin(login);
  assert.equal(said, '2 cookies for localhost, .localhost and local storage for http://localhost:41300');
  assert.equal(said.includes('SECRET'), false);
});

test('a login kept only in local storage for the app’s origin is accepted', () => {
  const file = written(JSON.stringify({ cookies: [], origins: [{ origin: 'http://localhost:41300', localStorage: [] }] }));
  assert.equal(acceptSavedLogin(file, URL_).cookies, 0);
});

test('each mistake a signin hook makes is named, field by field, and no value reaches the message', () => {
  const cases: [unknown, RegExp][] = [
    [[], /holds a list, not an object/],
    [{ origins: [] }, /"cookies" is missing; it must be a list/],
    [{ cookies: {}, origins: [] }, /"cookies" is a object|"cookies" is an? object/],
    [{ cookies: [{ ...COOKIE, expires: '2026' }], origins: [] }, /cookies\[0\]\.expires is text; it must be a Unix time/],
    [
      { cookies: [{ ...COOKIE, sameSite: 'lax' }], origins: [] },
      /cookies\[0\]\.sameSite is "lax"; Playwright takes "Strict", "Lax" or "None"/,
    ],
    [{ cookies: [{ ...COOKIE, httpOnly: undefined }], origins: [] }, /cookies\[0\]\.httpOnly is missing/],
    [
      { cookies: [], origins: [{ origin: 'http://localhost:41300/', localStorage: [] }] },
      /is not an origin: no path, no trailing slash/,
    ],
    [
      { cookies: [], origins: [{ origin: 'http://localhost:41300', localStorage: [{ name: 'a' }] }] },
      /localStorage\[0\] must be/,
    ],
    [{ cookies: [], origins: [] }, /holds no cookie and no origin/],
    [
      { cookies: [{ ...COOKIE, domain: 'example.com' }], origins: [] },
      /none of it applies to http:\/\/localhost:41300.*example\.com.*write cookies for localhost/,
    ],
  ];
  for (const [state, pattern] of cases) {
    const error = failure(written(JSON.stringify(state)));
    assert.match(error.message, pattern, JSON.stringify(state));
    assert.equal(error.message.includes('v-SECRET'), false, error.message);
    assert.match(error.message, /to fix: write the login there as Playwright's storage state/);
  }
});

test("a file that isn't JSON is refused by position, not by quoting it; a missing file names the variable", () => {
  const error = failure(written('{"cookies": [ {"value": "v-SECRET" oops'));
  assert.match(error.message, /it is not JSON \(at character \d+\)/);
  assert.equal(error.message.includes('SECRET'), false, error.message);
  const missing = failure(path.join(tempDir('signin'), 'absent.json'));
  assert.match(missing.message, /exited 0 without writing it \(\$AGENTLANE_STORAGE_STATE\)/);
});

test('without a web URL only the format is checked', () => {
  assert.deepEqual(storageStateProblems({ cookies: [{ ...COOKIE, domain: 'example.com' }], origins: [] }, null), []);
});
