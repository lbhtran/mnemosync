// Raw JSONL records → normalized Timeline. This module (with parse.ts and
// discover.ts) is the ONLY place that knows the Claude Code transcript
// format; everything downstream consumes src/shared/types.ts shapes.
//
// Format knowledge, verified against real transcripts (Claude Code ~2.x):
// - Record types seen in the wild: system, user, assistant,
//   file-history-snapshot, plus session-metadata types we skip
//   (queue-operation, ai-title, last-prompt, mode, permission-mode,
//   bridge-session, pr-link, attachment). `summary` records exist in
//   older versions; compaction now appears as system/compact_boundary.
// - assistant records carry message.content blocks: thinking | text |
//   tool_use. One API message may span several records sharing message.id.
// - user records carry either a real prompt (string / text blocks) or
//   tool_result blocks; structured results also land in toolUseResult.
// - Edit results include originalFile (full pre-edit content) — gold for
//   state reconstruction. Read results include file.content.

import type {
  FileEvent,
  ReasoningBlock,
  SubagentInfo,
  Timeline,
  TimelineMeta,
  Turn,
} from '../shared/types.js';
import type { RawRecord } from './parse.js';

const SKIP_TYPES = new Set([
  'queue-operation',
  'last-prompt',
  'mode',
  'permission-mode',
  'bridge-session',
  'pr-link',
  'attachment',
  'file-history-snapshot',
  'result',
]);

const MAX_BASH_OUTPUT = 20_000;
const MAX_FILE_CONTENT = 2_000_000;

// Commands that can change files on disk break clean state reconstruction,
// so they are flagged and the playback engine treats touched files as
// approximate from that point on.
const MUTATING_BASH =
  /(^|[\s;|&])(rm|mv|cp|mkdir|touch|tee|truncate|dd|ln|chmod|chown|patch|rsync)\s|>>?|\bsed\s+(-\S*\s+)*-i\b|\bgit\s+(checkout|restore|reset|stash|clean|revert|merge|rebase|pull|cherry-pick)\b|\bnpm\s+(install|i|ci|uninstall)\b/;

interface AnyBlock {
  type?: string;
  [key: string]: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asBlocks(content: unknown): AnyBlock[] {
  return Array.isArray(content) ? (content as AnyBlock[]) : [];
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n… [truncated, ${s.length} chars total]` : s;
}

/** Extract the human prompt from a user record, or undefined if it is a
 *  tool-result carrier / meta record / injected content. */
function extractUserPrompt(rec: RawRecord): string | undefined {
  if (rec.isMeta === true || rec.isCompactSummary === true) return undefined;
  const message = rec.message as { content?: unknown } | undefined;
  if (!message) return undefined;
  let text: string | undefined;
  if (typeof message.content === 'string') {
    text = message.content;
  } else {
    const blocks = asBlocks(message.content);
    if (blocks.some((b) => b.type === 'tool_result')) return undefined;
    const texts = blocks.filter((b) => b.type === 'text').map((b) => str(b.text) ?? '');
    if (texts.length) text = texts.join('\n');
  }
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  // Injected/system-ish content masquerading as user turns.
  if (/^<(local-command-stdout|command-name|system-reminder|bash-input)/.test(trimmed)) return undefined;
  if (trimmed.startsWith('Caveat: The messages below were generated')) return undefined;
  return trimmed;
}

interface ToolResultInfo {
  isError: boolean;
  errorMessage?: string;
  output?: string;
  structured?: Record<string, unknown>;
}

/** Pull tool results out of a user record: inline tool_result blocks plus
 *  the richer structured toolUseResult field. */
function extractToolResults(rec: RawRecord): Map<string, ToolResultInfo> {
  const out = new Map<string, ToolResultInfo>();
  const message = rec.message as { content?: unknown } | undefined;
  const resultBlocks = asBlocks(message?.content).filter((b) => b.type === 'tool_result');
  // toolUseResult is a single record-level field; it only unambiguously
  // belongs to a specific tool_result block when there's exactly one in
  // this record. With more than one, attaching it to every block would
  // silently cross-contaminate their reconstructed content.
  const structured =
    resultBlocks.length === 1 && rec.toolUseResult && typeof rec.toolUseResult === 'object'
      ? (rec.toolUseResult as Record<string, unknown>)
      : undefined;
  for (const b of resultBlocks) {
    const id = str(b.tool_use_id);
    if (!id) continue;
    let text = '';
    if (typeof b.content === 'string') text = b.content;
    else if (Array.isArray(b.content)) {
      text = (b.content as AnyBlock[])
        .filter((c) => c.type === 'text')
        .map((c) => str(c.text) ?? '')
        .join('\n');
    }
    const isError = b.is_error === true;
    const info: ToolResultInfo = { isError, output: text };
    if (isError) info.errorMessage = truncate(text, 2000);
    if (structured) info.structured = structured;
    out.set(id, info);
  }
  return out;
}

function toolUseToEvent(
  block: AnyBlock,
  timestamp: string,
  warnings: string[],
): FileEvent {
  const id = str(block.id) ?? `ev-${Math.random().toString(36).slice(2, 10)}`;
  const name = str(block.name) ?? 'unknown';
  const input = (block.input ?? {}) as Record<string, unknown>;
  const base = { id, timestamp, rawToolName: name };

  switch (name) {
    case 'Write':
    case 'create_file': {
      const path = str(input.file_path) ?? str(input.path) ?? '';
      const content = truncate(str(input.content) ?? '', MAX_FILE_CONTENT);
      // create vs overwrite is resolved later once we know prior state;
      // default to 'write', reconstruction treats first-touch as create.
      return { ...base, kind: 'write', path, content };
    }
    case 'Edit':
    case 'str_replace':
    case 'str_replace_editor': {
      return {
        ...base,
        kind: 'edit',
        path: str(input.file_path) ?? str(input.path) ?? '',
        oldStr: str(input.old_string) ?? str(input.old_str) ?? '',
        newStr: str(input.new_string) ?? str(input.new_str) ?? '',
        replaceAll: input.replace_all === true,
      };
    }
    case 'Read':
    case 'view':
      return { ...base, kind: 'read', path: str(input.file_path) ?? str(input.path) ?? '' };
    case 'Bash': {
      const command = str(input.command) ?? '';
      return { ...base, kind: 'bash', command, mutating: MUTATING_BASH.test(command) };
    }
    case 'Task':
    case 'Agent':
      return {
        ...base,
        kind: 'subagent',
        agentId: '', // filled from the result if it names one
        description: str(input.description) ?? str(input.prompt)?.slice(0, 200) ?? '',
      };
    default: {
      // Any unmapped tool that names a specific file/notebook (MultiEdit,
      // NotebookEdit, or whatever ships next) mutates it without us having
      // a precise diff. Classify by input shape, not a name allowlist, so
      // reconstruction marks the file approximate instead of silently
      // leaving it stale — and this stays correct for tools we've never
      // heard of.
      const mutatePath = str(input.file_path) ?? str(input.notebook_path);
      if (mutatePath) {
        return { ...base, kind: 'mutate', path: mutatePath, toolName: name };
      }
      if (!KNOWN_OTHER_TOOLS.has(name)) warnings.push(`unmapped tool "${name}" rendered as generic event`);
      let summary = '';
      try {
        summary = JSON.stringify(input);
      } catch {
        summary = '[unserializable input]';
      }
      return { ...base, kind: 'other', toolName: name, summary: truncate(summary, 500) };
    }
  }
}

// Tools we deliberately map to 'other' — no warning noise for these.
const KNOWN_OTHER_TOOLS = new Set([
  'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead', 'Skill',
  'AskUserQuestion', 'ToolSearch', 'TaskCreate', 'TaskUpdate', 'TaskList',
  'TaskGet', 'TaskOutput', 'TaskStop', 'ExitPlanMode',
  'EnterPlanMode', 'SendMessage', 'Artifact', 'SendUserFile',
]);

/** Merge structured toolUseResult data back into an event. */
function enrichEvent(ev: FileEvent, res: ToolResultInfo): FileEvent {
  if (res.isError) {
    ev.isError = true;
    ev.errorMessage = res.errorMessage;
    return ev;
  }
  const s = res.structured;
  if (ev.kind === 'bash') {
    const stdout = str(s?.stdout) ?? res.output ?? '';
    const stderr = str(s?.stderr) ?? '';
    ev.output = truncate([stdout, stderr].filter(Boolean).join('\n'), MAX_BASH_OUTPUT);
  } else if (ev.kind === 'edit' && s) {
    const orig = str(s.originalFile);
    if (orig !== undefined) ev.baseContent = truncate(orig, MAX_FILE_CONTENT);
    if (s.replaceAll === true) ev.replaceAll = true;
  } else if (ev.kind === 'read' && s) {
    const file = s.file as Record<string, unknown> | undefined;
    const content = str(file?.content);
    if (content !== undefined) ev.content = truncate(content, MAX_FILE_CONTENT);
  } else if (ev.kind === 'subagent' && s) {
    const agentId = str(s.agentId) ?? str(s.taskId);
    if (agentId) ev.agentId = agentId;
  }
  return ev;
}

export interface NormalizeOptions {
  sessionId?: string;
  subagents?: SubagentInfo[];
  /** Subagent transcripts are entirely isSidechain:true — include them.
   *  In main-session files sidechain records are just echoes and are skipped. */
  includeSidechain?: boolean;
}

export function normalize(
  records: RawRecord[],
  parseWarnings: string[],
  opts: NormalizeOptions = {},
): Timeline {
  const warnings = [...parseWarnings];
  const turns: Turn[] = [];
  const pendingEvents = new Map<string, FileEvent>(); // tool_use id → event
  const filesTouched = new Set<string>();
  const unknownTypes = new Set<string>();

  let sessionId = opts.sessionId ?? '';
  let projectPath = '';
  let model: string | undefined;
  let gitBranch: string | undefined;
  let summary: string | undefined;
  let startedAt = '';
  let endedAt: string | undefined;

  let current: Turn | null = null;
  let pendingPrompt: string | undefined;
  let pendingPromptTs = '';
  let pendingCompaction = false;

  // Interleaved writers (same session resumed twice) can produce
  // out-of-order timestamps; stable-sort conversation records only.
  const isConversational = (r: RawRecord) =>
    r.type === 'user' || r.type === 'assistant' || r.type === 'system';
  const conversational = records.filter(isConversational);
  const metaRecords = records.filter((r) => !isConversational(r));
  const sorted = [...conversational];
  let outOfOrder = false;
  for (let i = 1; i < sorted.length; i++) {
    const a = str(sorted[i - 1].timestamp);
    const b = str(sorted[i].timestamp);
    if (a && b && b < a) {
      outOfOrder = true;
      break;
    }
  }
  if (outOfOrder) {
    warnings.push('out-of-order timestamps detected (interleaved session?); records re-sorted');
    sorted.sort((a, b) => (str(a.timestamp) ?? '').localeCompare(str(b.timestamp) ?? ''));
  }

  for (const rec of metaRecords) {
    if (rec.type === 'ai-title' && str(rec.aiTitle)) summary = str(rec.aiTitle);
    else if (rec.type === 'summary' && str(rec.summary)) summary = summary ?? str(rec.summary);
    else if (!SKIP_TYPES.has(rec.type) && rec.type !== 'summary') unknownTypes.add(rec.type);
  }

  const newTurn = (timestamp: string): Turn => {
    const t: Turn = {
      id: `turn-${turns.length}`,
      index: turns.length,
      timestamp,
      reasoning: [],
      events: [],
    };
    if (pendingPrompt !== undefined) {
      t.userPrompt = pendingPrompt;
      pendingPrompt = undefined;
    }
    if (pendingCompaction) {
      t.isCompactionBoundary = true;
      pendingCompaction = false;
    }
    turns.push(t);
    return t;
  };

  for (const rec of sorted) {
    const ts = str(rec.timestamp) ?? '';
    if (ts) {
      if (!startedAt) startedAt = ts;
      endedAt = ts;
    }
    if (!sessionId) sessionId = str(rec.sessionId) ?? '';
    if (!projectPath) projectPath = str(rec.cwd) ?? '';
    if (!gitBranch) gitBranch = str(rec.gitBranch);
    if (rec.isSidechain === true && !opts.includeSidechain) continue;

    if (rec.type === 'system') {
      if (rec.subtype === 'compact_boundary') {
        pendingCompaction = true;
        current = null;
      }
      continue;
    }

    if (rec.type === 'user') {
      const prompt = extractUserPrompt(rec);
      if (prompt !== undefined) {
        // Back-to-back prompts (no assistant reply between them) each get
        // their own turn instead of the later one clobbering the earlier.
        if (pendingPrompt !== undefined) newTurn(pendingPromptTs || ts);
        pendingPrompt = prompt;
        pendingPromptTs = ts;
        current = null; // next assistant activity starts a fresh turn
        continue;
      }
      for (const [id, res] of extractToolResults(rec)) {
        const ev = pendingEvents.get(id);
        if (ev) {
          enrichEvent(ev, res);
          pendingEvents.delete(id);
        }
      }
      continue;
    }

    if (rec.type === 'assistant') {
      if (rec.isApiErrorMessage === true) continue;
      const message = rec.message as
        | { content?: unknown; model?: string; usage?: Record<string, unknown> }
        | undefined;
      if (!model && message?.model) model = message.model;

      for (const block of asBlocks(message?.content)) {
        if (block.type === 'thinking' || block.type === 'text') {
          const content = str(block.thinking) ?? str(block.text) ?? '';
          if (!content.trim()) continue;
          // New reasoning after actions = a new think→act cycle.
          if (current && current.events.length > 0) current = null;
          if (!current) current = newTurn(ts);
          const kind: ReasoningBlock['kind'] = block.type === 'thinking' ? 'thinking' : 'text';
          const last = current.reasoning[current.reasoning.length - 1];
          if (last && last.kind === kind) last.content += '\n\n' + content;
          else current.reasoning.push({ kind, content });
        } else if (block.type === 'tool_use') {
          if (!current) current = newTurn(ts);
          const ev = toolUseToEvent(block, ts, warnings);
          current.events.push(ev);
          pendingEvents.set(ev.id, ev);
          if ('path' in ev && ev.path) filesTouched.add(ev.path);
        }
      }

      const usage = message?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      if (current && usage) {
        const prev = current.tokenUsage ?? { input: 0, output: 0 };
        current.tokenUsage = {
          input: Math.max(prev.input, usage.input_tokens ?? 0),
          output: prev.output + (usage.output_tokens ?? 0),
        };
      }
      continue;
    }

    if (!SKIP_TYPES.has(rec.type)) unknownTypes.add(rec.type);
  }

  // A trailing prompt with no assistant response still deserves a turn.
  if (pendingPrompt !== undefined) newTurn(endedAt ?? startedAt);

  for (const t of unknownTypes) warnings.push(`unknown record type "${t}" skipped`);

  const eventCount = turns.reduce((n, t) => n + t.events.length, 0);
  const meta: TimelineMeta = {
    sessionId,
    projectPath,
    startedAt,
    endedAt,
    model,
    summary,
    gitBranch,
    turnCount: turns.length,
    eventCount,
    filesTouched: [...filesTouched].sort(),
    subagents: opts.subagents ?? [],
    parseWarnings: warnings,
  };

  return { meta, turns, hasMore: false };
}
