// File state reconstruction: sequential replay with periodic checkpoints
// so backward scrubbing is "jump to nearest checkpoint, replay forward".
//
// Rules (spec §5):
// - read/edit(baseContent)/write reveal or define content
// - failed events never mutate state
// - an edit whose oldStr isn't found marks the file desynced from there on
//   (UI shows the isolated old→new diff, never silently-wrong content)
// - a mutating bash command that clearly names a known file marks that
//   file approximate; otherwise state is left alone
// - a later edit carrying baseContent (ground truth from the transcript)
//   re-syncs the file

import type { FileEvent, Timeline, Turn } from '../../../src/shared/types';

export interface FlatEvent {
  event: FileEvent;
  turn: Turn;
  turnIndex: number;
  eventIndex: number; // global index across the whole timeline
}

export interface FileState {
  content: string;
  desynced: boolean;
  // Why desynced is true, so the UI can tell "we genuinely lost track of
  // this file" (unmatched/approximate) apart from "content was cut at the
  // 2MB cap, so an edit's oldStr search failing here doesn't mean the real
  // edit failed too" (truncated).
  desyncReason?: 'truncated' | 'unmatched' | 'approximate';
  everSeen: boolean; // false = we only know the path, never its content
  // content itself was cut at MAX_FILE_CONTENT — not the whole read
  // fragment/file the tool actually saw.
  truncated?: boolean;
  // 1-based line number that content[0] corresponds to in the real file.
  // A partial Read (offset/limit) makes content just that fragment, so
  // callers mapping an absolute line (e.g. another read's offset) onto
  // content need this to translate. Undefined/1 = content starts at line 1
  // (whole file, or an offset-less read/write).
  contentOffset?: number;
}

export interface Snapshot {
  files: Map<string, FileState>;
  /** File the current event touches (undefined for bash/subagent/other). */
  activeFile?: string;
  /** For desynced edits: show this diff in isolation. */
  isolatedDiff?: { path: string; oldStr: string; newStr: string };
}

const CHECKPOINT_INTERVAL = 20;
const MAX_CHECKPOINTS = 400; // ~8000 events before spacing grows

export function flattenEvents(timeline: Timeline): FlatEvent[] {
  const out: FlatEvent[] = [];
  for (const turn of timeline.turns) {
    for (const event of turn.events) {
      out.push({ event, turn, turnIndex: turn.index, eventIndex: out.length });
    }
  }
  return out;
}

function cloneFiles(files: Map<string, FileState>): Map<string, FileState> {
  const copy = new Map<string, FileState>();
  for (const [k, v] of files) copy.set(k, { ...v });
  return copy;
}

export class ReconstructionEngine {
  private events: FlatEvent[];
  private checkpoints = new Map<number, Map<string, FileState>>(); // index AFTER applying event i → state
  private interval: number;

  constructor(events: FlatEvent[]) {
    this.events = events;
    this.interval = Math.max(
      CHECKPOINT_INTERVAL,
      Math.ceil(events.length / MAX_CHECKPOINTS),
    );
  }

  /** State after applying events [0..index]. index of -1 = initial state. */
  stateAt(index: number): Snapshot {
    const target = Math.min(index, this.events.length - 1);
    if (target < 0) return { files: new Map() };

    // Find nearest checkpoint strictly before target — never target itself,
    // so the loop below always applies at least the target event and
    // produces a full snapshot (activeFile/isolatedDiff come from
    // applyEvent, not from a bare checkpoint).
    let start = -1;
    let files = new Map<string, FileState>();
    for (let c = target - (target % this.interval); c >= 0; c -= this.interval) {
      if (c < target) {
        const cp = this.checkpoints.get(c);
        if (cp) {
          start = c;
          files = cloneFiles(cp);
          break;
        }
      }
      if (c === 0) break;
    }

    let snapshot: Snapshot = { files };
    for (let i = start + 1; i <= target; i++) {
      snapshot = applyEvent(files, this.events[i].event);
      if (i % this.interval === 0 && !this.checkpoints.has(i)) {
        this.checkpoints.set(i, cloneFiles(files));
      }
    }
    return snapshot;
  }
}

function ensure(files: Map<string, FileState>, path: string): FileState {
  let f = files.get(path);
  if (!f) {
    f = { content: '', desynced: false, everSeen: false };
    files.set(path, f);
  }
  return f;
}

function applyEvent(files: Map<string, FileState>, ev: FileEvent): Snapshot {
  const snap: Snapshot = { files };

  switch (ev.kind) {
    case 'read': {
      snap.activeFile = ev.path;
      // No captured content (e.g. an image read) shouldn't register a
      // phantom empty file entry — only a read we actually have text for
      // tells us anything about the file's state.
      if (ev.isError || ev.content === undefined) break;
      const f = ensure(files, ev.path);
      f.content = ev.content;
      f.everSeen = true;
      f.desynced = false; // fresh read is ground truth
      f.desyncReason = undefined;
      f.truncated = ev.truncated ?? false;
      f.contentOffset = ev.offset && ev.offset > 0 ? ev.offset : 1;
      break;
    }
    case 'create':
    case 'write': {
      snap.activeFile = ev.path;
      if (ev.isError) break;
      const f = ensure(files, ev.path);
      f.content = ev.content;
      f.everSeen = true;
      f.desynced = false;
      f.desyncReason = undefined;
      f.truncated = ev.truncated ?? false;
      f.contentOffset = 1;
      break;
    }
    case 'edit': {
      snap.activeFile = ev.path;
      if (ev.isError) break;
      const f = ensure(files, ev.path);
      // Transcript-recorded pre-edit content is ground truth: re-syncs.
      if (ev.baseContent !== undefined && (!f.everSeen || f.desynced)) {
        f.content = ev.baseContent;
        f.everSeen = true;
        f.desynced = false;
        f.desyncReason = undefined;
        f.truncated = ev.baseContentTruncated ?? false;
        f.contentOffset = 1;
      }
      if (f.everSeen && f.content.includes(ev.oldStr) && ev.oldStr !== '') {
        f.content = ev.replaceAll
          ? f.content.split(ev.oldStr).join(ev.newStr)
          : f.content.replace(ev.oldStr, ev.newStr);
        f.desynced = false;
        f.desyncReason = undefined;
      } else if (ev.oldStr === '' && !f.everSeen) {
        f.content = ev.newStr; // create-via-empty-edit
        f.everSeen = true;
        f.contentOffset = 1;
      } else {
        f.desynced = true;
        // oldStr not found is expected (not a real conflict) when our
        // content is a truncated fragment — the real edit likely landed
        // past the cutoff, where we simply can't see it.
        f.desyncReason = f.truncated ? 'truncated' : 'unmatched';
        snap.isolatedDiff = { path: ev.path, oldStr: ev.oldStr, newStr: ev.newStr };
      }
      break;
    }
    case 'delete': {
      snap.activeFile = ev.path;
      if (!ev.isError) files.delete(ev.path);
      break;
    }
    case 'bash': {
      if (ev.mutating && !ev.isError) {
        for (const [path, f] of files) {
          const base = path.split('/').pop() ?? path;
          if (ev.command.includes(path) || (base.length > 3 && ev.command.includes(base))) {
            f.desynced = true;
            f.desyncReason = 'approximate';
          }
        }
      }
      break;
    }
    case 'mutate': {
      snap.activeFile = ev.path;
      if (!ev.isError) {
        const f = ensure(files, ev.path);
        f.everSeen = true;
        f.desynced = true; // no parsed diff for this tool — approximate from here
        f.desyncReason = 'approximate';
      }
      break;
    }
    default:
      break;
  }
  return snap;
}
