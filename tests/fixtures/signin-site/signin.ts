import { writeFileSync } from 'node:fs';

const url = new URL(process.env.AGENTLANE_WEB_URL ?? '');
const user = process.env.SIGNIN_USER ?? `agent-${process.env.AGENTLANE_LANE ?? ''}`;
const response = await fetch(new URL('/login', url), {
  method: 'POST',
  body: new URLSearchParams({ user }),
  redirect: 'manual',
});
const sid = /sid=([0-9a-f]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
if (response.status !== 303 || sid === undefined) {
  console.error(`sign-in failed: HTTP ${String(response.status)}`);
  process.exit(1);
}
const state = {
  cookies: [
    { name: 'sid', value: sid, domain: url.hostname, path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' },
  ],
  origins: [],
};
writeFileSync(process.env.AGENTLANE_STORAGE_STATE ?? '', JSON.stringify(state));
console.log(`signed in as ${user}`);
