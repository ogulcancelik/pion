/**
 * Shared-skills plugin for the claude engine.
 *
 * Claude Code discovers skills from plugins, so pion assembles a derived
 * plugin directory under <dataDir>/claude-plugin whose skills/ folder is a set
 * of symlinks into pion's existing skill sources:
 *   - every skill in the pion skills dir (<dataDir>/skills by default), and
 *   - the pi-web-browse package skill (replaces Claude Code's built-in
 *     WebSearch, which pion disables).
 *
 * The directory is rebuilt on every call — it is derived state, never edited
 * by hand — so renames and removals in the sources propagate on daemon start.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PackageManager } from "@earendil-works/pi-coding-agent";
import { createPionPackageManager } from "./default-packages.js";

export const WEB_BROWSE_PACKAGE = "npm:@ogulcancelik/pi-web-browse";
export const WEB_BROWSE_SKILL_NAME = "pi-web-browse";

export interface EnsureClaudePluginOptions {
	/** Base pion data directory. */
	dataDir: string;
	/** Skills directory override from config. Defaults to <dataDir>/skills. */
	skillsDir?: string;
	/** Injected for tests; defaults to a real DefaultPackageManager. */
	packageManager?: PackageManager;
	log?: (message: string) => void;
}

export function claudePluginRoot(dataDir: string): string {
	return join(dataDir, "claude-plugin");
}

/**
 * Build the plugin directory and return its path, or undefined when there are
 * no skills to expose (an empty plugin would be pointless noise).
 */
export function ensureClaudePlugin(options: EnsureClaudePluginOptions): string | undefined {
	const pluginRoot = claudePluginRoot(options.dataDir);
	const skillsRoot = join(pluginRoot, "skills");
	const manifestDir = join(pluginRoot, ".claude-plugin");

	rmSync(skillsRoot, { recursive: true, force: true });
	mkdirSync(skillsRoot, { recursive: true });
	mkdirSync(manifestDir, { recursive: true });
	writeFileSync(
		join(manifestDir, "plugin.json"),
		`${JSON.stringify({ name: "pion", description: "Pion shared skills" }, null, "\t")}\n`,
	);

	let linked = 0;

	const skillsDir = options.skillsDir ?? join(options.dataDir, "skills");
	if (existsSync(skillsDir)) {
		for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			const source = join(skillsDir, entry.name);
			if (!existsSync(join(source, "SKILL.md"))) continue;
			symlinkSync(source, join(skillsRoot, entry.name));
			linked++;
		}
	}

	const webBrowsePath = resolveWebBrowsePath(options);
	if (webBrowsePath && !existsSync(join(skillsRoot, WEB_BROWSE_SKILL_NAME))) {
		symlinkSync(webBrowsePath, join(skillsRoot, WEB_BROWSE_SKILL_NAME));
		linked++;
	} else if (!webBrowsePath) {
		options.log?.("[claude-plugin] pi-web-browse package not installed; skill not shared");
	}

	return linked > 0 ? pluginRoot : undefined;
}

function resolveWebBrowsePath(options: EnsureClaudePluginOptions): string | undefined {
	try {
		const packageManager =
			options.packageManager ?? createPionPackageManager(options.dataDir, options.dataDir);
		const installed = packageManager.getInstalledPath(WEB_BROWSE_PACKAGE, "user");
		return installed && existsSync(join(installed, "SKILL.md")) ? installed : undefined;
	} catch (error) {
		options.log?.(
			`[claude-plugin] could not resolve pi-web-browse install: ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}
