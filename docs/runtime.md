# Runtime Architecture

## Overview

Pion currently runs as two independent processes:

1. **Daemon** (`src/daemon.ts`) — the long-running Telegram + agent runtime
2. **Monitor** (`src/tui/monitor.ts`) — a read-only TUI that watches one session file

There is no IPC layer between them. The daemon writes JSONL/session artifacts; the monitor reads session files directly.

## Daemon

The daemon owns:

- Telegram ingress/egress
- routing and isolation
- command handling
- message debouncing
- pi agent session lifecycle
- runtime event logging
- SQLite sidecar indexing
- Telegram live status updates
- crash/restart recovery bookkeeping

```text
┌────────────────────────────────────────────────────────────────────┐
│                         PION DAEMON                               │
│                                                                    │
│  Telegram Provider ─▶ Router ─▶ Debouncer / Commands ─▶ Runner     │
│         │                                            │             │
│         │                                            ├─▶ sessions  │
│         │                                            ├─▶ events    │
│         └──────────────▶ Telegram status sink ◀──────└─▶ sqlite    │
└────────────────────────────────────────────────────────────────────┘
```

### Startup

On boot, the daemon:

1. loads config
2. opens runtime state / recovery markers
3. ensures configured workspaces exist
4. constructs the runtime event bus and SQLite sidecar
5. starts Telegram (if configured)
6. attaches the Telegram status sink
7. sends startup / recovery notifications if configured
8. begins accepting updates

### Message Flow

Normal message path:

1. Telegram provider normalizes an inbound update into a Pion `Message`
2. Router selects the matching agent and context key
3. Commands (`/new`, `/compact`, `/stop`) are intercepted immediately
4. Non-command messages are buffered by the debouncer unless `debounceMs: 0`
5. Buffered messages for the same context are merged when the quiet window expires
6. If a run is already active, newer work supersedes the old generation
7. Attachments are materialized to temp files under `/tmp/pion-media/<context>/`
8. Runner resumes or creates the pi agent session
9. Session output streams back to Telegram
10. Runtime events are recorded and the SQLite sidecar is synced

### Commands

| Command | Behavior |
|--------|----------|
| `/new` | archive the current session and start fresh |
| `/compact [focus]` | summarize current conversation and prime a fresh session |
| `/stop` | supersede the active run |

Commands bypass the debounce buffer and cancel any buffered messages for that context.

### Native Tools at Runtime

Each run can include:

- Telegram tools: `send_sticker`, `send_file`
- Native recall tools: `session_search`, `session_query`

Recall uses the SQLite sidecar for lookup and JSONL sessions for final answers.

### Live Status on Telegram

While a run is active, Pion maintains an editable Telegram status message showing:

- `⚙️ working`
- the latest tool calls (for example `read`, `bash`, `session_search`, `session_query`)
- failure state if a run ends in error

By default the status message is cleared when the run completes. That behavior is controlled by:

```yaml
telegram:
  status:
    clearOnComplete: true
```

### Recovery Model

Pion keeps a lightweight runtime-state file so it can detect an interrupted previous run on startup and notify affected chats.

This is deliberately simple: recovery is about visibility, not replaying partial agent execution.

### Signal Handling

| Signal | Behavior |
|--------|----------|
| `SIGINT` | graceful shutdown |
| `SIGTERM` | graceful shutdown |
| `SIGHUP` | logged only; config reload is not implemented |

## Session + Event Artifacts

At runtime, Pion writes:

```text
~/.pion/
├── sessions/
│   ├── <context>.jsonl
│   └── archive/
├── runtime-events/
│   └── <context>.jsonl
└── index.sqlite
```

The split is intentional:

- **session JSONL** = conversation history and tool results
- **runtime-events JSONL** = operational telemetry
- **index.sqlite** = derived search/inspection index

## Monitor TUI

The monitor is still a **session viewer**, not a full runtime inspector.

```bash
bun run monitor
bun run monitor telegram-contact-123
```

It:

1. opens the target session JSONL file
2. renders user/assistant/tool output with pi TUI components
3. watches the file for append-only changes
4. recomputes footer stats from session usage metadata

### Keybindings

| Key | Action |
|-----|--------|
| `Ctrl+T` | toggle thinking visibility |
| `Ctrl+O` | toggle tool expansion |
| `q` / `Ctrl+C` | quit |

## Systemd Example

```ini
[Unit]
Description=Pion agent daemon
After=network.target

[Service]
Type=simple
ExecStart=%h/.bun/bin/bun run %h/Projects/pion/src/daemon.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Useful commands:

```bash
systemctl --user enable pion
systemctl --user start pion
systemctl --user status pion
journalctl --user -u pion -f
```

## Operational Trade-offs

### What stays simple

- one daemon process
- no separate queue/worker system
- JSONL sessions remain easy to inspect and back up
- no IPC layer between runtime and monitor
- recall/search is fast without changing the source-of-truth format

### What is intentionally limited

- Telegram is the only implemented provider
- a provider/runtime crash still restarts the whole daemon
- no hot config reload
- monitor only sees session files, not the full runtime-event stream
- no distributed/runtime-cluster story
