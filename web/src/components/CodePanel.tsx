import { useEffect, useMemo, useRef, useState } from 'react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import type { FileEvent } from '../../../src/shared/types';
import type { Snapshot } from '../playback/reconstruct';
import { languageFor, looksBinary } from '../monacoSetup';

const MAX_EDITOR_CHARS = 800_000; // huge files: truncate for rendering

/** Locate the line range newStr landed on so we can highlight it. */
function changedRange(content: string, needle: string): [number, number] | undefined {
  if (!needle) return undefined;
  const pos = content.indexOf(needle);
  if (pos < 0) return undefined;
  const startLine = content.slice(0, pos).split('\n').length;
  const lineCount = needle.split('\n').length;
  return [startLine, startLine + lineCount - 1];
}

function actionMeta(event: FileEvent): { label: string; cls: string } | undefined {
  switch (event.kind) {
    case 'read':
      return { label: '👁 reading', cls: 'read' };
    case 'edit':
      return { label: '✎ editing', cls: 'edit' };
    case 'create':
      return { label: '✚ created', cls: 'write' };
    case 'write':
      return { label: '✚ writing', cls: 'write' };
    case 'delete':
      return { label: '✕ deleted', cls: 'delete' };
    default:
      return undefined;
  }
}

function EventOverlay({ event }: { event: FileEvent }) {
  const [expanded, setExpanded] = useState(false);
  if (event.kind === 'bash') {
    const out = event.output ?? '';
    return (
      <div className={`event-overlay bash${event.isError ? ' err' : ''}`}>
        <div className="cmd">{event.command}</div>
        {event.isError && (
          <div style={{ color: 'var(--error)', marginTop: 6 }}>
            ⚠ failed{event.errorMessage ? `: ${event.errorMessage.slice(0, 200)}` : ''}
          </div>
        )}
        {out && (
          <pre onClick={() => setExpanded((e) => !e)} style={{ cursor: 'pointer' }}>
            {expanded || out.length < 600 ? out : out.slice(0, 600) + '\n… (click to expand)'}
          </pre>
        )}
        {event.mutating && !event.isError && (
          <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 6 }}>
            ⚠ file-mutating command — reconstructed state may be approximate
          </div>
        )}
      </div>
    );
  }
  if (event.kind === 'subagent') {
    return (
      <div className="event-overlay">
        <div>
          ⛭ <b>subagent</b> — {event.description || '(no description)'}
        </div>
        {event.agentId && (
          <button
            style={{ marginTop: 8 }}
            onClick={() => {
              const m = window.location.hash.match(/#\/s\/([^/]+)/);
              if (m) window.location.hash = `#/s/${m[1]}/agent/${event.agentId}`;
            }}
          >
            open subagent replay →
          </button>
        )}
      </div>
    );
  }
  if (event.kind === 'other') {
    return (
      <div className={`event-overlay${event.isError ? ' err' : ''}`}>
        <div>
          ◦ <b>{event.toolName}</b>
          {event.isError ? ' ⚠ failed' : ''}
        </div>
        <pre>{event.summary}</pre>
      </div>
    );
  }
  if (event.isError) {
    return (
      <div className="event-overlay err">
        ⚠ {event.rawToolName} failed{event.errorMessage ? `: ${event.errorMessage.slice(0, 300)}` : ''}
      </div>
    );
  }
  return null;
}

export function CodePanel({
  snapshot,
  currentEvent,
  animate,
  theme,
  interstitialPrompt,
}: {
  snapshot: Snapshot;
  currentEvent?: FileEvent;
  animate: boolean;
  theme: 'dark' | 'light';
  interstitialPrompt?: string;
}) {
  const editorRef = useRef<editor.IStandaloneCodeEditor>();
  const decorations = useRef<editor.IEditorDecorationsCollection>();
  const [selectedTab, setSelectedTab] = useState<string>();

  const tabs = useMemo(
    () => [...snapshot.files.keys()].filter((p) => snapshot.files.get(p)!.everSeen),
    [snapshot],
  );

  // Active tab follows the current event's file; manual tab choice sticks
  // until the playhead touches another file.
  const autoFile = snapshot.activeFile && snapshot.files.get(snapshot.activeFile)?.everSeen
    ? snapshot.activeFile
    : undefined;
  useEffect(() => {
    if (autoFile) setSelectedTab(autoFile);
  }, [autoFile]);
  const active = selectedTab && tabs.includes(selectedTab) ? selectedTab : (autoFile ?? tabs[tabs.length - 1]);

  const file = active ? snapshot.files.get(active) : undefined;
  const showIsolatedDiff =
    snapshot.isolatedDiff && currentEvent?.kind === 'edit' && snapshot.isolatedDiff.path === active;

  const content = useMemo(() => {
    if (!file) return '';
    return file.content.length > MAX_EDITOR_CHARS
      ? file.content.slice(0, MAX_EDITOR_CHARS) + '\n… [truncated for rendering]'
      : file.content;
  }, [file]);

  const binary = useMemo(() => looksBinary(content), [content]);

  // Momentary pre-edit override: for a live (animate=true) edit we show the
  // doomed range flashed red for a beat before swapping to the final
  // content. Keyed to the content it was derived from, so any unrelated
  // content change (e.g. switching tabs) invalidates it automatically
  // instead of flashing stale text.
  const [transientOld, setTransientOld] = useState<{ forContent: string; value: string } | null>(null);
  const [decoration, setDecoration] = useState<{ range: [number, number]; cls: string }>();
  const displayValue = transientOld && transientOld.forContent === content ? transientOld.value : content;

  useEffect(() => {
    setTransientOld(null);
    if (showIsolatedDiff || !active) {
      setDecoration(undefined);
      return;
    }
    if (!currentEvent || !('path' in currentEvent) || currentEvent.path !== active) {
      setDecoration(undefined);
      return;
    }
    const ev = currentEvent;

    const addRangeFor = (val: string): [number, number] | undefined => {
      if (ev.kind === 'edit') return changedRange(val, ev.newStr);
      if (ev.kind === 'create' || ev.kind === 'write') return [1, Math.min(val.split('\n').length, 40)];
      return undefined;
    };

    if (ev.kind === 'edit' && animate && ev.oldStr) {
      const prevContent = ev.replaceAll
        ? content.split(ev.newStr).join(ev.oldStr)
        : content.replace(ev.newStr, ev.oldStr);
      const removeRange = prevContent !== content ? changedRange(prevContent, ev.oldStr) : undefined;
      if (removeRange) {
        setTransientOld({ forContent: content, value: prevContent });
        setDecoration({ range: removeRange, cls: 'removed-line' });
        const t = setTimeout(() => {
          setTransientOld(null);
          const addRange = addRangeFor(content);
          setDecoration(addRange ? { range: addRange, cls: 'added-line' } : undefined);
        }, 480);
        return () => clearTimeout(t);
      }
    }
    const addRange = addRangeFor(content);
    setDecoration(addRange ? { range: addRange, cls: animate ? 'added-line' : 'added-line-instant' } : undefined);
  }, [content, currentEvent, active, animate, showIsolatedDiff]);

  // Apply the decoration once Monaco's model has caught up to displayValue
  // (this effect runs after the child <Editor>'s own value-sync effect).
  useEffect(() => {
    const ed = editorRef.current;
    decorations.current?.clear();
    if (!ed || !decoration) return;
    decorations.current = ed.createDecorationsCollection([
      {
        range: { startLineNumber: decoration.range[0], startColumn: 1, endLineNumber: decoration.range[1], endColumn: 1 },
        options: { isWholeLine: true, className: decoration.cls },
      },
    ]);
    ed.revealLinesInCenterIfOutsideViewport(decoration.range[0], decoration.range[1]);
  }, [decoration, displayValue]);

  const activeAction =
    currentEvent && active && 'path' in currentEvent && currentEvent.path === active
      ? actionMeta(currentEvent)
      : undefined;

  const monacoTheme = theme === 'dark' ? 'vs-dark' : 'vs';
  const opts: editor.IStandaloneEditorConstructionOptions = {
    readOnly: true,
    minimap: { enabled: false },
    fontSize: 12.5,
    scrollBeyondLastLine: false,
    renderWhitespace: 'none',
    wordWrap: 'off',
    domReadOnly: true,
  };

  return (
    <div className="code-panel">
      <div className="file-tabs">
        {tabs.map((p) => (
          <div
            key={p}
            className={`file-tab${p === active ? ' active' : ''}`}
            title={p}
            onClick={() => setSelectedTab(p)}
          >
            {p.split('/').slice(-1)[0]}
            {snapshot.files.get(p)?.desynced && <span className="badge warn">≈</span>}
          </div>
        ))}
      </div>
      <div className="editor-wrap">
        {activeAction && (
          <span className={`action-indicator ${activeAction.cls}`}>{activeAction.label}</span>
        )}
        {file?.desynced && !showIsolatedDiff && (
          <div className="desync-banner">≈ state approximate</div>
        )}
        {showIsolatedDiff && snapshot.isolatedDiff ? (
          <>
            <div className="desync-banner">≈ approximate — showing this edit in isolation</div>
            <DiffEditor
              original={snapshot.isolatedDiff.oldStr}
              modified={snapshot.isolatedDiff.newStr}
              language={languageFor(snapshot.isolatedDiff.path)}
              theme={monacoTheme}
              options={{ ...opts, renderSideBySide: true }}
            />
          </>
        ) : !active || !file ? (
          <div className="editor-empty">
            <div>no file content yet</div>
            <div style={{ fontSize: 11.5 }}>
              press <kbd>space</kbd> to play · <kbd>←</kbd>/<kbd>→</kbd> step event ·{' '}
              <kbd>shift</kbd>+<kbd>←</kbd>/<kbd>→</kbd> step turn
            </div>
          </div>
        ) : binary ? (
          <div className="editor-empty">
            <div>{active}</div>
            <div>binary or non-text content — not rendered</div>
          </div>
        ) : (
          <Editor
            path={active}
            value={displayValue}
            language={languageFor(active)}
            theme={monacoTheme}
            options={opts}
            onMount={(ed) => (editorRef.current = ed)}
          />
        )}
        {currentEvent && <EventOverlay event={currentEvent} />}
        {interstitialPrompt !== undefined && (
          <div className="interstitial">
            <div className="card">
              <div className="label">USER</div>
              {interstitialPrompt}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
