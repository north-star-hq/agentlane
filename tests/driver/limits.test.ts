import assert from 'node:assert/strict';
import { test } from 'node:test';
import { responseTimeoutMs } from '../../src/driver/client.ts';
import { longestIosCallMs, warmCallMs } from '../../src/driver/supervisor.ts';

test("an emulator lane keeps the client's limits from before the runner's startup time", () => {
  assert.equal(responseTimeoutMs('look', 'android'), 150_000);
  assert.equal(responseTimeoutMs('screenshot', 'android'), 150_000);
  assert.equal(responseTimeoutMs('run', 'android'), 900_000);
});

test("a simulator run's limit covers a flow that loses Maestro between a first read and a first read after it", () => {
  const firstRead = longestIosCallMs('inspect_screen', { retry: true });
  const worst = firstRead + warmCallMs('run') + firstRead + warmCallMs('take_screenshot');
  assert.equal(worst, 1_620_000);
  assert.ok(responseTimeoutMs('run', 'ios') > worst, `run's limit is ${String(responseTimeoutMs('run', 'ios'))} ms`);
});

test('a simulator look and screenshot cover a first call retried on a fresh Maestro', () => {
  const look = longestIosCallMs('inspect_screen', { retry: true }) + warmCallMs('take_screenshot');
  const screenshot = longestIosCallMs('take_screenshot', { retry: true }) + warmCallMs('inspect_screen');
  assert.ok(responseTimeoutMs('look', 'ios') > look);
  assert.ok(responseTimeoutMs('screenshot', 'ios') > screenshot);
});
