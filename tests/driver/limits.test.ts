import assert from 'node:assert/strict';
import { test } from 'node:test';
import { laneTimeoutMs, responseTimeoutMs } from '../../src/driver/client.ts';
import type { ClaimedDevice } from '../../src/registry/types.ts';
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

test("a lane's client waits for a look as long as its device's platform allows", () => {
  const device = (platform: ClaimedDevice['platform']): ClaimedDevice => ({
    platform,
    id: 'D1',
    name: 'Device',
    deviceType: 'type',
    deviceTypeName: 'Type',
    runtime: 'runtime',
    runtimeName: 'Runtime',
    serial: platform === 'android' ? 'emulator-5554' : null,
  });
  assert.equal(laneTimeoutMs({ device: device('android') }, 'look'), 150_000);
  assert.equal(laneTimeoutMs({ device: device('ios') }, 'look'), responseTimeoutMs('look', 'ios'));
  assert.notEqual(responseTimeoutMs('look', 'ios'), 150_000);
});
