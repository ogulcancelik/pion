# Spec: pi-native resource discovery (skills + extensions) and default packages

Status: agreed, in build. Hobby project — no backwards-compat concern; favor the
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
     workspace prompt (SOUL/IDENTITY/AGENTS/USER/MEMORY/memory/*).
   - `noContextFiles: true` — pion builds its own prompt; don't double-load AGENTS.md.
   - `skillsOverride: (base) => filter by agentConfig.skills` — preserve pion's
     per-agent skill selection.
   - `eventBus` if available.
   Call `await reload()` before use if the SDK doesn't.

3. **Default packages auto-installed on first run if missing:**
   `@ogulcancelik/pi-session-recall` and `@ogulcancelik/pi-web-browse`. Best-effort,
   non-fatal on failure, only when absent. (Author maintains these upstream; their
   SKILL.md/debug docs live in the package, not in pion.)

4. **Delete native re-implementations:** `src/core/recall-tools.ts` and
   `src/core/web-tools.ts` plus their tests and runner wiring (`recallQueryModel`,
   `webBrowseBin`, `createRecallTools`, `createWebTools`). Also delete the
   hand-rolled `pion-resource-loader.ts` and the single-dir skill loader once
   `DefaultResourceLoader` replaces them.

5. **Memory: load ALL files**, not just recent days. `workspace.ts` loads every
   `memory/*.md` and `memory/daily/*.md` into the system prompt. (Reverts the
   3-day cap added earlier.)

## Resulting tool surface

- Native (pion-specific, no pi equivalent): `remember`, `subagent`,
  `save_subagent`/`list_subagents` (profiles), managed `bash`.
- Default skill (installed package): `web-browse`.
- Default extension (installed package): `session-recall` (`session_search` /
  `session_query` / `/session-recall`).
- User layer: `~/.pion/skills` and `~/.pion/extensions` (pi-native discovery).

## Out of scope / unchanged

- The `subagent`, `remember`, and agent-profile features stay as built. The
  subagent peer keeps `PI_CODING_AGENT_DIR` so it reads pion's auth (now also the
  process default).

## Risks to confirm during build

- Whether `createAgentSession` calls `resourceLoader.reload()` or pion must.
- Exact install target/command for the default packages (`pi install` vs a
  programmatic `PackageManager` API) and where installed packages land for
  discovery.
- Per-agent skill filtering via `skillsOverride` behaves as expected.
