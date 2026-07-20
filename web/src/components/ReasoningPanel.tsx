import { memo, useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { FileEvent, Turn } from '../../../src/shared/types';
import { KIND_GLYPH } from '../eventMeta';

marked.setOptions({ gfm: true, breaks: false });

function eventLabel(ev: FileEvent): string {
  switch (ev.kind) {
    case 'create':
    case 'write':
    case 'edit':
    case 'read':
    case 'delete':
    case 'mutate':
      return `${KIND_GLYPH[ev.kind]} ${short(ev.path)}`;
    case 'bash':
      return `${KIND_GLYPH.bash} ${ev.command.split('\n')[0].slice(0, 48)}`;
    case 'subagent':
      return `${KIND_GLYPH.subagent} agent: ${ev.description.slice(0, 40)}`;
    case 'websearch':
      return `${KIND_GLYPH.websearch} ${ev.query.slice(0, 48)}`;
    case 'webfetch':
      return `${KIND_GLYPH.webfetch} ${ev.url.slice(0, 48)}`;
    case 'question':
      return `${KIND_GLYPH.question} ${(ev.questions[0]?.header || ev.questions[0]?.question || 'question').slice(0, 40)}`;
    default:
      return `${KIND_GLYPH.other} ${ev.toolName}`;
  }
}

function short(path: string): string {
  const parts = path.split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : path;
}

const ThinkingBlock = memo(function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const words = content.split(/\s+/).length;
  const preview = content.slice(0, 180);
  return (
    <div className="thinking-block">
      <div className="think-label" onClick={() => setExpanded((e) => !e)}>
        {expanded ? '▾' : '▸'} thinking ({words.toLocaleString()} words)
      </div>
      <div className="preview">
        {expanded ? content : preview + (content.length > 180 ? '…' : '')}
      </div>
    </div>
  );
});

const TextBlock = memo(function TextBlock({ content }: { content: string }) {
  const html = DOMPurify.sanitize(marked.parse(content, { async: false }) as string);
  return <div className="text-block" dangerouslySetInnerHTML={{ __html: html }} />;
});

const TurnCard = memo(function TurnCard({
  turn,
  isActive,
  currentEventId,
  onSeekEvent,
}: {
  turn: Turn;
  isActive: boolean;
  currentEventId?: string;
  onSeekEvent: (eventId: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isActive) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [isActive]);

  return (
    <div className={`turn-card${isActive ? ' active' : ''}`} ref={ref}>
      <div className="turn-head">
        <span>turn {turn.index + 1}</span>
        <span>{new Date(turn.timestamp).toLocaleTimeString()}</span>
        {turn.tokenUsage && <span>{turn.tokenUsage.output} tok out</span>}
      </div>
      {turn.isCompactionBoundary && (
        <div className="compaction-notice">
          ── history compacted here; earlier state may be unreconstructable ──
        </div>
      )}
      {turn.userPrompt !== undefined && <div className="user-prompt">{turn.userPrompt}</div>}
      {turn.reasoning.map((r, i) =>
        r.kind === 'thinking' ? (
          <ThinkingBlock key={i} content={r.content} />
        ) : (
          <TextBlock key={i} content={r.content} />
        ),
      )}
      {turn.events.length > 0 && (
        <div className="event-chips">
          {turn.events.map((ev) => (
            <span
              key={ev.id}
              className={`chip${ev.id === currentEventId ? ' current' : ''}${ev.isError ? ' err' : ''}`}
              title={ev.isError ? `error: ${ev.errorMessage ?? ''}` : ev.rawToolName}
              onClick={() => onSeekEvent(ev.id)}
            >
              {eventLabel(ev)}
              {ev.isError ? ' ⚠' : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  );
});

export function ReasoningPanel({
  turns,
  activeTurnIndex,
  currentEventId,
  onSeekEvent,
}: {
  turns: Turn[];
  activeTurnIndex: number;
  currentEventId?: string;
  onSeekEvent: (eventId: string) => void;
}) {
  return (
    <div className="reasoning-panel">
      {turns.map((t) => (
        <TurnCard
          key={t.id}
          turn={t}
          isActive={t.index === activeTurnIndex}
          currentEventId={t.index === activeTurnIndex ? currentEventId : undefined}
          onSeekEvent={onSeekEvent}
        />
      ))}
    </div>
  );
}
