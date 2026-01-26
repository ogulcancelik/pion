# Runtime Architecture

## Overview

Pion runs as two independent processes:

1. **Daemon** (`src/daemon.ts`) — single long-running Bun process that handles all messaging
2. **Monitor** (`src/tui/monitor.ts`) — optional read-only TUI that watches session files

There is no IPC between them. The monitor reads JSONL session files directly via `fs.watch`.

## Daemon

The daemon is a single Bun process that starts providers, routes messages, and runs pi-agent sessions.

```
┌─────────────────────────────────────────────────────────────────────┐
│                       DAEMON (bun run daemon)                       │
│                                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────────────┐│
│  │  Telegram   │  │  WhatsApp   │  │         Core                 ││
│  │  Provider   │  │  Provider   │  │  ┌────────┐  ┌────────────┐  ││
│  │             │  │             │  │  │ Router │  │  Runner     │  ││
│  │  grammy     │  │  baileys    │  │  └────────┘  │  (sessions) │  ││
│  │  polling    │  │  websocket  │  │  ┌────────┐  └────────────┘  ││
│  └──────┬──────┘  └──────┬──────┘  │  │Commands│                  ││
│         │                │         │  └────────┘                  ││
│         └────────────────┴─────────┴──────────────────────────────┘│
│                                                                     │
│  Sessions written to: ~/.pion/sessions/*.jsonl                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Startup

1. Load config from `~/.pion/config.yaml` (or `./pion.yaml` for dev)
2. Ensure agent workspaces exist (creates default SOUL.md if missing)
3. Start Telegram provider (if configured)
4. Send startup notification (if `telegram.startupNotify` is set)
5. Start WhatsApp provider (if configured and paired)
6. Begin accepting messages

### Message Flow

1. Provider receives message → calls `handleMessage()`
2. Router matches message to agent via config routes
3. If message is a command (`/new`, `/compact`, `/stop`) → handle directly
4. If session is already streaming → steer (inject message mid-response)
5. Otherwise → create/resume pi-agent session, process message
6. Send response chunks back via provider
7. Check context usage, send warnings if needed

### Signal Handling

| Signal | Behavior |
|--------|----------|
| `SIGINT` | Graceful shutdown |
| `SIGTERM` | Graceful shutdown |
| `SIGHUP` | Logged but not yet implemented (config reload) |

Graceful shutdown stops all providers and exits cleanly.

### Running

```bash
# Direct
bun run daemon

# Or
bun run src/daemon.ts
```

## Systemd Service

```ini
# ~/.config/systemd/user/pion.service
[Unit]
Description=Pion Messaging Bridge
After=network.target

[Service]
Type=simple
# Update these paths to match your setup
ExecStart=%h/.bun/bin/bun run %h/Projects/pion/src/daemon.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
# Enable and start
systemctl --user enable pion
systemctl --user start pion

# Check status
systemctl --user status pion

# View logs
journalctl --user -u pion -f
```

## Monitor TUI

A separate read-only process that displays a session's messages in real-time using pi-tui components.

```bash
# Watch most recently modified session
bun run monitor

# Watch a specific session
bun run monitor telegram-contact-123
```

### How it works

1. Finds session JSONL file (most recent, or by name)
2. Parses all entries and renders using pi's `UserMessageComponent`, `AssistantMessageComponent`, `ToolExecutionComponent`
3. Watches the file with `fs.watch()` for live updates
4. No connection to the daemon — just reads files

### Keybindings

| Key | Action |
|-----|--------|
| `Ctrl+T` | Toggle thinking block visibility |
| `Ctrl+O` | Toggle tool output expansion |
| `q` / `Ctrl+C` | Exit |

## File Layout at Runtime

```
~/.pion/
├── config.yaml           # Main config
├── auth.json             # Anthropic OAuth credentials
├── sessions/             # Active sessions (JSONL)
│   ├── telegram-contact-123.jsonl
│   ├── whatsapp-chat-friends.jsonl
│   └── archive/          # Old sessions from /new and /compact
├── skills/               # Skill directories
├── whatsapp-auth/        # WhatsApp credentials
│   └── creds.json
└── agents/
    └── main/
        ├── SOUL.md
        └── ...
```

## Comparison with Clawdbot

| Aspect | Clawdbot | Pion |
|--------|----------|------|
| Architecture | Separate gateway + workers | Single daemon process |
| IPC | WebSocket + HTTP | None (file-based) |
| Web UI | Yes | No (TUI monitor only) |
| Config | JSON | YAML |
| Session format | Custom | pi-agent JSONL |
| Complexity | High (~170k LOC) | Low (<5k LOC) |
| Agent | Custom | pi-agent (shared with pi CLI) |

## Trade-offs

**Pros:**
- Simple single-process daemon — easy to debug and operate
- Systemd handles process management, restarts, logging
- No inter-process coordination
- Sessions persist to disk — daemon can restart cleanly
- Monitor is independent — connect/disconnect anytime

**Cons:**
- Can't scale across machines (fine for personal use)
- Provider crash takes down everything (restart is fast)
- No hot code reload (need restart for code changes)
- No config reload without restart (SIGHUP not yet implemented)
