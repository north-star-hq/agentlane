import { writeFileSync } from 'node:fs';

import { TEST_ACCOUNT } from '../api/database.mjs';

if (process.env.AGENTLANE_PLATFORM !== 'web') {
  console.log('the mobile app has no sign-in');
  process.exit(0);
}

const webUrl = process.env.AGENTLANE_WEB_URL;
const storageState = process.env.AGENTLANE_STORAGE_STATE;
if (!webUrl || !storageState) {
  console.error('AGENTLANE_WEB_URL and AGENTLANE_STORAGE_STATE must be set; agentlane up sets both for the signin hook');
  process.exit(2);
}

const url = new URL(webUrl);
const response = await fetch(new URL('api/session', url), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: TEST_ACCOUNT.email, password: TEST_ACCOUNT.password }),
});
const token = /(?:^|;\s*)session=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
if (!response.ok || !token) {
  console.error(`signing in as ${TEST_ACCOUNT.email} failed: HTTP ${response.status}`);
  process.exit(1);
}

writeFileSync(
  storageState,
  JSON.stringify({
    cookies: [
      {
        name: 'session',
        value: token,
        domain: url.hostname,
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ],
    origins: [],
  }),
  { mode: 0o600 },
);
console.log(`signed in as ${TEST_ACCOUNT.email}`);
