# Recall Tools

This document reflects Pion's current recall design.

## Current shape

Pion gets recall from the default pi package `npm:@ogulcancelik/pi-session-recall`, installed best-effort on daemon startup when missing.

That package exposes the agent-facing recall flow:

1. `session_search(query)`
2. `session_query(sessionPath, question)`

Pion no longer implements these tools natively. They are discovered through pi's `DefaultResourceLoader` from the Pion data directory.

## Source-of-truth split

Pion keeps a deliberate boundary:

- **session JSONL** = authoritative conversation history
- **runtime-event JSONL** = authoritative runtime telemetry
- **recall package state** = derived package-owned lookup data

Recall package internals are package-owned. Pion's boundary is that JSONL session files remain the durable conversation source of truth.

## Tool behavior

### `session_search(query)`

Purpose:
- find relevant past sessions by simple words or a short phrase
- return matching session files with snippets/hit counts

Backend:
- supplied by the `pi-session-recall` package
- discovered as a pi extension/package resource

This is the cheap first step when the agent thinks prior work may matter.

### `session_query(sessionPath, question)`

Purpose:
- answer a concrete question about one specific past session

Backend:
- supplied by the `pi-session-recall` package
- answers from the relevant session transcript rather than Pion runtime events

## Why package-backed recall

Pion is a pi-based runtime, so maintained pi packages are the right home for reusable capabilities. Keeping recall as a package avoids a second implementation inside Pion and keeps the daemon focused on routing, session lifecycle, provider tools, and chat control flow.

## Why not answer from runtime events?

Runtime events are operational telemetry, not the conversation source of truth.

Answering final questions from runtime events alone would risk drift and loss of detail around:

- tool sequences
- exact wording and decisions
- adjacent context needed to answer accurately

Using session JSONL for final answers keeps recall faithful to what the session actually contained.

## Current scope limits

Pion recall intentionally stops short of becoming a bigger memory system.

Not part of this feature:

- package-specific storage/index internals
- agent-facing runtime-event recall tools
- background extraction pipelines
- embeddings/vector recall

Current Pion stance is narrower:

- **session recall** for episodic past work
- **workspace files** for durable prompt context
- **remember** for explicit durable notes
- **skills/extensions/packages** for reusable procedures
