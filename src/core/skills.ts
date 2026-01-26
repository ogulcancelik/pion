/**
 * Skills loading and system prompt integration.
 *
 * Uses pi's skill loading utilities but integrates with pion's
 * workspace-based system prompt building.
 */

import {
	type LoadSkillsResult,
	type Skill,
	formatSkillsForPrompt,
	loadSkillsFromDir,
} from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "../config/schema.js";
import { buildSystemPrompt } from "./workspace.js";

export type { Skill, LoadSkillsResult };

/**
 * Load skills from a directory, optionally filtering by name.
 *
 * @param skillsDir - Directory containing skill subdirectories
 * @param filterNames - Optional list of skill names to include (all if not provided)
 */
export function loadSkills(skillsDir: string, filterNames?: string[]): LoadSkillsResult {
	const result = loadSkillsFromDir({
		dir: skillsDir,
		source: "pion",
	});

	// Filter by name if provided
	if (filterNames && filterNames.length > 0) {
		const nameSet = new Set(filterNames);
		return {
			skills: result.skills.filter((s) => nameSet.has(s.name)),
			diagnostics: result.diagnostics,
		};
	}

	return result;
}

/**
 * Build system prompt with skills included.
 *
 * Order (cache-friendly):
 * 1. SOUL.md - most stable
 * 2. IDENTITY.md - agent persona
 * 3. AGENTS.md - workspace rules
 * 4. USER.md - user context
 * 5. MEMORY.md - persistent notes
 * 6. memory/*.md - memory directory files
 * 7. Skills section - from config
 * 8. Inline systemPrompt
 *
 * @param agentConfig - Agent configuration
 * @param skillsDir - Directory containing skills
 */
export function buildSystemPromptWithSkills(agentConfig: AgentConfig, skillsDir: string): string {
	// Get base prompt from workspace
	const basePrompt = buildSystemPrompt(agentConfig);

	// Load and filter skills
	const skillNames = agentConfig.skills ?? [];
	if (skillNames.length === 0) {
		return basePrompt;
	}

	const { skills } = loadSkills(skillsDir, skillNames);
	if (skills.length === 0) {
		return basePrompt;
	}

	// Format skills section
	const skillsSection = formatSkillsForPrompt(skills);

	// Append skills section to prompt
	return basePrompt + skillsSection;
}
