# Pion

A simple chat-native agent runtime built on the [pi SDK](https://github.com/badlogic/pi-mono).

Pion stays opinionated and small: one daemon, one current provider surface (Telegram), pi-compatible session files, workspace-driven prompting, pi-native resource discovery, and a read-only monitor.

> **pion** /ˈpaɪɒn/ — a subatomic particle that mediates forces between others.

## Features

- **Telegram-first runtime** — text, photos, stickers, voice notes, documents, long responses as Telegram documents when needed
- **Routing + isolation** — match by DM/group/contact/chat ID with `per-contact` or `per-chat` session isolation
- **pi-native sessions** — JSONL session files remain the source of truth
- **Runtime observability** — per-context runtime event logs plus a live monitor snapshot
- **Default recall/web packages** — Pion installs `pi-session-recall` and `pi-web-browse` into `~/.pion` on first run when missing
- **Workspace prompting** — `SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`, `memory/*.md`, and `memory/daily/*.md`
- **Separate prompt/work execution roots** — `workspace` can differ from execution `cwd`
- **Skills and extensions** — discovered through pi's resource loader from `~/.pion`
- **Chat-native control flow** — debounce rapid-fire messages, steer active runs, `/new`, `/compact`, `/stop`
- **Telegram live status** — editable "working/tool activity" status message while the agent runs
- **Native/provider tools** — `remember`, `subagent`, `save_subagent`, `list_subagents`, `send_sticker`, and `send_file`
- **Monitor TUI** — read-only session viewer built with pi-tui components

## Quick Start

Prerequisites:
- [Bun](https://bun.sh)
- pi-compatible auth (Pion stores its own multi-provider auth file by default at `~/.pion/auth.json`)

```bash
bun install
bun run login

cp pion.example.yaml ~/.pion/config.yaml
$EDITOR ~/.pion/config.yaml

bun run start
```

`bun run login` stores auth in `~/.pion/auth.json` by default. The file format matches pi's `auth.json`, but the path is separate unless you override `authPath`. One auth file can hold multiple providers at once, including OAuth subscriptions and plain API keys.

## Configuration

Config is loaded from:

1. `~/.pion/config.yaml` / `~/.pion/config.yml`
2. `./pion.yaml` / `./pion.yml`
3. `./config.yaml` / `./config.yml`

See [`pion.example.yaml`](pion.example.yaml) for a working example.

Key concepts:
- **agents** — choose a model, optional `thinkingLevel`, prompt workspace, optional execution `cwd`, inline prompt text, and selected extra skills
- **routes** — first match wins; send a chat to an agent or ignore it with `agent: null`
- **workspace vs cwd** — `workspace` provides prompt files; `cwd` is where tools/commands execute
- **resource discovery** — default packages plus `~/.pion/skills` and `~/.pion/extensions` are loaded through pi's resource loader
- **debounceMs** — batch rapid message fragments before a run starts

`thinkingLevel` accepts `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`.

## Commands

| Command | Description |
|---------|-------------|
| `/new` | Archive the current session and start fresh |
| `/compact [focus]` | Summarize the current conversation and continue in a fresh session |
| `/stop` | Supersede the active run |

CLI auth commands:

```bash
bun run login
bun run login anthropic
bun run login openai-codex
bun run login minimax --api-key "$MINIMAX_API_KEY"
bun run login list
```

## Resource Discovery

On daemon startup, Pion points pi's agent directory at `~/.pion` and best-effort installs two default packages when they are missing:

- `npm:@ogulcancelik/pi-session-recall`
- `npm:@ogulcancelik/pi-web-browse`

The session recall package provides `session_search` and `session_query`. Pion itself keeps JSONL session files as the conversation source of truth and does not maintain a SQLite recall sidecar.

## Runtime Directory

```text
~/.pion/
├── config.yaml
├── auth.json                 # Pion auth for multiple providers (schema-compatible with pi auth.json)
├── runtime-events/           # Per-context runtime event logs (JSONL)
├── sessions/                 # pi-compatible session JSONL files
│   └── archive/              # Archived sessions from /new and /compact
├── skills/                   # Skill directories (SKILL.md)
├── extensions/               # pi-native extensions
├── agent-profiles.json       # Saved subagent/profile definitions
└── agents/
    └── main/
        ├── SOUL.md
        ├── IDENTITY.md
        ├── AGENTS.md
        ├── USER.md
        ├── MEMORY.md
        ├── memory/           # Additional prompt fragments (*.md, sorted)
        └── stickers.yaml     # Telegram sticker name -> file_id mappings
```

Incoming media is materialized into temporary files under `/tmp/pion-media/<context>/` before being referenced in the agent prompt.

## Monitor TUI

```bash
bun run monitor
bun run monitor telegram-contact-123
```

Keybindings:
- `Ctrl+T` toggle thinking blocks
- `Ctrl+O` toggle tool expansion
- `q` / `Ctrl+C` quit

## Development

```bash
bun run dev
bun run start
bun run monitor
bun test
bun run lint
bun run typecheck
```

## Architecture

```text
Telegram ─▶ Router ─▶ Debounce / Commands ─▶ Runner (pi agent session)
                           │                      │
                           │                      ├─▶ session JSONL
                           │                      ├─▶ runtime events JSONL
                           │                      └─▶ monitor snapshot
                           └─▶ Telegram live status
```

For more detail:
- [`docs/architecture.md`](docs/architecture.md)
- [`docs/runtime.md`](docs/runtime.md)
- [`docs/resource-discovery-spec.md`](docs/resource-discovery-spec.md)
- [`docs/recall-tool-design.md`](docs/recall-tool-design.md)

## License

MIT
