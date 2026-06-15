# Spec: pi-native resource discovery (skills + extensions), default packages, and bundled skills

Status: implemented. Hobby project — no backwards-compat concern; favor the
simplest design.

## Why

Pion is a fork that embeds pi's agent SDK. It had been hand-rolling its own
resource loading (a single-dir skill loader, `getExtensions()` returning empty)
and re-implementing capabilities that pi already ships as installable packages.
Two of pion's native tools were the wrong shape:

- **web search/fetch** was wrapped as native tools, which lost the `web-browse`
  CLI's search→fetch-by-index cache flow and its self-debugging SKILL.md.
- **session recall** was a native re-implementation of the maintained
  `pi-session-recall` extension.

Pi already supports installing and auto-discovering extensions/skills. Pion
should use that instead of vendoring or re-implementing.

## Decisions (locked)

1. **`PI_CODING_AGENT_DIR = <dataDir>` (default `~/.pion`).** pi's `getAgentDir()`
   returns this env directly and `getAuthPath()` = `<agentDir>/auth.json`. Pion
   already stores auth at `~/.pion/auth.json`, so this aligns pi's auth, skill,
   extension, and package-install roots onto pion's own dir. Set in the daemon
   (production entry). Do NOT point it at `~/.pion/agent` — that would break auth
   alignment.

2. **Use pi's `DefaultResourceLoader` instead of pion's hand-rolled loader.** It
   implements the same `ResourceLoader` interface pion already passes to
   `createAgentSession`, and discovers `<agentDir>/skills`, `<agentDir>/extensions`,
   and installed packages via its built-in package manager. Configure it with:
   - `cwd`, `agentDir: <dataDir>`
   - `systemPromptOverride: () => buildSystemPrompt(agentConfig)` — inject pion's
     workspace prompt (SOUL/IDENTITY/AGENTS/USER/MEMORY/memory/*/memory/daily/*).
   - `noContextFiles: true` — pion builds its own prompt; don't double-load AGENTS.md.
   - `skillsOverride: (base) => filter by agentConfig.skills` — preserve pion's
     per-agent skill selection.
   Call `await reload()` before use.

3. **Default packages auto-installed on first run if missing:**
   `@ogulcancelik/pi-session-recall` and `@ogulcancelik/pi-web-browse`. Best-effort,
   non-fatal on failure, only when absent. (Author maintains these upstream; their
   SKILL.md/debug docs live in the package, not in pion.)

4. **Bundled default local skills copied on first run if missing:**
   `pi-speech-to-text` lives in `resources/default-skills` because it is a small
   deployment helper around local `ffmpeg` + `whisper-cli`, not a published pi
   package. Existing user skill directories are never overwritten.

5. **Delete native re-implementations:** `src/core/recall-tools.ts` and
   old web/recall runner wiring. Also delete the hand-rolled
   `pion-resource-loader.ts` once `DefaultResourceLoader` replaces it.

6. **Memory: load ALL files**, not just recent days. `workspace.ts` loads every
   `memory/*.md` and `memory/daily/*.md` into the system prompt. (Reverts the
   3-day cap added earlier.)

## Resulting tool surface

- Native (pion-specific, no pi equivalent): `remember`, `subagent`,
  `save_subagent`/`list_subagents` (profiles), managed `bash`.
- Default skill (installed package): `web-browse`.
- Default extension (installed package): `session-recall` (`session_search` /
  `session_query` / `/session-recall`).
- Bundled local skill: `pi-speech-to-text` copied to `~/.pion/skills` if absent.
- User layer: `~/.pion/skills` and `~/.pion/extensions` (pi-native discovery).

## Out of scope / unchanged

- The `subagent`, `remember`, and agent-profile features stay as built. The
  subagent tool passes Pion's data dir as `PI_CODING_AGENT_DIR` to the peer so
  it reads the same auth and package root as foreground sessions.

## Build confirmations

- Pion calls `resourceLoader.reload()` before session creation.
- Default packages install through pi's programmatic package manager with `npm:`
  sources and are persisted for discovery under the Pion data directory.
- Per-agent `skills` filters additional local skills; default packages and bundled default local skills stay available.
