// M3 exit criteria: scrub anywhere in a 500+ event session and get correct
// (or explicitly-approximate) file state. The engine (checkpoints + replay)
// must agree exactly with a naive apply-everything-from-zero replay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { FileEvent, Timeline, Turn } from '../src/shared/types.js';
import {
  flattenEvents,
  ReconstructionEngine,
} from '../web/src/playback/reconstruct.js';
import { parseJsonlFile } from '../src/parser/parse.js';
import { normalize } from '../src/parser/normalize.js';

function mkTimeline(turns: Turn[]): Timeline {
  return {
    meta: {
      sessionId: 't', projectPath: '/p', startedAt: '', turnCount: turns.length,
      eventCount: turns.reduce((n, t) => n + t.events.length, 0),
      filesTouched: [], subagents: [], parseWarnings: [],
    },
    turns,
    hasMore: false,
  };
}

function ev(partial: Partial<FileEvent> & { kind: FileEvent['kind'] }): FileEvent {
  return { id: `e${Math.random()}`, timestamp: '', rawToolName: 'x', ...partial } as FileEvent;
}

/** Independent naive reference implementation. */
function naiveStateAt(events: ReturnType<typeof flattenEvents>, index: number) {
  const files = new Map<string, { content: string; desynced: boolean; everSeen: boolean }>();
  const get = (p: string) => {
    if (!files.has(p)) files.set(p, { content: '', desynced: false, everSeen: false });
    return files.get(p)!;
  };
  for (let i = 0; i <= index; i++) {
    const e = events[i].event;
    if (e.isError) continue;
    if (e.kind === 'write' || e.kind === 'create') {
      Object.assign(get(e.path), { content: e.content, everSeen: true, desynced: false });
    } else if (e.kind === 'read' && e.content !== undefined) {
      Object.assign(get(e.path), { content: e.content, everSeen: true, desynced: false });
    } else if (e.kind === 'edit') {
      const f = get(e.path);
      if (e.baseContent !== undefined && (!f.everSeen || f.desynced)) {
        f.content = e.baseContent;
        f.everSeen = true;
        f.desynced = false;
      }
      if (f.everSeen && e.oldStr !== '' && f.content.includes(e.oldStr)) {
        f.content = e.replaceAll ? f.content.split(e.oldStr).join(e.newStr) : f.content.replace(e.oldStr, e.newStr);
        f.desynced = false;
      } else if (e.oldStr === '' && !f.everSeen) {
        f.content = e.newStr;
        f.everSeen = true;
      } else f.desynced = true;
    } else if (e.kind === 'delete') files.delete(e.path);
    else if (e.kind === 'bash' && e.mutating) {
      for (const [p, f] of files) {
        const base = p.split('/').pop() ?? p;
        if (e.command.includes(p) || (base.length > 3 && e.command.includes(base))) f.desynced = true;
      }
    } else if (e.kind === 'mutate') {
      Object.assign(get(e.path), { everSeen: true, desynced: true });
    }
  }
  return files;
}

function assertSameState(
  engine: ReconstructionEngine,
  events: ReturnType<typeof flattenEvents>,
  index: number,
) {
  const got = engine.stateAt(index).files;
  const want = naiveStateAt(events, index);
  assert.equal(got.size, want.size, `file count at ${index}`);
  for (const [p, w] of want) {
    const g = got.get(p);
    assert.ok(g, `missing ${p} at ${index}`);
    assert.equal(g.content, w.content, `content of ${p} at ${index}`);
    assert.equal(g.desynced, w.desynced, `desync of ${p} at ${index}`);
  }
}

test('reconstruct: 600-event synthetic session, random scrubbing matches naive replay', () => {
  const turns: Turn[] = [];
  let content = 'line0\n';
  for (let t = 0; t < 500; t++) {
    const events: FileEvent[] = [];
    // seed the file, then steadily grow it via edits; occasionally rewrite + touch others
    if (t === 0) events.push(ev({ kind: 'write', path: '/a.txt', content: 'line0\n' }));
    events.push(ev({ kind: 'edit', path: '/a.txt', oldStr: `line${t}\n`, newStr: `line${t}\nline${t + 1}\n` }));
    if (t % 7 === 0) events.push(ev({ kind: 'write', path: `/f${t % 3}.txt`, content: `v${t}` }));
    if (t % 13 === 0) events.push(ev({ kind: 'bash', command: `wc -l /a.txt`, mutating: false }));
    if (t % 31 === 0) events.push(ev({ kind: 'bash', command: `sed -i s/x/y/ /f0.txt`, mutating: true }));
    turns.push({ id: `t${t}`, index: t, timestamp: '', reasoning: [], events });
    content += `line${t + 1}\n`;
  }
  const timeline = mkTimeline(turns);
  const events = flattenEvents(timeline);
  assert.ok(events.length >= 500, `have ${events.length} events`);

  const engine = new ReconstructionEngine(events);
  // Deliberately scrub backwards and randomly — checkpoints must not lie.
  const probes = [events.length - 1, 0, 250, 37, 512, 88, 411, 3, events.length - 2];
  let seed = 42;
  for (let i = 0; i < 40; i++) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    probes.push(seed % events.length);
  }
  for (const p of probes) assertSameState(engine, events, p);

  // Final content sanity: the growing file is fully reconstructed.
  const final = engine.stateAt(events.length - 1).files.get('/a.txt');
  assert.ok(final?.content.includes('line500'));
  assert.equal(final?.desynced, false);
});

test('reconstruct: desynced edit shows isolated diff, later baseContent re-syncs', () => {
  const turns: Turn[] = [
    {
      id: 't0', index: 0, timestamp: '', reasoning: [],
      events: [
        ev({ kind: 'write', path: '/x.py', content: 'def a(): pass\n' }),
        ev({ kind: 'edit', path: '/x.py', oldStr: 'NOT PRESENT', newStr: 'def b(): pass' }),
        ev({ kind: 'edit', path: '/x.py', oldStr: 'def a', newStr: 'def renamed', baseContent: 'def a(): pass\n' }),
      ],
    },
  ];
  const events = flattenEvents(mkTimeline(turns));
  const engine = new ReconstructionEngine(events);
  const atDesync = engine.stateAt(1);
  assert.equal(atDesync.files.get('/x.py')?.desynced, true);
  assert.deepEqual(atDesync.isolatedDiff, { path: '/x.py', oldStr: 'NOT PRESENT', newStr: 'def b(): pass' });
  const after = engine.stateAt(2);
  assert.equal(after.files.get('/x.py')?.desynced, false);
  assert.match(after.files.get('/x.py')!.content, /renamed/);
});

test('reconstruct: real session scrubbing is engine≡naive (skipped if none found)', async (t) => {
  const dir = join(homedir(), '.claude', 'projects');
  if (!existsSync(dir)) return t.skip('no ~/.claude/projects');
  // biggest transcript available
  let best: { file: string; size: number } | undefined;
  for (const proj of readdirSync(dir)) {
    const pd = join(dir, proj);
    if (!statSync(pd).isDirectory()) continue;
    for (const f of readdirSync(pd)) {
      if (!f.endsWith('.jsonl')) continue;
      const size = statSync(join(pd, f)).size;
      if (!best || size > best.size) best = { file: join(pd, f), size };
    }
  }
  if (!best) return t.skip('no sessions');
  const { records, warnings } = await parseJsonlFile(best.file);
  const timeline = normalize(records, warnings);
  const events = flattenEvents(timeline);
  if (events.length < 10) return t.skip('too few events');
  const engine = new ReconstructionEngine(events);
  const probes = [events.length - 1, 0, Math.floor(events.length / 2), Math.floor(events.length / 3), events.length - 5, 7];
  for (const p of probes) assertSameState(engine, events, Math.max(0, Math.min(p, events.length - 1)));
});
