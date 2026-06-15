import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SKILLS = ["pi-speech-to-text"];

export interface EnsureDefaultSkillsOptions {
	/** Base Pion data directory. Defaults to ~/.pion upstream of caller config. */
	dataDir: string;
	/** Optional skills directory override from config. Defaults to <dataDir>/skills. */
	skillsDir?: string;
	/** Override source root for tests. Defaults to bundled resources/default-skills. */
	sourceRoot?: string;
	/** Override skill list for tests. */
	skills?: string[];
	log?: (message: string) => void;
}

function defaultSourceRoot(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "resources", "default-skills");
}

/**
 * Copy bundled default skills into the configured Pion skills directory.
 *
 * Existing skill directories are left untouched so users can customize or pin a
 * local variant. Missing bundled sources are logged and skipped rather than
 * making daemon startup fail.
 */
export function ensureDefaultSkills(options: EnsureDefaultSkillsOptions): void {
	const skills = options.skills ?? DEFAULT_SKILLS;
	const sourceRoot = options.sourceRoot ?? defaultSourceRoot();
	const targetRoot = options.skillsDir ?? join(options.dataDir, "skills");

	mkdirSync(targetRoot, { recursive: true });

	for (const skill of skills) {
		const source = join(sourceRoot, skill);
		const target = join(targetRoot, skill);

		if (existsSync(target)) {
			continue;
		}
		if (!existsSync(source)) {
			options.log?.(`[skills] bundled default skill missing: ${skill}`);
			continue;
		}

		try {
			cpSync(source, target, { recursive: true, errorOnExist: false });
			options.log?.(`[skills] installed bundled default skill ${skill}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options.log?.(`[skills] could not install bundled default skill ${skill}: ${message}`);
		}
	}
}
