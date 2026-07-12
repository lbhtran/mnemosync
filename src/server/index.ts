// Local-only HTTP server: JSON API + static frontend. Binds 127.0.0.1
// exclusively — this serves private transcript data.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize as pathNormalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listProjects,
  listSessions,
  listSubagents,
  resolveSessionFile,
  resolveSubagentFile,
} from '../parser/discover.js';
import { parseJsonlFile } from '../parser/parse.js';
import { normalize } from '../parser/normalize.js';
import type { Timeline } from '../shared/types.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

interface TimelineCacheEntry {
  mtimeMs: number;
  timeline: Timeline;
}
const timelineCache = new Map<string, TimelineCacheEntry>();
const TIMELINE_CACHE_MAX = 8;

function buildTimeline(
  file: string,
  sessionId: string,
  projectDir?: string,
  includeSidechain = false,
): Timeline {
  const st = statSync(file);
  const cached = timelineCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.timeline;
  const { records, warnings } = parseJsonlFile(file);
  const subagents = projectDir ? listSubagents(projectDir, sessionId) : [];
  const timeline = normalize(records, warnings, { sessionId, subagents, includeSidechain });
  timelineCache.set(file, { mtimeMs: st.mtimeMs, timeline });
  if (timelineCache.size > TIMELINE_CACHE_MAX) {
    const oldest = timelineCache.keys().next().value;
    if (oldest) timelineCache.delete(oldest);
  }
  return timeline;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(data);
}

function paginate(timeline: Timeline, offset: number, limit: number): Timeline {
  const turns = timeline.turns.slice(offset, offset + limit);
  return { meta: timeline.meta, turns, hasMore: offset + limit < timeline.turns.length };
}

export interface ServerOptions {
  claudeDir: string;
  port: number;
  host: string;
  /** Explicit opt-in (CLI --lan) required to bind anything but loopback:
   *  this server hands out private transcript data to whoever can reach it. */
  allowNonLoopback?: boolean;
  webDist?: string;
}

export function startServer(opts: ServerOptions): Promise<{ port: number; close: () => void }> {
  const loopback = opts.host === '127.0.0.1' || opts.host === 'localhost';
  if (!loopback && !opts.allowNonLoopback) {
    throw new Error(
      'mnemosyne serves private session data and binds 127.0.0.1 by default; pass --lan to expose it to your network',
    );
  }
  const webDist =
    opts.webDist ?? join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'web', 'dist');

  const server = createServer((req, res) => {
    handle(req, res, opts.claudeDir, webDist).catch((err) => {
      sendJson(res, 500, { error: String(err?.message ?? err) });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port, loopback ? '127.0.0.1' : opts.host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({ port, close: () => server.close() });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  claudeDir: string,
  webDist: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;

  if (path === '/api/health') return sendJson(res, 200, { ok: true });

  if (path === '/api/projects') {
    return sendJson(res, 200, listProjects(claudeDir));
  }

  let m = path.match(/^\/api\/projects\/([^/]+)\/sessions$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    // Never interpolate client input into paths: look up against discovery.
    const project = listProjects(claudeDir).find((p) => p.id === id);
    if (!project) return sendJson(res, 404, { error: 'project not found' });
    return sendJson(res, 200, await listSessions(project));
  }

  m = path.match(/^\/api\/sessions\/([^/]+)\/timeline$/);
  if (m) {
    const sessionId = decodeURIComponent(m[1]);
    const found = resolveSessionFile(claudeDir, sessionId);
    if (!found) return sendJson(res, 404, { error: 'session not found' });
    const timeline = buildTimeline(found.file, sessionId, found.projectDir);
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    return sendJson(res, 200, paginate(timeline, offset, limit));
  }

  m = path.match(/^\/api\/sessions\/([^/]+)\/subagents\/([^/]+)\/timeline$/);
  if (m) {
    const sessionId = decodeURIComponent(m[1]);
    const agentId = decodeURIComponent(m[2]);
    const file = resolveSubagentFile(claudeDir, sessionId, agentId);
    if (!file) return sendJson(res, 404, { error: 'subagent not found' });
    const timeline = buildTimeline(file, `${sessionId}/${agentId}`, undefined, true);
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    return sendJson(res, 200, paginate(timeline, offset, limit));
  }

  if (path.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });

  // Static frontend with SPA fallback.
  serveStatic(res, webDist, path);
}

function serveStatic(res: ServerResponse, webDist: string, urlPath: string): void {
  if (!existsSync(webDist)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<h1>mnemosyne</h1><p>Frontend not built. Run <code>npm run build</code> in <code>web/</code>. The API is live under <code>/api/</code>.</p>',
    );
    return;
  }
  const safe = pathNormalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let file = join(webDist, safe === '/' ? 'index.html' : safe);
  if (!file.startsWith(webDist)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(webDist, 'index.html');
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
}
