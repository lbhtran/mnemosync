<p align="center">
  <img src="docs/brand/lockup.svg" alt="mnemosync — game tape for your coding agent" width="360">
</p>

The name is a small pun: Mnemosyne, the Titaness of memory — and two panels
playing back in sync.

Replay Claude Code sessions as an animated timeline: code changes play back in
an editor while Claude's reasoning is shown alongside, with scrubber/playback
controls like a video editor.

Fully local. No network calls, no telemetry, no uploads — the server binds
`127.0.0.1` by default; exposing it to your LAN requires the explicit
`--lan` flag.

## Getting started

```bash
git clone https://github.com/lbhtran/mnemosync.git
cd mnemosync
npm install -g .        # builds the CLI + web bundle, then links it globally
mnemosync               # starts the viewer and opens your browser
```

`npm install -g .` also works as `npm install -g github:lbhtran/mnemosync`
for anyone with access to the (currently private) repo — a `prepare` script
builds the server and frontend automatically on install, no separate build
step needed.

CLI:

```
mnemosync [options]                 start the viewer (opens browser)
mnemosync summary <session|file>    print a text summary of a session
mnemosync list                      list discovered projects/sessions

--claude-dir <path>   Claude data dir (default: ~/.claude)
--port <n>            port (default: random free port)
--no-open             don't open the browser
--lan                 also listen on the local network (0.0.0.0).
                      WARNING: anyone on the network can read your
                      session transcripts. Default is 127.0.0.1 only.
```

Running on a headless machine? Either tunnel the loopback-only default
(`ssh -L 8080:127.0.0.1:<port> user@host`) or run with `--lan` on a network
you trust. For a persistent setup, a systemd unit works well:

```ini
[Service]
User=you
ExecStart=/usr/bin/node /path/to/mnemosync/dist/cli.js --no-open --lan --port 4573
Restart=on-failure
```

## Development

```bash
npm install
npm run build              # builds server (tsc) + frontend (vite)
npm run dev                 # backend on a random port, --no-open
npm run dev --prefix web    # vite dev server with /api proxy (port 4573 backend)
```

## How it works

```
CLI  →  local HTTP server (Node ≥18, zero runtime deps)
          ├─ src/parser/   ★ ALL JSONL format knowledge lives here
          │    discover.ts   find projects/sessions/subagents under ~/.claude
          │    parse.ts      defensive, streamed JSONL → raw records (never
          │                  crashes, never loads a multi-hundred-MB
          │                  transcript fully into memory)
          │    normalize.ts  raw records → Timeline/Turn/FileEvent schema
          └─ src/server/   REST API + static frontend
        →  web/ (React + Vite + Monaco)
             playback/reconstruct.ts  file state at any point (checkpoints
                                      every N events → backward scrub = jump
                                      to checkpoint + replay forward)
             playback/usePlayback.ts  play/pause/speed/step/seek engine
```

The transcript format is undocumented and changes between Claude Code
versions; everything format-specific is confined to `src/parser/` behind the
stable schema in `src/shared/types.ts`, which is the only thing the frontend
ever sees.

### Replay semantics worth knowing

- **Turns, not tool calls.** Events are grouped into think→act cycles so
  playback reads as "here's the plan → watch it execute". User prompts show
  as interstitial cards at turn boundaries.
- **Ground-truth reconstruction.** Edit results in transcripts carry the full
  pre-edit file (`originalFile`), so file state is usually exact. When an
  edit's `old_string` can't be found, the file is marked **≈ approximate**
  and the edit is shown as an isolated old→new diff — never silently-wrong
  content. The approximate banner distinguishes *why*: content cut at the
  2MB capture cap (the edit likely landed past what we captured) reads
  differently from a genuine desync (e.g. a mutating bash command changed
  the file from underneath us).
- **Unrecognized file-mutating tools never go silently invisible.** A tool
  we don't have explicit diff parsing for (e.g. MultiEdit, NotebookEdit, or
  whatever ships next) is detected by its `file_path`/`notebook_path` input
  and marked **≈ approximate** rather than leaving the file's displayed
  content stale with no indication anything happened.
- **Failed tool calls never mutate state.** They render with an error badge;
  retries and dead ends are part of the story.
- **Compaction boundaries** (`system/compact_boundary`) are marked on the
  timeline; earlier state may be unreconstructable and is treated as a fresh
  start.
- **Position survives a refresh.** Playback position and play/pause state
  are persisted to `localStorage` per session/subagent
  (`web/src/playback/usePlayback.ts`), so reloading the page resumes where
  you left off instead of restarting from the first event.

### Visual language

- A badge on the code panel names what's happening to the open file right
  now: `👁 reading`, `✎ editing`, `✚ writing`/`created`, `✕ deleted`. The same
  glyph for a given event kind is used consistently across the scrubber
  track, reasoning panel, and code panel badge (`web/src/eventMeta.ts` is the
  single source of truth), so the same action never looks different
  depending which panel you're looking at.
- Added lines glow green and fade. An edit's old text flashes red in place
  for a beat before the swap, so add vs. remove reads at a glance instead of
  just "something changed". Reads get their own brief blue highlight over
  the lines actually revealed — including the correct sub-range for a
  windowed `Read` with `offset`/`limit`, not just the top of the file.
- The light/dark toggle (`web/src/components/ThemeToggle.tsx`) is present on
  every screen the app can render — picker, replay, and both pages' loading
  and error states — not just the fully-loaded view.
- The replay header is split into three rows: navigation (top-left) and the
  theme toggle (top-right) on the first row, the session title alone on the
  second, and secondary metadata (project path, timestamp, model, branch,
  turn/event counts) on a third — so the toggle stays reachable and a long
  session title doesn't crowd it out.
- `WebSearch`, `WebFetch`, and `AskUserQuestion` each open as their own
  centered popup over the code panel — query/URL/question plus the actual
  result (links, fetched content, or the option the user picked) — instead
  of being lumped into the generic tool overlay as a raw JSON dump.
- An unrecognized tool rendered as a generic event (`⚠`, legend: "unrecognized
  tool") gets its own scrubber marker, distinct from the edit/bash/error
  markers — it's the one parser diagnostic that maps onto an actual replay
  moment. The rest of `meta.parseWarnings` (malformed/skipped lines, unknown
  record types, an out-of-order re-sort) describe lines that never became an
  event at all, so there's nowhere in the replay to point to them; they're
  logged to the browser console instead of shown in the UI.

### Keyboard

`space` play/pause · `←`/`→` step event · `shift+←`/`→` step turn.

### Mobile

Narrow screens get a dedicated layout: the reasoning and code panels become
swipeable tabs instead of a fixed side-by-side split, with touch-sized
scrubber controls. Tapping an event chip or hitting an autoplay interstitial
jumps you to the code tab automatically.

## API

```
GET /api/projects
GET /api/projects/:id/sessions
GET /api/sessions/:sessionId/timeline?offset=0&limit=200
GET /api/sessions/:sessionId/subagents/:agentId/timeline
GET /api/health
```

Session/project ids are validated against the discovered index — client input
is never interpolated into filesystem paths.

## Tests

```bash
npm test
```

Fixtures in `src/parser/fixtures/` are anonymized transcripts modeled on real
record shapes (including a truncated final line, an unknown record type, an
error tool result, and a compaction boundary). The reconstruction suite
verifies the checkpointed engine agrees exactly with a naive full replay while
scrubbing randomly through a 600+ event synthetic session — and through the
largest real session on the machine, when one exists.

## Notes

- Monaco is served as pre-built static files (`web/public/vs`, copied from
  `node_modules` at build time) rather than bundled — keeps the app fully
  offline and lets the frontend build on low-memory machines (it OOMs a
  Raspberry Pi otherwise).
- v1 is a read-only viewer. Live tailing, export, cross-project search, and
  session compare are v2 candidates.

## License

MIT — see [LICENSE](LICENSE).
