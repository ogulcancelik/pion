# Recall tool design recommendation

## Decision

Pion's first agent-facing recall surface should be **native built-in tools inside Pion**, not extension support and not a direct port of `pi-session-recall`.

Use the **same two-step UX shape** as `pi-session-recall`:

1. `session_search(query)` — fast candidate retrieval
2. `session_query(sessionPath, question)` — deep dive on one session

But change the implementation:

- **SQLite sidecar** is the retrieval/index layer
- **JSONL session files remain source of truth**
- **SessionManager + mini-model Q&A** answer the final question

In other words: **borrow the flow, not the backend or extension packaging**.

## Why this is the right first step

### 1. It uses the infrastructure we already added

Phase 07 added `src/core/sqlite-index.ts` specifically so Pion would not need to grep session files for every recall request.

Using `rg`/`grep` again would ignore that work and duplicate scan cost.

### 2. It keeps source-of-truth simple

SQLite should stay a **derived index** for search, metadata, and runtime queries.

The final recall answer should still come from the canonical JSONL session file by loading the session with `SessionManager` and asking a small model targeted questions about it.

That avoids drift between:

- what the agent actually saw in-session
- what the index extracted
- what recall later reports

### 3. It avoids dragging extension support into a different problem

Pion currently has a deliberate stub resource loader in `src/core/pion-resource-loader.ts` that returns no extensions.

Adding explicit extension support is its own architectural track with real scope:

- config surface for extension paths/packages
- trust/security model
- dependency installation story
- lifecycle/reload behavior
- command/UI behavior in a chat-oriented runtime

That is broader than recall. Tying recall to extension support would slow down the feature and blur the separation between infrastructure work and agent UX work.

### 4. It matches Pion's current tool architecture

Pion already injects non-core tools natively through `customTools` (for example Telegram tools).

Recall can follow the same pattern:

- implement a `createRecallTools(...)` factory
- hand those tools to the runner like any other native tool set

That keeps the design small and makes a future extraction to an extension possible if Pion later grows explicit extension loading.

## Ranking of the options

### 1. Native SQLite-backed tools in Pion

**Recommended.**

Best fit for the codebase as it exists today.

### 2. Add explicit extension support and let recall live there

**Good long-term track, wrong first move.**

Worth doing later if Pion wants a general extension ecosystem, but recall should not depend on that work.

### 3. Adapt the current `pi-session-recall` extension implementation

**Not recommended.**

The useful part is the UX pattern, not the implementation details.

What does not transfer cleanly:

- it depends on pi's extension runtime
- it assumes TUI command/UI affordances
- its search backend is `rg`/`grep`/node scan instead of SQLite

## Recommended first tool surface

Ship two native tools first:

### `session_search`

Purpose:
- keyword/phrase search across past sessions
- return a small list of candidate sessions with snippets and metadata

Backend:
- `PionSqliteIndex.searchSessionMessages()` for message hits
- later optionally enrich with `tool_calls`, attachments, or runtime event matches

Return shape should include:
- `sessionPath`
- timestamp / recency
- role
- matching snippet
- maybe hit count per session

### `session_query`

Purpose:
- answer a concrete question about one specific session

Backend:
- open the JSONL session with `SessionManager`
- serialize relevant conversation context
- ask a smaller/cheaper model for a concise answer
- use windowing if the session is too large

This preserves the proven search → query workflow from `pi-session-recall` while swapping in Pion's faster index.

## Built-in vs extension-loaded responsibilities

### Built into Pion

For the first version, Pion itself should own:

- `session_search`
- `session_query`
- prompt guidance that teaches the agent:
  - stable fact → typed memory
  - past task/session detail → session recall
  - repeatable workflow → skill

### Leave for a later extension system

If Pion later supports explicit extensions, that system should be for:

- alternative recall UIs
- custom ranking backends
- domain-specific recall tools
- extra commands / interactive setup
- third-party integrations beyond Pion's core needs

## Source-of-truth model

Keep this boundary explicit:

- **JSONL** = authoritative conversation and tool history
- **SQLite** = fast index for search, filtering, analytics, and runtime queries

Recall should use SQLite to find candidates quickly, then read JSONL for authoritative answers.

That is the clean separation between phase 07 infrastructure and the agent/tool UX layered on top of it.

## Suggested implementation shape for the follow-up task

Keep the implementation narrow:

- new file: `src/core/recall-tools.ts`
- expose `createRecallTools(...)`
- inject from runner alongside provider-specific tools
- start with session recall only
- keep runtime-event recall separate unless a real use case pushes it in

A reasonable config shape later would be either:

- enabled by default for all agents, or
- opt-in per agent via something like `agents.<name>.recall`

But that policy choice is secondary. The important architectural choice is that the first recall surface should be **native**, **SQLite-assisted**, and **JSONL-authoritative**.
