import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  version: string;
  description: string;
  files: string[];
};
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');

test('the image is labelled with package.json’s version and description', () => {
  assert.equal(/^ARG VERSION=(.+)$/m.exec(DOCKERFILE)?.[1], PACKAGE.version);
  assert.equal(/org\.opencontainers\.image\.description="([^"]*)"/.exec(DOCKERFILE)?.[1], PACKAGE.description);
});

test('the build context lets in every file the published package holds but dist, which the image builds itself', () => {
  const allowed = fs
    .readFileSync(path.join(ROOT, '.dockerignore'), 'utf8')
    .split('\n')
    .filter(line => line.startsWith('!'))
    .map(line => line.slice(1).replace(/\/$/, ''));
  assert.ok(!allowed.includes('dist'), '.dockerignore keeps a local dist out of the build');
  for (const entry of PACKAGE.files.filter(f => f !== 'dist'))
    assert.ok(allowed.includes(entry), `.dockerignore lets in ${entry}`);
});
