import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outlineToml, TomlError, upsertTable } from '../../src/agents/toml.ts';

const VALID = `# comment
title = "TOML \\"quoted\\" # not a comment"
'literal key' = 'C:\\path'
dotted.key = 1_000
when = 1979-05-27 07:32:00Z
pi = +3.14
on = true
lines = """
a [fake.header]
\\""" still inside
"""
raw = '''
[also.not.a.header]
'''
nested = [
  [1, 2], # a comment inside
  ["a", 'b'],
]
inline = { x = 1, y = { z = "w" } }

[mcp_servers."quoted.name"]
command = "x"

[[profiles]]
name = "a"
`;

test('the TOML outline finds headers and keys, and skips text inside strings and arrays', () => {
  const outline = outlineToml(VALID);
  assert.deepEqual(
    outline.headers.map(h => [h.path.join('/'), h.array, h.line]),
    [
      ['mcp_servers/quoted.name', false, 21],
      ['profiles', true, 24],
    ],
  );
  assert.deepEqual(
    outline.keys.map(k => k.path.join('/')),
    [
      'title',
      'literal key',
      'dotted/key',
      'when',
      'pi',
      'on',
      'lines',
      'raw',
      'nested',
      'inline',
      'mcp_servers/quoted.name/command',
      'profiles/name',
    ],
  );
  assert.deepEqual(outlineToml('a = 1\r\nb = 2\r\n').keys.length, 2);
});

test('broken TOML is an error that names its line', () => {
  for (const [text, line, message] of [
    ['a = "open\n', 1, 'a string is not closed'],
    ['a = 1\nb = [1, 2\n', 2, 'an array is not closed'],
    ['[table\nx = 1\n', 1, 'a table header is not closed'],
    ['a = 1 2\n', 1, "unexpected '2' after a value"],
    ['just words\n', 1, "a key needs '=' and a value"],
    ['a = """never closed\n', 1, 'a multi-line string is not closed'],
    ['a =\n', 1, 'a value is missing'],
  ] as const) {
    assert.throws(
      () => outlineToml(text),
      (error: unknown) => error instanceof TomlError && error.line === line && error.message.includes(message),
      text,
    );
  }
});

test('upsertTable adds the table, then leaves the file alone, and replaces only its own lines when they change', () => {
  const entries = [
    { key: 'command', value: '"sh"' },
    { key: 'args', value: '["-c", "x"]' },
  ];
  const a1 = [{ key: 'a', value: '1' }];
  const added = upsertTable('model = "o3"\n', ['mcp_servers', 'agentlane'], entries);
  assert.deepEqual(added, {
    kind: 'changed',
    text: 'model = "o3"\n\n[mcp_servers.agentlane]\ncommand = "sh"\nargs = ["-c", "x"]\n',
  });
  assert.deepEqual(upsertTable(added.text, ['mcp_servers', 'agentlane'], entries), { kind: 'unchanged' });
  assert.deepEqual(upsertTable('', ['t'], a1), { kind: 'changed', text: '[t]\na = 1\n' });
  assert.deepEqual(upsertTable('x = 1', ['t'], a1), { kind: 'changed', text: 'x = 1\n\n[t]\na = 1\n' });

  const stale = '[t]\na = 0\n\n# about u\n[u]\nb = 1\n';
  assert.deepEqual(upsertTable(stale, ['t'], a1), { kind: 'changed', text: '[t]\na = 1\n\n# about u\n[u]\nb = 1\n' });
  assert.deepEqual(upsertTable('[t]\n[t]\n', ['t'], a1).kind, 'refused');
  assert.match(JSON.stringify(upsertTable('t.a = 1\n', ['t'], a1)), /line 1 sets t\.a outside \[t\]/);
  assert.match(JSON.stringify(upsertTable('[t.sub]\nx = 1\n', ['t'], a1)), /changed/);
});

test('upsertTable keeps the table’s other keys, adds a missing one after them, and keeps a value its test accepts', () => {
  const entries = [
    { key: 'a', value: '1' },
    { key: 'limit', value: '30', keeps: (current: string) => Number(current) >= 30 },
  ];
  const own = '[t]\nenabled = false\na = [\n  0,\n]\nenv = { LOG = "1" }\n\n[u]\nb = 1\n';
  assert.deepEqual(upsertTable(own, ['t'], entries), {
    kind: 'changed',
    text: '[t]\nenabled = false\na = 1\nenv = { LOG = "1" }\nlimit = 30\n\n[u]\nb = 1\n',
  });
  assert.deepEqual(upsertTable('[t]\na = 1\nlimit = 90\n', ['t'], entries), { kind: 'unchanged' });
  assert.deepEqual(upsertTable('[t]\nlimit = 10 # too short\na = 1\n', ['t'], entries), {
    kind: 'changed',
    text: '[t]\nlimit = 30\na = 1\n',
  });
  assert.deepEqual(upsertTable('[t]\n', ['t'], entries), { kind: 'changed', text: '[t]\na = 1\nlimit = 30\n' });
});
