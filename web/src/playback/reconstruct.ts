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
  everSeen: boolean; // false = we only know the path, never its content
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
      if (ev.isError) break;
      const f = ensure(files, ev.path);
      if (ev.content !== undefined) {
        f.content = ev.content;
        f.everSeen = true;
        f.desynced = false; // fresh read is ground truth
      }
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
      }
      if (f.everSeen && f.content.includes(ev.oldStr) && ev.oldStr !== '') {
        f.content = ev.replaceAll
          ? f.content.split(ev.oldStr).join(ev.newStr)
          : f.content.replace(ev.oldStr, ev.newStr);
        f.desynced = false;
      } else if (ev.oldStr === '' && !f.everSeen) {
        f.content = ev.newStr; // create-via-empty-edit
        f.everSeen = true;
      } else {
        f.desynced = true;
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
      }
      break;
    }
    default:
      break;
  }
  return snap;
}
