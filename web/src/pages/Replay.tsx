import { useEffect, useState } from 'react';
import type { Timeline } from '../../../src/shared/types';
import { fetchTimeline } from '../api';
import { usePlayback } from '../playback/usePlayback';
import { ReasoningPanel } from '../components/ReasoningPanel';
import { CodePanel } from '../components/CodePanel';
import { Scrubber } from '../components/Scrubber';
import { ThemeToggle } from '../components/ThemeToggle';

export function Replay({
  sessionId,
  agentId,
  theme,
  onToggleTheme,
}: {
  sessionId: string;
  agentId?: string;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}) {
  const [timeline, setTimeline] = useState<Timeline>();
  const [error, setError] = useState<string>();
  const [mobileView, setMobileView] = useState<'reasoning' | 'code'>('code');
  const playback = usePlayback(timeline);

  useEffect(() => {
    fetchTimeline(sessionId, agentId)
      .then((t) => {
        setTimeline(t);
        // Parser-level diagnostics (skipped/malformed lines, unknown record
        // types, timestamp re-sorts) don't map onto a replay moment — no
        // event exists for a line that failed to parse — so there's nowhere
        // meaningful to show them in the UI. Console is for debugging a
        // parser issue, not a user-facing signal.
        if (t.meta.parseWarnings.length > 0) {
          console.warn(`mnemosyne: ${t.meta.parseWarnings.length} parse warning(s) for this session:`, t.meta.parseWarnings);
        }
      })
      .catch((e) => setError(String(e)));
  }, [sessionId, agentId]);

  // Keyboard: space play/pause, ←/→ step event, shift+←/→ step turn.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        playback.toggle();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        e.shiftKey ? playback.stepTurn(1) : playback.stepEvent(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        e.shiftKey ? playback.stepTurn(-1) : playback.stepEvent(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playback]);

  // Autoplay's interstitial cards render inside the code panel; jump there so
  // they're visible even if the reasoning tab was active on mobile.
  useEffect(() => {
    if (playback.interstitial) setMobileView('code');
  }, [playback.interstitial]);

  if (error)
    return (
      <div className="error-page">
        <ThemeToggle theme={theme} onToggleTheme={onToggleTheme} compact />
        <div>mnemosyne</div>
        <div className="msg">{error}</div>
        <a href="#/" style={{ color: 'var(--accent)' }}>
          ← back to sessions
        </a>
      </div>
    );
  if (!timeline) {
    return (
      <div className="loading">
        <ThemeToggle theme={theme} onToggleTheme={onToggleTheme} compact />
        parsing session…
      </div>
    );
  }

  const { meta } = timeline;
  const activeTurnIndex = playback.current?.turnIndex ?? -1;

  const seekToEventId = (id: string) => {
    const target = playback.events.find((e) => e.event.id === id);
    if (target) {
      playback.pause();
      playback.seek(target.eventIndex);
      setMobileView('code');
    }
  };

  return (
    <div className="replay-root" data-mobile-view={mobileView}>
      <header className="app-header">
        <a className="brand" href={agentId ? `#/s/${sessionId}` : '#/'}>
          {agentId ? '← session' : '← mnemosyne'}
        </a>
        <ThemeToggle theme={theme} onToggleTheme={onToggleTheme} compact />
      </header>
      <div className="title-bar">
        <span className="title">
          {agentId ? `subagent ${agentId}` : (meta.summary ?? meta.sessionId)}
        </span>
      </div>
      <div className="settings-bar">
        <span className="meta meta-optional">{meta.projectPath}</span>
        <span className="meta meta-optional">{new Date(meta.startedAt).toLocaleString()}</span>
        {meta.model && <span className="badge meta-optional">{meta.model}</span>}
        {meta.gitBranch && <span className="badge meta-optional">{meta.gitBranch}</span>}
        <span className="meta meta-optional">
          {meta.turnCount} turns · {meta.eventCount} events
        </span>
      </div>
      <div className="mobile-tabs">
        <button
          className={mobileView === 'reasoning' ? 'active' : ''}
          onClick={() => setMobileView('reasoning')}
        >
          reasoning
        </button>
        <button
          className={mobileView === 'code' ? 'active' : ''}
          onClick={() => setMobileView('code')}
        >
          code
        </button>
      </div>
      <div className="replay-main">
        <ReasoningPanel
          turns={timeline.turns}
          activeTurnIndex={activeTurnIndex}
          currentEventId={playback.current?.event.id}
          onSeekEvent={seekToEventId}
        />
        <CodePanel
          snapshot={playback.snapshot}
          prevSnapshot={playback.prevSnapshot}
          currentEvent={playback.current?.event}
          animate={playback.animate}
          theme={theme}
          interstitialPrompt={playback.interstitial?.prompt}
        />
      </div>
      <Scrubber playback={playback} />
    </div>
  );
}
