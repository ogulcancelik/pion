# Pion Architecture

## Overview

Pion is a small chat-native agent runtime built on pi's agent/session stack.

Current shape:

```text
Telegram ─▶ Router ─▶ Debounce / Commands ─▶ Runner (pi agent session)
                           │                      │
                           │                      ├─▶ session JSONL (source of truth)
                           │                      ├─▶ runtime event logs
                           │                      └─▶ SQLite sidecar index
                           └─▶ Telegram live status sink
```

Main responsibilities:

- **Telegram provider** normalizes inbound Telegram updates into Pion messages
- **Router** maps each message to an agent and context key
- **Daemon control flow** handles commands, debouncing, steering, superseding, and recovery
- **Runner** owns the pi agent session for each context, loads prompt resources, and injects native tools
- **Runtime event bus** records both daemon-level and pi SDK events
- **SQLite sidecar** indexes sessions, tool calls, attachments, and runtime events for recall/inspection

Pion is currently **Telegram-only**. The provider interface is richer than the current surface, but only Telegram is implemented today.

## Runtime Data Layout

```text
~/.pion/
├── config.yaml
├── auth.json
├── index.sqlite
├── runtime-events/
│   └── <context>.jsonl
├── sessions/
│   ├── <context>.jsonl
│   └── archive/
├── skills/
│   └── <skill>/SKILL.md
└── agents/
    └── <agent>/
        ├── SOUL.md
        ├── IDENTITY.md
        ├── AGENTS.md
        ├── USER.md
        ├── MEMORY.md
        ├── memory/*.md
        └── stickers.yaml
```

Two important boundaries:

- **Session JSONL files are authoritative conversation history**
- **`index.sqlite` is derived state for fast lookup, search, and monitoring**

## Prompt Resources

Pion builds the base system prompt from the agent workspace in a stable order:

1. `SOUL.md`
2. `IDENTITY.md`
3. `AGENTS.md`
4. `USER.md`
5. `MEMORY.md`
6. `memory/*.md` (sorted by filename)
7. inline `systemPrompt` from config

Selected skills are loaded separately through pi's resource loader.

That gives Pion a simple split:
- **workspace files** = long-lived prompt context
- **skills** = reusable procedures loaded by name
- **session history** = conversation state in JSONL

## Workspace vs Execution CWD

Each agent can set both:

- `workspace` — where prompt resources live (`SOUL.md`, `AGENTS.md`, `MEMORY.md`, stickers)
- `cwd` — where tools and commands execute

If `cwd` is unset, Pion falls back to `workspace`, then `process.cwd()`.

This keeps prompt authoring separate from the actual filesystem/project the agent works in.

## Session Storage

Each routed context gets its own pi-compatible session file:

- `telegram:contact:123` → `sessions/telegram-contact-123.jsonl`
- `telegram:chat:-1001234567890` → `sessions/telegram-chat--1001234567890.jsonl`

The file format matches pi's session JSONL format, so the monitor can read it directly and session replay stays simple.

Archived sessions from `/new` and `/compact` move into `sessions/archive/`.

## Runtime Event Bus

Pion records two event families:

- **Pion runtime events** — message received, buffered, merged, processing start/complete, superseded, warning emitted, output sent
- **Pi session events** — tool execution start/end, message updates, and other SDK-level activity emitted by the underlying agent session

Every context also gets a runtime-event log under `runtime-events/<context>.jsonl`.

That log is separate from session history on purpose:
- session JSONL is the user/assistant/tool conversation record
- runtime events are operational telemetry

## SQLite Sidecar Index

`src/core/sqlite-index.ts` maintains a derived SQLite database with:

- indexed session messages
- indexed tool calls
- indexed attachment references
- indexed runtime events
- per-session metadata

Pion re-syncs session files into the SQLite index after runs complete and records runtime events as they happen.

This makes recall and inspection cheap without replacing JSONL as source of truth.

## Native Recall Tools

Pion injects two native agent-facing recall tools:

### `session_search(query)`

- searches indexed past sessions via SQLite FTS-style lookup
- returns matching session files with snippets and hit counts
- meant for candidate discovery

### `session_query(sessionPath, question)`

- opens one specific JSONL session file
- serializes the relevant conversation
- asks a model a direct question about that session
- answers from JSONL, not from SQLite rows alone

So the architecture is:
- **SQLite** for fast candidate search
- **JSONL session** for authoritative recall answers

## Skills

Pion uses pi's skill loader, but keeps selection simple and explicit.

Per agent, config lists skill names:

```yaml
agents:
  main:
    skills:
      - web-browse
      - supervise
```

Those skills are loaded from `skillsDir` (default `~/.pion/skills`) and exposed through the agent session's resource loader.

Pion does **not** currently load arbitrary pi extensions. The resource loader intentionally provides:
- workspace system prompt
- selected skills
- no custom extension package/runtime discovery

## Provider Tools

Telegram-specific tools are injected per run:

- `send_sticker` — send a named sticker from `stickers.yaml`
- `send_file` — send a file from the local filesystem

Native recall tools are injected alongside them:
- `session_search`
- `session_query`

## Message Lifecycle

1. Telegram update becomes a normalized Pion message
2. Router picks the agent + context key
3. Commands (`/new`, `/compact`, `/stop`) bypass normal prompting
4. Non-command messages enter the debounce buffer (unless `debounceMs: 0`)
5. When flushed, messages may be merged into a single prompt
6. On the first real user turn of a new day, Pion may perform a cheap git update check for its own checkout
7. If that checkout is behind upstream, Pion injects a hidden `[SYSTEM]` note into that user turn instead of sending an operator-facing alert
8. Attachments are materialized to temp files and referenced in prompt text
9. Runner resumes or creates the pi agent session
10. Output streams back to Telegram while runtime events are recorded
11. Session JSONL and SQLite index are synced

## Run Control Semantics

Pion is built for chat behavior rather than one-shot CLI turns:

- **debounce** batches rapid-fire fragments into one user turn
- **steering** injects new user text into an active run when the underlying pi session is streaming
- **superseding** cancels/suppresses older runs when new messages arrive or `/stop` is issued
- **compaction** summarizes the conversation and primes a fresh session

## Attachment Pipeline

Inbound Telegram media is normalized, then materialized to temp files under `/tmp/pion-media/<context>/`.

Prompt text gets explicit attachment markers like:

```text
[User attached image: /tmp/pion-media/.../photo.jpg]
```

That keeps the runtime simple:
- the agent can inspect actual files if needed
- attachment references are also discoverable in the SQLite index

## Current Non-Goals

These are intentionally not part of Pion right now:

- general extension loading
- alternate provider backends beyond Telegram
- a separate web UI/control plane
- replacing JSONL sessions with a database-native conversation store
- a large autonomous memory platform beyond workspace files + session recall + skills
