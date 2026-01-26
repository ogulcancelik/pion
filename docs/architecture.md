# Pion Architecture

## Overview

```
┌─────────────┐     ┌──────────┐     ┌─────────────┐
│  Providers  │────▶│  Router  │────▶│   Runner    │
│  (TG / WA)  │     │          │     │  (pi-agent) │
└─────────────┘     └──────────┘     └─────────────┘
       │                 │                  │
       ▼                 ▼                  ▼
┌─────────────┐    ┌──────────┐     ┌─────────────┐
│  Commands   │    │  Config  │     │  Workspace  │
│  (/new etc) │    │  (yaml)  │     │  + Skills   │
└─────────────┘    └──────────┘     └─────────────┘
```

- **Providers** receive messages from Telegram/WhatsApp and send responses back
- **Router** matches messages to agents using config rules
- **Runner** manages pi-agent sessions per conversation context
- **Commands** handle `/new`, `/compact`, `/stop` before they reach the agent
- **Workspace** loads SOUL.md, IDENTITY.md, etc. for the system prompt
- **Skills** are loaded from `~/.pion/skills/` and appended to the system prompt

## Directory Structure

```
~/.pion/
├── config.yaml              # Main config
├── auth.json                # Anthropic OAuth (shared with pi)
├── sessions/                # Conversation history (JSONL)
│   ├── telegram-contact-123.jsonl
│   ├── whatsapp-chat-group-xyz.jsonl
│   └── archive/             # Archived sessions (from /new, /compact)
├── skills/                  # Skill directories (SKILL.md each)
│   ├── web-browse/
│   └── supervise/
├── whatsapp-auth/           # WhatsApp session credentials
│   └── creds.json
└── agents/                  # Agent workspaces
    └── main/
        ├── SOUL.md          # Core personality (cached)
        ├── IDENTITY.md      # Agent identity (cached)
        ├── AGENTS.md        # Workspace rules (cached)
        ├── USER.md          # User profile (cached)
        ├── MEMORY.md        # Persistent notes (agent-writable)
        ├── memory/          # Additional memory files (*.md, sorted by name)
        └── stickers.yaml    # Telegram sticker mappings (name → file_id)
```

## Session Files

Each context key maps to a JSONL file:

- `telegram:contact:123` → `sessions/telegram-contact-123.jsonl`
- `whatsapp:chat:Friends` → `sessions/whatsapp-chat-Friends.jsonl`

The JSONL format follows pi-agent's session format:

```jsonl
{"type":"session","version":3,"id":"compacted-abc123","timestamp":"2026-03-14T10:00:00.000Z","cwd":"/home/user"}
{"type":"message","id":"msg-1","parentId":null,"timestamp":"2026-03-14T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Hello!"}],"timestamp":1710410401000}}
{"type":"message","id":"msg-2","parentId":"msg-1","timestamp":"2026-03-14T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi there!"}],"api":"anthropic-messages","provider":"anthropic","model":"claude-sonnet-4-20250514","usage":{"input":500,"output":20,"cacheRead":450,"cacheWrite":0,"cost":{"total":0.001}},"stopReason":"stop","timestamp":1710410402000}}
```

Key points:
- Each line is a JSON object with a `type` field (`session`, `message`, `thinking_level_change`, etc.)
- Messages have `message.role` (`user`, `assistant`, `toolResult`) and `message.content` (array of parts)
- Content parts can be `text`, `thinking`, `toolCall`, `image`, etc.
- Assistant messages include `usage` with token counts and cost
- This format is identical to pi's session format — the monitor TUI reads it directly

## Prompt Caching Strategy

Anthropic charges less for cached prompt tokens. The system prompt is built in a stable order to maximize cache hits:

1. **SOUL.md** — most stable, core personality
2. **IDENTITY.md** — agent persona, rarely changes
3. **AGENTS.md** — workspace rules
4. **USER.md** — user context
5. **MEMORY.md** — persistent notes
6. **memory/*.md** — memory directory files (sorted by name)
7. **Skills** — loaded from skills directory, appended by `formatSkillsForPrompt()`
8. **Inline systemPrompt** — from config (if set)

```
┌─────────────────────────────────────────────────────────┐
│ System Prompt (stable — cached)                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ SOUL.md + IDENTITY.md + AGENTS.md + USER.md         │ │ ← Cached
│ └─────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ MEMORY.md + memory/*.md + Skills + systemPrompt     │ │ ← May vary
│ └─────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────┤
│ Conversation History                                    │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Previous messages...                                │ │ ← Cached
│ └─────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ [timestamp | Context: N%] + user message            │ │ ← New
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

Dynamic context (timestamp, context usage %) is prepended to each user message — not the system prompt — so the system prompt stays cache-friendly.

## Skills System

Skills are loaded from `~/.pion/skills/` using pi's `loadSkillsFromDir()`. Each skill is a directory with a `SKILL.md` file. The agent config specifies which skills to include:

```yaml
agents:
  main:
    skills:
      - web-browse
      - supervise
```

Skills are appended to the system prompt after workspace files.

## Custom Tools

Providers can register custom tools that the agent can invoke:

- **Telegram**: `send_sticker` (sends a named sticker from `stickers.yaml`) and `send_file` (sends a file from the filesystem)
- Tools are created per-message with the provider and chat ID bound in

## Commands

Messages starting with `/` are intercepted before reaching the agent:

| Command | Description |
|---------|-------------|
| `/new` | Clear session history, start fresh (archives old session) |
| `/compact [focus]` | Summarize history with Haiku, start new session with summary |
| `/stop` | Abort current agent processing |

## Compaction

`/compact` uses Claude Haiku to summarize the conversation, then starts a fresh session primed with the summary. The original session is archived to `sessions/archive/`.

## Context Warnings

The runner tracks context window usage and sends warnings:
- **85%** — first warning with `/new` and `/compact` hints
- **95%** — urgent warning

## Steering

If a user sends a message while the agent is already processing, pion uses pi-agent's steering to inject the new message mid-response (after the current tool call completes). No separate response is sent — the steering gets woven into the ongoing response.

## Config Schema

```yaml
# ~/.pion/config.yaml

dataDir: ~/.pion             # Where sessions and agents live (default)
skillsDir: ~/.pion/skills    # Where skills are loaded from (default)

telegram:
  botToken: "..."
  startupNotify: "123456"   # Chat ID to notify on startup (optional)

whatsapp:
  sessionDir: ~/.pion/whatsapp-auth
  allowDMs:                  # Phone numbers allowed to DM
    - "+1234567890"
  allowGroups:               # Group JIDs allowed
    - "120363403098358590@g.us"

agents:
  main:
    model: anthropic/claude-sonnet-4-20250514
    workspace: ~/.pion/agents/main  # Contains SOUL.md, etc.
    skills:
      - web-browse
      - supervise

  casual:
    model: anthropic/claude-sonnet-4-20250514
    systemPrompt: |
      You're chatting in a friend group. Be casual and fun.
    skills: []

routes:
  - match: { type: dm }
    agent: main
    isolation: per-contact

  - match: { group: "Friends" }
    agent: casual
    isolation: per-chat

  - match: { type: group }
    agent: null              # Ignore unmatched groups
    isolation: per-chat
```

Routes are evaluated top-to-bottom (first match wins). Setting `agent: null` ignores the message.

### Isolation modes

- **per-contact** — each sender gets their own session (DMs)
- **per-chat** — all participants share one session (groups)

## Image Support

Providers can attach images to messages. The runner fetches images (from URL or buffer), converts to base64, and passes them to pi-agent as image content parts.
