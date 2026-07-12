import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonlFile, parseJsonlText } from '../src/parser/parse.js';
import { normalize } from '../src/parser/normalize.js';

const fixtures = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'parser', 'fixtures');

function loadBasic() {
  const { records, warnings } = parseJsonlFile(join(fixtures, 'basic-session.jsonl'));
  return { records, warnings, timeline: normalize(records, warnings) };
}

test('parse: tolerates truncated final line and never throws', () => {
  const { records, warnings } = loadBasic();
  assert.ok(records.length > 10);
  assert.ok(warnings.some((w) => w.includes('final line')));
});

test('parse: skips garbage lines with warnings', () => {
  const { records, warnings } = parseJsonlText('{"type":"user","message":{"content":"hi"}}\nnot json\n{"no":"type"}\n[1,2]\n');
  assert.equal(records.length, 1);
  assert.equal(warnings.length, 3);
});

test('normalize: extracts session meta', () => {
  const { timeline: t } = loadBasic();
  assert.equal(t.meta.sessionId, '11111111-2222-3333-4444-555555555555');
  assert.equal(t.meta.projectPath, '/home/dev/example-app');
  assert.equal(t.meta.model, 'claude-fable-5');
  assert.equal(t.meta.summary, 'Add verbose flag to CLI');
  assert.equal(t.meta.gitBranch, 'main');
  assert.deepEqual(t.meta.filesTouched, [
    '/home/dev/example-app/README.md',
    '/home/dev/example-app/cli.py',
  ]);
});

test('normalize: groups think→act cycles into turns with user prompts', () => {
  const { timeline: t } = loadBasic();
  assert.ok(t.turns.length >= 3);
  const first = t.turns[0];
  assert.equal(first.userPrompt, 'Add a --verbose flag to the CLI');
  assert.equal(first.reasoning.filter((r) => r.kind === 'thinking').length, 1);
  assert.ok(first.events.length >= 1);
  // New reasoning after actions starts a new turn (plan → execute rhythm).
  const bashTurn = t.turns.find((x) => x.events.some((e) => e.kind === 'bash'));
  assert.ok(bashTurn);
  assert.notEqual(bashTurn, first);
});

test('normalize: edit events carry oldStr/newStr and originalFile base', () => {
  const { timeline: t } = loadBasic();
  const edit = t.turns.flatMap((x) => x.events).find((e) => e.kind === 'edit');
  assert.ok(edit && edit.kind === 'edit');
  assert.equal(edit.path, '/home/dev/example-app/cli.py');
  assert.match(edit.newStr, /--verbose/);
  assert.match(edit.baseContent ?? '', /^import argparse/);
});

test('normalize: read events carry revealed content', () => {
  const { timeline: t } = loadBasic();
  const read = t.turns.flatMap((x) => x.events).find((e) => e.kind === 'read');
  assert.ok(read && read.kind === 'read');
  assert.match(read.content ?? '', /argparse/);
});

test('normalize: bash output attached, non-mutating test command not flagged', () => {
  const { timeline: t } = loadBasic();
  const bashes = t.turns.flatMap((x) => x.events).filter((e) => e.kind === 'bash');
  assert.ok(bashes.length >= 2);
  const pytest = bashes.find((b) => b.kind === 'bash' && b.command.includes('pytest'));
  assert.ok(pytest && pytest.kind === 'bash');
  assert.equal(pytest.mutating, false);
  assert.match(pytest.output ?? '', /2 passed/);
});

test('normalize: is_error results are badged, never enriched as success', () => {
  const { timeline: t } = loadBasic();
  const err = t.turns.flatMap((x) => x.events).find((e) => e.isError);
  assert.ok(err);
  assert.match(err.errorMessage ?? '', /unrecognized arguments/);
});

test('normalize: compaction boundary marks the following turn', () => {
  const { timeline: t } = loadBasic();
  const boundary = t.turns.find((x) => x.isCompactionBoundary);
  assert.ok(boundary);
  assert.equal(boundary.userPrompt, 'Also write a README section for it');
});

test('normalize: unknown record types warn instead of crashing', () => {
  const { timeline: t } = loadBasic();
  assert.ok(t.meta.parseWarnings.some((w) => w.includes('mystery-future-record')));
});

test('normalize: mutating bash heuristic', () => {
  const mk = (command: string) => {
    const recs = [
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:00Z',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }] },
      },
    ];
    const t = normalize(recs as any, []);
    const ev = t.turns[0].events[0];
    return ev.kind === 'bash' && ev.mutating;
  };
  assert.equal(mk('ls -la'), false);
  assert.equal(mk('git status'), false);
  assert.equal(mk('rm -rf build'), true);
  assert.equal(mk('echo hi > out.txt'), true);
  assert.equal(mk('sed -i s/a/b/ f.txt'), true);
  assert.equal(mk('git checkout -- src/'), true);
});

test('normalize: out-of-order timestamps are re-sorted with a warning', () => {
  const recs = [
    { type: 'user', timestamp: '2026-01-01T00:10:00Z', message: { content: 'second' }, uuid: 'b' },
    { type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'first' }, uuid: 'a' },
  ];
  const t = normalize(recs as any, []);
  assert.ok(t.meta.parseWarnings.some((w) => w.includes('out-of-order')));
  assert.equal(t.turns[0].userPrompt, 'first');
});

test('normalize: chat-only session still yields turns', () => {
  const recs = [
    { type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'hello' } },
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:05Z',
      message: { content: [{ type: 'text', text: 'hi there' }] },
    },
  ];
  const t = normalize(recs as any, []);
  assert.equal(t.turns.length, 1);
  assert.equal(t.turns[0].events.length, 0);
  assert.equal(t.turns[0].reasoning[0].content, 'hi there');
});
