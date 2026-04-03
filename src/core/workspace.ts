import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../config/schema.js";
import { expandTilde } from "./paths.js";

export interface WorkspaceContent {
	soul?: string;
	identity?: string;
	agents?: string;
	user?: string;
	memory?: string;
}

export interface MemoryFile {
	name: string;
	path: string;
	content: string;
}

export function resolveAgentCwd(agentConfig: AgentConfig): string {
	return expandTilde(agentConfig.cwd ?? agentConfig.workspace ?? process.cwd());
}

/**
 * Load workspace files from an agent's workspace directory.
 */
export function loadWorkspace(workspacePath: string): WorkspaceContent {
	const content: WorkspaceContent = {};

	const soulPath = join(workspacePath, "SOUL.md");
	if (existsSync(soulPath)) {
		content.soul = readFileSync(soulPath, "utf-8");
	}

	const identityPath = join(workspacePath, "IDENTITY.md");
	if (existsSync(identityPath)) {
		content.identity = readFileSync(identityPath, "utf-8");
	}

	const agentsPath = join(workspacePath, "AGENTS.md");
	if (existsSync(agentsPath)) {
		content.agents = readFileSync(agentsPath, "utf-8");
	}

	const userPath = join(workspacePath, "USER.md");
	if (existsSync(userPath)) {
		content.user = readFileSync(userPath, "utf-8");
	}

	const memoryPath = join(workspacePath, "MEMORY.md");
	if (existsSync(memoryPath)) {
		content.memory = readFileSync(memoryPath, "utf-8");
	}

	return content;
}

/**
 * Load all .md files from the memory/ subdirectory.
 * Returns files sorted by name (so date-named files come in order).
 */
export function loadMemoryDir(workspacePath: string): MemoryFile[] {
	const memoryDir = join(workspacePath, "memory");

	if (!existsSync(memoryDir)) {
		return [];
	}

	const entries = readdirSync(memoryDir, { withFileTypes: true });
	const mdFiles: MemoryFile[] = [];

	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(".md")) continue;

		const filePath = join(memoryDir, entry.name);
		mdFiles.push({
			name: entry.name,
			path: filePath,
			content: readFileSync(filePath, "utf-8"),
		});
	}

	// Sort by name (so 2026-01-25.md comes before 2026-01-26.md)
	mdFiles.sort((a, b) => a.name.localeCompare(b.name));

	return mdFiles;
}

/**
 * Build system prompt from agent config.
 *
 * Order is important for prompt caching:
 * 1. SOUL.md - most stable, core identity
 * 2. IDENTITY.md - agent persona
 * 3. AGENTS.md - workspace rules
 * 4. USER.md - user context
 * 5. MEMORY.md - persistent notes
 * 6. memory/*.md - memory directory files
 * 7. Inline systemPrompt - additional context
 * 8. Runtime context - time, etc.
 */
export function buildSystemPrompt(agentConfig: AgentConfig): string {
	const parts: string[] = [];

	// Load workspace files if workspace is specified
	if (agentConfig.workspace) {
		const expandedPath = expandTilde(agentConfig.workspace);
		const workspace = loadWorkspace(expandedPath);
		const memoryFiles = loadMemoryDir(expandedPath);

		// Core files in cache-friendly order (most stable first)
		if (workspace.soul) {
			parts.push(workspace.soul);
		}
		if (workspace.identity) {
			parts.push(workspace.identity);
		}
		if (workspace.agents) {
			parts.push(workspace.agents);
		}
		if (workspace.user) {
			parts.push(workspace.user);
		}
		if (workspace.memory) {
			parts.push(workspace.memory);
		}

		// Memory directory files (sorted by name)
		for (const memFile of memoryFiles) {
			parts.push(`## ${memFile.name}\n\n${memFile.content}`);
		}
	}

	// Add inline system prompt if provided
	if (agentConfig.systemPrompt) {
		parts.push(agentConfig.systemPrompt);
	}

	// NOTE: Time and context usage are prepended to user messages (not here)
	// This keeps the system prompt stable for Anthropic cache efficiency

	// Join with separators
	return parts.join("\n\n---\n\n");
}

/**
 * Ensure workspace directory exists with default files.
 */
export function ensureWorkspace(workspacePath: string): void {
	const expandedPath = expandTilde(workspacePath);

	// Create directory if it doesn't exist
	const { mkdirSync, writeFileSync } = require("node:fs");
	mkdirSync(expandedPath, { recursive: true });

	// Create default SOUL.md if missing
	const soulPath = join(expandedPath, "SOUL.md");
	if (!existsSync(soulPath)) {
		writeFileSync(
			soulPath,
			`# Soul

You are a helpful assistant communicating via messaging apps.

## Values
- Be concise - this is chat, not email
- Be helpful but not servile
- Be honest about limitations
- Respect the user's time

## Communication style
- Keep responses short unless asked for detail
- Use natural conversational tone
- Match the user's language and formality level
`,
			"utf-8",
		);
	}
}
