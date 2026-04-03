# Recall tools

This document reflects Pion's current recall design.

## Current shape

Pion exposes two native agent-facing recall tools:

1. `session_search(query)`
2. `session_query(sessionPath, question)`

This is implemented natively inside Pion. It is **not** an extension port and does **not** depend on general extension loading.

## Source-of-truth split

Pion keeps a deliberate boundary:

- **session JSONL** = authoritative conversation history
- **runtime-event JSONL** = authoritative runtime telemetry
- **SQLite sidecar** = derived index for fast lookup/search

Recall follows that boundary:

- `session_search` uses the SQLite sidecar to find candidates quickly
- `session_query` opens the actual JSONL session file and answers from that transcript

So SQLite accelerates discovery, but JSONL remains the final authority.

## Tool behavior

### `session_search(query)`

Purpose:
- find relevant past sessions by simple words or a short phrase
- return matching session files with snippets/hit counts

Backend:
- `RuntimeEventBus.searchSessionMessages()`
- backed by `src/core/sqlite-index.ts`

This is the cheap first step when the agent thinks prior work may matter.

### `session_query(sessionPath, question)`

Purpose:
- answer a concrete question about one specific past session

Backend:
- load the session file with pi's `SessionManager`
- serialize the relevant conversation
- ask a model a direct question about that session

If `recallQueryModel` is set in config, Pion uses that model for recall Q&A. Otherwise it falls back to the active session model.

## Why native tools were the right fit

This matched Pion's architecture better than extension-first recall:

- Pion already had a native custom-tool injection path
- the SQLite sidecar already existed for search/inspection
- keeping recall native avoided bundling a larger extension-loading project into a focused runtime feature
- the search → query flow was useful even without copying another implementation's backend

## Why not answer directly from SQLite?

Because SQLite is a derived index, not the conversation source of truth.

Answering final questions from the indexed rows alone would risk drift and loss of detail around:

- tool sequences
- exact wording and decisions
- adjacent context needed to answer accurately

Using JSONL for the final answer keeps recall faithful to what the session actually contained.

## Current scope limits

Pion recall intentionally stops short of becoming a bigger memory system.

Not part of this feature:

- typed durable memory / fact storage
- generic extension packaging/loading
- agent-facing runtime-event recall tools
- background extraction pipelines
- embeddings/vector recall

Current Pion stance is narrower:

- **session recall** for episodic past work
- **workspace files** for durable prompt context
- **skills** for reusable procedures
