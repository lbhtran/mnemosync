import { useEffect, useMemo, useState } from 'react';
import type { ProjectInfo, SessionInfo } from '../../../src/shared/types';
import { fetchProjects, fetchSessions } from '../api';
import { ThemeToggle } from '../components/ThemeToggle';
import { Logo, LogoMark } from '../components/Logo';

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function fmtSize(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function Picker({
  theme,
  onToggleTheme,
}: {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}) {
  const [projects, setProjects] = useState<ProjectInfo[]>();
  const [sessions, setSessions] = useState<Record<string, SessionInfo[]>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetchProjects()
      .then((ps) => {
        setProjects(ps);
        if (ps[0]) toggle(ps[0].id, true);
      })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id: string, force?: boolean) => {
    setOpen((o) => ({ ...o, [id]: force ?? !o[id] }));
    setSessions((s) => {
      if (!s[id]) {
        fetchSessions(id)
          .then((list) => setSessions((prev) => ({ ...prev, [id]: list })))
          .catch((e) => setError(String(e)));
      }
      return s;
    });
  };

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const out: Record<string, SessionInfo[]> = {};
    for (const [pid, list] of Object.entries(sessions)) {
      out[pid] = q ? list.filter((s) => s.summary.toLowerCase().includes(q)) : list;
    }
    return out;
  }, [sessions, q]);

  if (error) {
    return (
      <div className="error-page">
        <ThemeToggle theme={theme} onToggleTheme={onToggleTheme} compact />
        <div className="brand-row">
          <LogoMark size={16} />
          mnemosync
        </div>
        <div className="msg">{error}</div>
      </div>
    );
  }
  if (!projects) {
    return (
      <div className="loading">
        <ThemeToggle theme={theme} onToggleTheme={onToggleTheme} compact />
        <div className="brand-row">
          <LogoMark size={16} />
          discovering sessions…
        </div>
      </div>
    );
  }

  return (
    <div className="picker">
      <div className="brand-row">
        <Logo size={28} />
        <span className="spacer" style={{ flex: 1 }} />
        <ThemeToggle theme={theme} onToggleTheme={onToggleTheme} />
      </div>
      <div className="tagline">
        memory, replayed — pick a session to watch what Claude changed and why
      </div>
      <input
        type="search"
        placeholder="filter sessions by summary…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ marginBottom: 20 }}
      />
      {projects.length === 0 && (
        <div className="loading" style={{ height: 'auto', padding: 40 }}>
          No sessions found under ~/.claude/projects. Run some Claude Code sessions first, or pass
          --claude-dir.
        </div>
      )}
      {projects.map((p) => (
        <div className="project-block" key={p.id}>
          <div className="project-head" onClick={() => toggle(p.id)}>
            <span style={{ color: 'var(--text-dim)' }}>{open[p.id] ? '▾' : '▸'}</span>
            <span className="path">{p.decodedPath}</span>
            <span className="count">
              {p.sessionCount} session{p.sessionCount === 1 ? '' : 's'}
            </span>
          </div>
          {open[p.id] &&
            (filtered[p.id] ? (
              filtered[p.id].map((s) => (
                <div
                  className="session-row"
                  key={s.sessionId}
                  onClick={() => (window.location.hash = `#/s/${s.sessionId}`)}
                >
                  <span className="summary">{s.summary}</span>
                  {s.hasSubagents && <span className="badge accent">subagents</span>}
                  {s.gitBranch && <span className="badge">{s.gitBranch}</span>}
                  <span className="sub">{s.messageCount} msgs</span>
                  <span className="sub">{fmtSize(s.sizeBytes)}</span>
                  <span className="sub">{fmtDate(s.modifiedAt)}</span>
                </div>
              ))
            ) : (
              <div className="sub" style={{ padding: 10, color: 'var(--text-dim)' }}>
                loading…
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}
