import type { ProjectInfo, SessionInfo, Timeline } from '../../src/shared/types';

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

export const fetchProjects = () => get<ProjectInfo[]>('/api/projects');

export const fetchSessions = (projectId: string) =>
  get<SessionInfo[]>(`/api/projects/${encodeURIComponent(projectId)}/sessions`);

/** Pull the full timeline, following pagination. */
export async function fetchTimeline(sessionId: string, subagentId?: string): Promise<Timeline> {
  const base = subagentId
    ? `/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(subagentId)}/timeline`
    : `/api/sessions/${encodeURIComponent(sessionId)}/timeline`;
  const first = await get<Timeline>(`${base}?offset=0&limit=200`);
  const all = first;
  while (all.hasMore) {
    const next = await get<Timeline>(`${base}?offset=${all.turns.length}&limit=200`);
    all.turns.push(...next.turns);
    all.hasMore = next.hasMore;
  }
  return all;
}
