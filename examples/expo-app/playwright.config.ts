import { defineConfig, devices } from '@playwright/test';

import { OWN_LOGIN } from './web/tests/account';

const toolkitUrl = process.env.AGENTLANE_WEB_URL;
const toolkitLogin = process.env.AGENTLANE_STORAGE_STATE;
const evidence = process.env.AGENTLANE_EVIDENCE;
process.env.EXAMPLE_RUN_STAMP ??= new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d+Z$/, 'Z');
const ownWebPort = process.env.EXAMPLE_WEB_PORT;
const chrome = devices['Desktop Chrome'];

export default defineConfig({
  testDir: 'web/tests',
  outputDir: evidence ? `${evidence}/${process.env.EXAMPLE_RUN_STAMP}-playwright-test` : 'web/test-results',
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL ?? (ownWebPort ? `http://127.0.0.1:${ownWebPort}/` : undefined),
    trace: 'retain-on-failure',
  },
  projects: [
    ...(toolkitLogin ? [] : [{ name: 'sign-in', testMatch: /signin\.setup\.ts/, use: chrome }]),
    { name: 'signed-out', testMatch: /signed-out\.spec\.ts/, use: chrome },
    {
      name: 'signed-in',
      testMatch: /signed-in\.spec\.ts/,
      dependencies: toolkitLogin ? [] : ['sign-in'],
      use: { ...chrome, storageState: toolkitLogin ?? OWN_LOGIN },
    },
  ],
  webServer: toolkitUrl
    ? undefined
    : [
        {
          name: 'api',
          command: 'node api/server.mjs',
          env: { PORT: '0', DATABASE_PATH: ':memory:' },
          wait: { stdout: /listening on http:\/\/127\.0\.0\.1:(?<example_api_port>\d+)/ },
          gracefulShutdown: { signal: 'SIGTERM', timeout: 2000 },
        },
        {
          name: 'web',
          command:
            'API_URL="http://127.0.0.1:$EXAMPLE_API_PORT" exec node_modules/.bin/vite web --port 0 --strictPort --host 127.0.0.1',
          wait: { stdout: /http:\/\/127\.0\.0\.1:(?:\x1b\[\d+m)?(?<example_web_port>\d+)/ },
          gracefulShutdown: { signal: 'SIGTERM', timeout: 2000 },
        },
      ],
});
