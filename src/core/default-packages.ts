/**
 * Default pi packages pion installs on first run.
 *
 * Pion is a pi fork, so capabilities that pi already ships as installable
 * packages are installed rather than vendored or re-implemented:
 *   - session recall (the `session_search`/`session_query` extension), and
 *   - web-browse (the search/fetch skill).
 *
 * Small deployment-local skills that are not published as packages live in
 * `resources/default-skills` and are installed by `default-skills.ts`.
 *
 * With PI_CODING_AGENT_DIR pointed at pion's data dir, these install under
 * `<dataDir>` and are discovered by the pi resource loader on session start.
 * The author maintains both packages; their SKILL.md/docs live upstream.
 */

import {
	DefaultPackageManager,
	type PackageManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

// `npm:` prefix is required — pi's package manager treats a bare scoped name as
// a local filesystem path, not an npm package.
export const DEFAULT_PACKAGES = [
	"npm:@ogulcancelik/pi-session-recall",
	"npm:@ogulcancelik/pi-web-browse",
];

export interface EnsureDefaultPackagesOptions {
	/** Injected for tests; defaults to a real DefaultPackageManager for the dir. */
	packageManager?: PackageManager;
	/** Override the package list (tests). */
	packages?: string[];
	log?: (message: string) => void;
}

/** Standard pi package manager wiring for pion's data dir. */
export function createPionPackageManager(cwd: string, agentDir: string): PackageManager {
	return new DefaultPackageManager({
		cwd,
		agentDir,
		settingsManager: SettingsManager.create(cwd, agentDir),
	});
}

/**
 * Install any missing default packages and persist them to settings so the
 * resource loader discovers them. Best-effort: a failure (e.g. offline) for one
 * package is logged and skipped, never thrown.
 */
export async function ensureDefaultPackages(
	cwd: string,
	agentDir: string,
	options: EnsureDefaultPackagesOptions = {},
): Promise<void> {
	const packages = options.packages ?? DEFAULT_PACKAGES;
	const packageManager = options.packageManager ?? createPionPackageManager(cwd, agentDir);

	for (const source of packages) {
		if (packageManager.getInstalledPath(source, "user")) {
			continue;
		}
		try {
			await packageManager.installAndPersist(source);
			options.log?.(`[packages] installed ${source}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options.log?.(`[packages] could not install ${source}: ${message}`);
		}
	}
}
