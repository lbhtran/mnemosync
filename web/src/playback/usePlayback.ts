// Playback engine: unit of playback = FileEvent. Owns position, play/pause,
// speed; exposes step/seek. Crossing into a new turn with a user prompt
// pauses briefly on an interstitial (the plan → execution rhythm).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Timeline } from '../../../src/shared/types';
import { flattenEvents, ReconstructionEngine, type FlatEvent, type Snapshot } from './reconstruct';

export type Speed = 0.5 | 1 | 2 | 4;

const BASE_EVENT_MS = 1600;
const INTERSTITIAL_MS = 2200;
const POS_KEY_PREFIX = 'mnemosync:pos:';

export interface Playback {
  events: FlatEvent[];
  index: number; // -1 = before first event
  current?: FlatEvent;
  snapshot: Snapshot;
  /** State immediately before the current event — the true "before" for
   *  any before/after diffing the UI wants to do (e.g. CodePanel's
   *  pre-edit flash), rather than hand-inverting the edit. */
  prevSnapshot: Snapshot;
  playing: boolean;
  speed: Speed;
  /** Set while paused on a turn-boundary interstitial card. */
  interstitial?: { prompt: string; turnIndex: number };
  animate: boolean; // false right after a scrub (instant state)
  play(): void;
  pause(): void;
  toggle(): void;
  stepEvent(dir: 1 | -1): void;
  stepTurn(dir: 1 | -1): void;
  seek(index: number): void;
  setSpeed(s: Speed): void;
}

export function usePlayback(timeline: Timeline | undefined, storageKey?: string): Playback {
  const events = useMemo(() => (timeline ? flattenEvents(timeline) : []), [timeline]);
  const engine = useMemo(() => new ReconstructionEngine(events), [events]);
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [interstitial, setInterstitial] = useState<Playback['interstitial']>();
  const [animate, setAnimate] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const restoredRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  // Resume where the user left off on refresh: restore position (and
  // playing state) once the timeline's events are available, keyed per
  // session/subagent so switching sessions doesn't cross-contaminate.
  useEffect(() => {
    if (restoredRef.current || events.length === 0 || !storageKey) return;
    restoredRef.current = true;
    try {
      const raw = localStorage.getItem(POS_KEY_PREFIX + storageKey);
      if (raw) {
        const saved = JSON.parse(raw) as { index?: number; playing?: boolean };
        if (typeof saved.index === 'number' && saved.index >= -1 && saved.index < events.length) {
          setIndex(saved.index);
          setAnimate(false);
          if (saved.playing) setPlaying(true);
        }
      }
    } catch {
      // localStorage unavailable (private mode, quota) — just start fresh
    }
    setHydrated(true);
  }, [events.length, storageKey]);

  // Persist on every position change — cheap (a few bytes), and skipped
  // until hydration above has had a chance to apply the restored value
  // first, so we don't immediately clobber it with the pre-restore -1.
  useEffect(() => {
    if (!hydrated || !storageKey) return;
    try {
      localStorage.setItem(POS_KEY_PREFIX + storageKey, JSON.stringify({ index, playing }));
    } catch {
      // storage unavailable — position just won't survive a refresh
    }
  }, [hydrated, storageKey, index, playing]);

  const snapshot = useMemo(() => engine.stateAt(index), [engine, index]);
  const prevSnapshot = useMemo(() => engine.stateAt(index - 1), [engine, index]);
  const current = index >= 0 ? events[index] : undefined;

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
  };

  const advance = useCallback(() => {
    setIndex((i) => {
      const next = i + 1;
      if (next >= events.length) {
        setPlaying(false);
        return i;
      }
      const prevTurn = i >= 0 ? events[i].turnIndex : -1;
      const nextEv = events[next];
      if (nextEv.turnIndex !== prevTurn && nextEv.turn.userPrompt) {
        setInterstitial({ prompt: nextEv.turn.userPrompt, turnIndex: nextEv.turnIndex });
      }
      return next;
    });
  }, [events]);

  useEffect(() => {
    clear();
    if (!playing) return;
    setAnimate(true);
    const delay = interstitial ? INTERSTITIAL_MS / speed : BASE_EVENT_MS / speed;
    timer.current = setTimeout(() => {
      if (interstitial) setInterstitial(undefined);
      else advance();
    }, delay);
    return clear;
  }, [playing, index, speed, interstitial, advance]);

  const seek = useCallback(
    (i: number) => {
      clear();
      setInterstitial(undefined);
      setAnimate(false);
      setIndex(Math.max(-1, Math.min(i, events.length - 1)));
    },
    [events.length],
  );

  const stepEvent = useCallback(
    (dir: 1 | -1) => {
      setInterstitial(undefined);
      setAnimate(dir === 1);
      setIndex((i) => Math.max(-1, Math.min(i + dir, events.length - 1)));
    },
    [events.length],
  );

  const stepTurn = useCallback(
    (dir: 1 | -1) => {
      setInterstitial(undefined);
      setAnimate(false);
      setIndex((i) => {
        const cur = i >= 0 ? events[i].turnIndex : -1;
        if (dir === 1) {
          const next = events.find((e) => e.turnIndex > cur);
          return next ? next.eventIndex : events.length - 1;
        }
        const prevTurnEvents = events.filter((e) => e.turnIndex < cur);
        if (!prevTurnEvents.length) return -1;
        const prevTurn = prevTurnEvents[prevTurnEvents.length - 1].turnIndex;
        return events.find((e) => e.turnIndex === prevTurn)?.eventIndex ?? -1;
      });
    },
    [events],
  );

  const play = useCallback(() => {
    setAnimate(true);
    setPlaying(true);
    setIndex((i) => (i >= events.length - 1 ? -1 : i)); // replay from start when at end
  }, [events.length]);
  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => (playing ? pause() : play()), [playing, pause, play]);

  useEffect(() => clear, []);

  return {
    events,
    index,
    current,
    snapshot,
    prevSnapshot,
    playing,
    speed,
    interstitial,
    animate,
    play,
    pause,
    toggle,
    stepEvent,
    stepTurn,
    seek,
    setSpeed,
  };
}
