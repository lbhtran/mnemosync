// Project/session discovery under ~/.claude/projects. Session metadata is
// derived from a cheap scan of each JSONL (cached by mtime); an optional
// sessions-index.json is used when present.

import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { ProjectInfo, SessionInfo, SubagentInfo } from '../shared/types.js';
import type { RawRecord } from './parse.js';
import { extractUserPrompt } from './normalize.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_ID_RE = /^[A-Za-z0-9_-]+$/;

export function defaultClaudeDir(): string {
  return join(homedir(), '.claude');
}

export function listProjects(claudeDir: string): ProjectInfo[] {
  const root = join(claudeDir, 'projects');
  if (!existsSync(root)) return [];
  const projects: ProjectInfo[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const sessions = sessionFiles(dir);
    if (sessions.length === 0) continue;
    const lastModified = sessions.reduce((max, f) => {
      try {
        return Math.max(max, statSync(f).mtimeMs);
      } catch {
        return max; // vanished between readdir and stat
      }
    }, 0);
    projects.push({
      id: name,
      path: dir,
      decodedPath: decodeProjectPath(dir, name),
      sessionCount: sessions.length,
      lastModified: new Date(lastModified).toISOString(),
    });
  }
  projects.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  return projects;
}

function sessionFiles(projectDir: string): string[] {
  try {
    return readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl') && UUID_RE.test(f.replace(/\.jsonl$/, '')))
      .map((f) => join(projectDir, f));
  } catch {
    return [];
  }
}

/** The encoding replaces every non-alphanumeric char with '-', which is
 *  lossy. Prefer the cwd recorded inside the newest transcript; fall back
 *  to a naive dash→slash decode. */
function decodeProjectPath(projectDir: string, encoded: string): string {
  const files = sessionFiles(projectDir)
    .flatMap((f) => {
      try {
        return [{ f, mtime: statSync(f).mtimeMs }];
      } catch {
        return []; // vanished between readdir and stat
      }
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const { f } of files.slice(0, 3)) {
    try {
      const head = readFileSync(f, 'utf8').slice(0, 64 * 1024);
      for (const line of head.split('\n')) {
        try {
          const rec = JSON.parse(line);
          if (typeof rec.cwd === 'string' && rec.cwd) return rec.cwd;
        } catch {
          /* keep scanning */
        }
      }
    } catch {
      /* try next file */
    }
  }
  return encoded.replace(/-/g, '/').replace(/\/\//g, '/') || encoded;
}

// ---- session metadata (cached by path+mtime) ----

interface CacheEntry {
  mtimeMs: number;
  info: SessionInfo;
}
const sessionCache = new Map<string, CacheEntry>();

export async function listSessions(project: ProjectInfo): Promise<SessionInfo[]> {
  const index = readSessionsIndex(project.path);
  const out: SessionInfo[] = [];
  for (const file of sessionFiles(project.path)) {
    const sessionId = basename(file, '.jsonl');
    let st;
    try {
      st = statSync(file);
    } catch {
      continue; // vanished between readdir and stat
    }
    const cached = sessionCache.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs) {
      out.push(cached.info);
      continue;
    }
    const scanned = await scanSession(file);
    const idx = index?.[sessionId];
    const info: SessionInfo = {
      sessionId,
      projectId: project.id,
      summary:
        (typeof idx?.summary === 'string' && idx.summary) ||
        scanned.summary ||
        scanned.firstPrompt ||
        '(no prompt)',
      startedAt: scanned.startedAt || st.birthtime.toISOString(),
      modifiedAt: st.mtime.toISOString(),
      messageCount: scanned.messageCount,
      gitBranch: scanned.gitBranch,
      sizeBytes: st.size,
      hasSubagents: existsSync(join(project.path, sessionId, 'subagents')),
    };
    sessionCache.set(file, { mtimeMs: st.mtimeMs, info });
    out.push(info);
  }
  out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return out;
}

function readSessionsIndex(
  projectDir: string,
): Record<string, { summary?: string }> | undefined {
  const p = join(projectDir, 'sessions-index.json');
  if (!existsSync(p)) return undefined;
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    if (Array.isArray(data)) {
      const map: Record<string, { summary?: string }> = {};
      for (const e of data) if (e && typeof e.sessionId === 'string') map[e.sessionId] = e;
      return map;
    }
    if (data && typeof data === 'object') return data;
  } catch {
    /* optional file, ignore */
  }
  return undefined;
}

interface ScanResult {
  summary?: string;
  firstPrompt?: string;
  startedAt?: string;
  gitBranch?: string;
  messageCount: number;
}

/** Streaming line scan — cheap enough for multi-MB files, never loads the
 *  whole transcript for a listing. */
async function scanSession(file: string): Promise<ScanResult> {
  const res: ScanResult = { messageCount: 0 };
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === 'user' || rec.type === 'assistant') {
      res.messageCount++;
      if (!res.startedAt && typeof rec.timestamp === 'string') res.startedAt = rec.timestamp;
      if (!res.gitBranch && typeof rec.gitBranch === 'string' && rec.gitBranch)
        res.gitBranch = rec.gitBranch;
      if (!res.firstPrompt && rec.type === 'user') {
        const prompt = extractUserPrompt(rec as RawRecord);
        if (prompt) res.firstPrompt = prompt.slice(0, 120);
      }
    } else if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') {
      res.summary = rec.aiTitle; // last one wins
    } else if (rec.type === 'summary' && typeof rec.summary === 'string' && !res.summary) {
      res.summary = rec.summary;
    }
  }
  return res;
}

// ---- subagents ----

export function listSubagents(projectDir: string, sessionId: string): SubagentInfo[] {
  if (!UUID_RE.test(sessionId)) return [];
  const dir = join(projectDir, sessionId, 'subagents');
  if (!existsSync(dir)) return [];
  const out: SubagentInfo[] = [];
  for (const f of readdirSync(dir)) {
    const m = f.match(/^agent-([A-Za-z0-9_-]+)\.jsonl$/);
    if (!m) continue;
    const info: SubagentInfo = { agentId: m[1] };
    const metaPath = join(dir, `agent-${m[1]}.meta.json`);
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        if (typeof meta.agentType === 'string') info.agentType = meta.agentType;
        else if (typeof meta.subagent_type === 'string') info.agentType = meta.subagent_type;
        if (typeof meta.description === 'string') info.description = meta.description;
        else if (typeof meta.task === 'string') info.description = meta.task;
      } catch {
        /* meta optional */
      }
    }
    out.push(info);
  }
  return out;
}

/** Resolve a session id to its transcript path, validating against the
 *  discovered filesystem — client input never becomes a path directly. */
export function resolveSessionFile(
  claudeDir: string,
  sessionId: string,
): { file: string; projectDir: string } | undefined {
  if (!UUID_RE.test(sessionId)) return undefined;
  const root = join(claudeDir, 'projects');
  if (!existsSync(root)) return undefined;
  for (const name of readdirSync(root)) {
    const file = join(root, name, `${sessionId}.jsonl`);
    if (existsSync(file)) return { file, projectDir: join(root, name) };
  }
  return undefined;
}

export function resolveSubagentFile(
  claudeDir: string,
  sessionId: string,
  agentId: string,
): string | undefined {
  if (!AGENT_ID_RE.test(agentId)) return undefined;
  const session = resolveSessionFile(claudeDir, sessionId);
  if (!session) return undefined;
  const file = join(session.projectDir, sessionId, 'subagents', `agent-${agentId}.jsonl`);
  return existsSync(file) ? file : undefined;
}
