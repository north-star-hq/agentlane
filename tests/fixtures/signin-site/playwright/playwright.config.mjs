import { defineConfig } from '@playwright/test';

const evidence = process.env.AGENTLANE_EVIDENCE;
process.env.FIXTURE_RUN_STAMP ??= new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d+Z$/, 'Z');

export default defineConfig({
  testDir: '.',
  outputDir: evidence ? `${evidence}/${process.env.FIXTURE_RUN_STAMP}-playwright-test` : 'test-results',
  reporter: 'list',
  use: {
    storageState: process.env.AGENTLANE_STORAGE_STATE,
    trace: 'retain-on-failure',
  },
});
