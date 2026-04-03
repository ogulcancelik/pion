# Pion

A messaging bridge connecting Telegram to [pi-agent](https://github.com/badlogic/pi-mono).

> **pion** /ˈpaɪɒn/ — a subatomic particle that mediates forces between others. Like this project mediates messages.

## Features

- **Telegram** — text, photos, stickers, files, long messages sent as `.md` documents
- **Routing** — per-chat or per-contact isolation, match by type/contact/group
- **Sessions** — JSONL persistence, archiving, context usage warnings (85%/95%)
- **Workspace** — SOUL.md, IDENTITY.md, USER.md, MEMORY.md, memory/ directory
- **Skills** — loaded from `~/.pion/skills/`
- **Commands** — `/new` (fresh session), `/compact` (summarize & continue), `/stop` (abort)
- **Steering** — send messages while the agent is still processing
- **Custom tools** — `send_sticker` (from stickers.yaml), `send_file`
- **Monitor TUI** — live session viewer, same look as pi CLI
- **Daemon** — systemd support, watch mode for development

## Quick Start

Prerequisites: [Bun](https://bun.sh), plus OAuth auth for pion.

Pion keeps its own auth file at `~/.pion/auth.json` by default, but uses the same
`auth.json` schema as pi for compatibility.

```bash
bun run login        # anthropic oauth -> ~/.pion/auth.json
```

```bash
bun install

# Copy example config and edit
cp pion.example.yaml ~/.pion/config.yaml
$EDITOR ~/.pion/config.yaml

# Start the daemon
bun run start
```

## Configuration

Config is loaded from `~/.pion/config.yaml` (or `./pion.yaml` for development).

See [`pion.example.yaml`](pion.example.yaml) for a full example covering agents, routing rules, and provider setup.

Key concepts:
- **Agents** — define model, system prompt, and skills per personality
- **Routes** — first matching rule wins; match by contact, group, or chat type
- **Isolation** — `per-chat` (each chat has its own context) or `per-contact` (same person shares context across chats)

## Commands

Messaging commands:

| Command | Description |
|---------|-------------|
| `/new` | Archive current session and start fresh |
| `/compact` | Summarize conversation and continue with reduced context |
| `/stop` | Abort the current agent response |

CLI auth commands:

```bash
bun run login              # login to anthropic and save ~/.pion/auth.json
bun run login anthropic    # same, explicit
bun run login list         # show supported login providers
```

`bun run login` also tries to open the OAuth URL in your desktop browser automatically.

## Monitor TUI

Live session viewer built with pi-tui components.

```bash
bun run monitor
```

Keybindings: `Ctrl+T` toggle thinking blocks, `Ctrl+O` toggle tool expansion.

## Runtime Directory

```text
~/.pion/
├── config.yaml
├── auth.json                (pion auth; schema-compatible with pi auth.json)
├── sessions/                (JSONL conversation history)
│   └── archive/             (archived sessions from /new)
├── skills/                  (skill definitions)
└── agents/
    └── main/
        ├── SOUL.md
        ├── IDENTITY.md
        ├── USER.md
        ├── MEMORY.md
        ├── memory/          (additional .md files)
        └── stickers.yaml    (telegram sticker mappings)
```

You can override the auth location with `authPath` in `~/.pion/config.yaml`.

## Development

```bash
bun run dev              # watch mode
bun run start            # run daemon
bun run monitor          # session monitor TUI
bun test                 # run tests
bun run lint             # biome check
bun run typecheck        # tsc --noEmit
```

## Architecture

```
┌─────────────┐     ┌──────────┐     ┌─────────────┐
│  Providers  │────▶│  Router  │────▶│   Runner    │
│  (Telegram) │     │          │     │  (pi-agent) │
└─────────────┘     └──────────┘     └─────────────┘
       │                 │                  │
       ▼                 ▼                  ▼
┌─────────────┐    ┌──────────┐     ┌─────────────┐
│  Commands   │    │  Config  │     │  Workspace  │
│  (/new etc) │    │  (yaml)  │     │  + Skills   │
└─────────────┘    └──────────┘     └─────────────┘
```

## License

MIT
