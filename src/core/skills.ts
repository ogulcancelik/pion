/**
 * Skill name listing for cron tooling. Agent sessions discover skills via pi's
 * DefaultResourceLoader; this single-dir helper only backs the cron
 * available-skills list.
 */

import {
	type LoadSkillsResult,
	type Skill,
	loadSkillsFromDir,
} from "@earendil-works/pi-coding-agent";

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
