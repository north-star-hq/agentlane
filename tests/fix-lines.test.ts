import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CLI, TOOL } from '../src/name.ts';

const SRC = path.resolve(import.meta.dirname, '..', 'src');
const COMMANDS =
  'lane|release|status|lanes|up|restart|exec|doctor|schema|look|run|screenshot|record|driver|device|evidence|browser|mcp|init|skills|setup';
const BARE = new RegExp(String.raw`\$\{TOOL\} (${COMMANDS})\b(?!:)`);

const NOT_A_COMMAND_TO_RUN = [
  /Usage: \$\{TOOL\}/,
  /eval "\$\(\$\{TOOL\} (up|lane)\)"/,
  /exec {7}Run one command|with JDK 17 and the lane's runner token|call's environment: KEY=value/,
  /`\$\{TOOL\} init in /,
  /`\$\{TOOL\} init --check: /,
  /`\$\{TOOL\} up refused before any build/,
  /another \$\{TOOL\} run\b/,
];

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(at);
    return entry.name.endsWith('.ts') ? [at] : [];
  });
}

test('every command the CLI tells its reader to run is the runnable form, through CLI', () => {
  assert.equal(CLI, `node_modules/.bin/${TOOL}`);
  const bare: string[] = [];
  for (const file of sources(SRC)) {
    if (file.endsWith(path.join('project', 'schema.ts'))) continue;
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (BARE.test(line) && !NOT_A_COMMAND_TO_RUN.some(allowed => allowed.test(line)))
          bare.push(`${path.relative(SRC, file)}:${String(index + 1)}: ${line.trim()}`);
      });
  }
  assert.deepEqual(bare, [], 'write these as `${CLI} <command>`, which runs from the project root in any shell');
});
