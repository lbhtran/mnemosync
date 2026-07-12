import { useCallback, useRef } from 'react';
import type { FlatEvent } from '../playback/reconstruct';
import type { Playback, Speed } from '../playback/usePlayback';

const SPEEDS: Speed[] = [0.5, 1, 2, 4];

function markerFor(e: FlatEvent): { cls: string; glyph: string } | undefined {
  if (e.event.isError) return { cls: 'err', glyph: '◆' };
  switch (e.event.kind) {
    case 'edit':
    case 'write':
    case 'create':
      return { cls: 'edit', glyph: '▲' };
    case 'bash':
      return { cls: 'bash', glyph: '●' };
    default:
      return undefined;
  }
}

export function Scrubber({ playback }: { playback: Playback }) {
  const { events, index, playing, speed } = playback;
  const trackRef = useRef<HTMLDivElement>(null);
  const n = events.length;

  const seekFromPointer = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || n === 0) return;
      const rect = el.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      playback.seek(Math.round(frac * (n - 1)));
    },
    [n, playback],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    playback.pause();
    seekFromPointer(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (e.buttons & 1) seekFromPointer(e.clientX);
  };

  const pct = n > 1 ? (Math.max(0, index) / (n - 1)) * 100 : 0;

  // Compaction boundaries render at their first event position.
  const compactionAt = new Set<number>();
  for (const e of events) {
    if (e.turn.isCompactionBoundary && !compactionAt.has(e.turnIndex)) compactionAt.add(e.eventIndex);
  }

  return (
    <div className="scrubber-bar">
      <div className="controls">
        <button className="primary" onClick={playback.toggle} title="space">
          {playing ? '⏸' : '▶'}
        </button>
        <button onClick={() => playback.stepTurn(-1)} title="shift+←">
          ⏮ turn
        </button>
        <button onClick={() => playback.stepEvent(-1)} title="←">
          ‹ step
        </button>
        <button onClick={() => playback.stepEvent(1)} title="→">
          step ›
        </button>
        <button onClick={() => playback.stepTurn(1)} title="shift+→">
          turn ⏭
        </button>
        <button
          onClick={() => playback.setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}
          title="playback speed"
        >
          {speed}×
        </button>
        <span className="pos">
          {index + 1} / {n} events
          {playback.current ? ` · turn ${playback.current.turnIndex + 1}` : ''}
        </span>
      </div>
      <div
        className="track"
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
      >
        <div className="fill" style={{ width: `${pct}%` }} />
        {events.map((e) => {
          const m = markerFor(e);
          if (!m || n < 2) return null;
          return (
            <span
              key={e.eventIndex}
              className={`marker ${m.cls}`}
              style={{ left: `${(e.eventIndex / (n - 1)) * 100}%` }}
            >
              {m.glyph}
            </span>
          );
        })}
        {[...compactionAt].map((i) => (
          <span key={`c${i}`} className="marker compact" style={{ left: `${(i / Math.max(1, n - 1)) * 100}%` }}>
            │
          </span>
        ))}
        <div className="playhead" style={{ left: `${pct}%` }} />
      </div>
      <div className="legend">
        <span style={{ color: 'var(--accent)' }}>▲ edits</span>
        <span style={{ color: 'var(--bash)' }}>● bash</span>
        <span style={{ color: 'var(--error)' }}>◆ errors</span>
        <span style={{ color: 'var(--thinking)' }}>│ compaction</span>
      </div>
    </div>
  );
}
