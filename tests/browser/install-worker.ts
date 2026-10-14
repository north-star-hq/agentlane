import fs from 'node:fs';
import path from 'node:path';
import { ensureBrowserDriver } from '../../src/browser/install.ts';
import type { AgentBrowserRelease, PlaywrightRelease } from '../../src/browser/release.ts';

const [setup, log] = process.argv.slice(2);
if (setup === undefined || log === undefined) throw new Error('usage: install-worker <setup.json> <log>');
const { env, playwright, agentBrowser, host, served } = JSON.parse(fs.readFileSync(setup, 'utf8')) as {
  env: NodeJS.ProcessEnv;
  playwright: PlaywrightRelease;
  agentBrowser: AgentBrowserRelease;
  host: string;
  served: string;
};
const note = (line: string) => {
  fs.appendFileSync(log, `${String(process.pid)} ${line}\n`);
};
const installed = await ensureBrowserDriver('playwright', {
  env,
  playwright,
  agentBrowser,
  host,
  lockWaitMs: 60_000,
  log: note,
  fetch: async (url, file) => {
    note(`fetch ${path.basename(url)}`);
    await new Promise(resolve => setTimeout(resolve, 300));
    fs.copyFileSync(path.join(served, path.basename(url)), file);
  },
});
note(`done ${installed.chrome}`);
