import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BuildCacheConfigError,
  buildCacheSchema,
  exampleBuildCacheConfig,
  parseBuildCacheConfig,
} from '../../src/cache/index.ts';

test('the example config parses to itself', () => {
  assert.deepEqual(parseBuildCacheConfig(structuredClone(exampleBuildCacheConfig)), exampleBuildCacheConfig);
});

test('platforms and envFile parse through', () => {
  const value = {
    inputs: [
      { kind: 'command', run: 'pod --version', platforms: ['ios'] },
      { kind: 'files', paths: ['android'], platforms: ['android'] },
    ],
    cacheableVariants: ['Debug'],
    envFile: '.env',
  };
  assert.deepEqual(parseBuildCacheConfig(structuredClone(value)), value);
});

test('the schema and the parser agree on the fields', () => {
  assert.deepEqual(Object.keys(buildCacheSchema.properties).sort(), [
    'cacheableVariants',
    'envFile',
    'inputs',
    'maxAgeDays',
    'maxEntries',
  ]);
  assert.deepEqual([...buildCacheSchema.required].sort(), ['cacheableVariants', 'inputs']);
  const [files, command] = buildCacheSchema.properties.inputs.items.oneOf;
  assert.deepEqual(Object.keys(files.properties).sort(), ['exclude', 'kind', 'paths', 'platforms']);
  assert.deepEqual(Object.keys(command.properties).sort(), ['kind', 'platforms', 'run']);
});

test('invalid configs are refused with the path of the bad field', () => {
  const cases: [unknown, RegExp][] = [
    [null, /^buildCache must be an object/],
    [{ cacheableVariants: ['Debug'] }, /buildCache\.inputs must be a list/],
    [{ inputs: [], cacheableVariants: [] }, /buildCache\.inputs must be a list with at least 1/],
    [{ inputs: [{ kind: 'files', paths: [] }], cacheableVariants: [] }, /inputs\[0\]\.paths/],
    [{ inputs: [{ kind: 'glob', paths: ['x'] }], cacheableVariants: [] }, /inputs\[0\]\.kind must be/],
    [{ inputs: [{ kind: 'command', run: '' }], cacheableVariants: [] }, /inputs\[0\]\.run/],
    [{ inputs: [{ kind: 'command', run: 'x', extra: 1 }], cacheableVariants: [] }, /unknown field\(s\): extra/],
    [{ inputs: [{ kind: 'command', run: 'x' }] }, /cacheableVariants/],
    [{ inputs: [{ kind: 'command', run: 'x' }], cacheableVariants: [], maxAgeDays: 0 }, /maxAgeDays/],
    [{ inputs: [{ kind: 'command', run: 'x' }], cacheableVariants: [], maxEntries: 1.5 }, /maxEntries/],
    [{ inputs: [{ kind: 'command', run: 'x' }], cacheableVariants: [], keep: 3 }, /unknown field\(s\): keep/],
    [{ inputs: [{ kind: 'command', run: 'x', platforms: [] }], cacheableVariants: [] }, /inputs\[0\]\.platforms/],
    [{ inputs: [{ kind: 'command', run: 'x', platforms: ['web'] }], cacheableVariants: [] }, /unknown platform\(s\): web/],
    [{ inputs: [{ kind: 'files', paths: ['a'], platforms: ['ios', 'ios'] }], cacheableVariants: [] }, /platform twice/],
    [{ inputs: [{ kind: 'command', run: 'x' }], cacheableVariants: [], envFile: '' }, /envFile/],
  ];
  for (const [value, message] of cases)
    assert.throws(
      () => parseBuildCacheConfig(value),
      (e: unknown) => e instanceof BuildCacheConfigError && message.test(e.message),
    );
});
