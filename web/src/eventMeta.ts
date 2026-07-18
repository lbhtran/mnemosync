import type { FileEventKind } from '../../src/shared/types';

// Single source of truth for "what glyph represents this event kind" — the
// Scrubber track, ReasoningPanel chips, and CodePanel action indicator all
// render the same underlying FileEvent and must agree on its symbol, or the
// same edit looks like a different action depending which panel you're
// looking at.
export const KIND_GLYPH: Record<FileEventKind, string> = {
  create: '✚',
  write: '✚',
  edit: '✎',
  delete: '✕',
  read: '👁',
  bash: '●',
  subagent: '⛭',
  mutate: '✱',
  other: '◦',
};

export const ERROR_GLYPH = '◆';
export const WARN_GLYPH = '⚠';
