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
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'docker.yml'), 'utf8');
const DOCS = fs.readFileSync(path.join(ROOT, 'site', 'docs', 'docker.md'), 'utf8');

test('the image is labelled with package.json’s description, and with the version its build is given', () => {
  assert.equal(/org\.opencontainers\.image\.description="([^"]*)"/.exec(DOCKERFILE)?.[1], PACKAGE.description);
  assert.match(DOCKERFILE, /^ARG VERSION$/m, 'a release bumps no version in the Dockerfile');
  assert.match(DOCKERFILE, /org\.opencontainers\.image\.version="\$\{VERSION\}"/);
  assert.match(WORKFLOW, /docker build --build-arg VERSION="\$\(node -p 'require\("\.\/package\.json"\)\.version'\)"/);
  assert.match(WORKFLOW, /build-args: VERSION=\$\{\{ inputs\.version \}\}/);
});

test('the docs page names the base image the Dockerfile pins', () => {
  const base = /^ARG NODE_IMAGE=([^@\s]+)@/m.exec(DOCKERFILE)?.[1];
  assert.ok(base, 'the Dockerfile pins NODE_IMAGE by tag and digest');
  assert.ok(DOCS.includes(`\`${base}\``), `site/docs/docker.md names ${base}`);
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
