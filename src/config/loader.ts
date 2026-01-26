import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { homeDir } from "../core/paths.js";
import { type Config, validateConfig } from "./schema.js";

const home = homeDir();
const DEFAULT_CONFIG_PATHS = [
	join(home, ".pion/config.yaml"), // ~/.pion/config.yaml (preferred)
	join(home, ".pion/config.yml"),
	"./pion.yaml", // local overrides for dev
	"./pion.yml",
	"./config.yaml",
	"./config.yml",
];

/**
 * Load config from a YAML file.
 */
export function loadConfig(path?: string): Config {
	const configPath = path ?? findConfigFile();

	if (!configPath) {
		throw new Error(`No config file found. Looked for: ${DEFAULT_CONFIG_PATHS.join(", ")}`);
	}

	const content = readFileSync(configPath, "utf-8");
	const parsed = parseYaml(content);

	const errors = validateConfig(parsed);
	if (errors.length > 0) {
		throw new Error(`Invalid config:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
	}

	return parsed as Config;
}

function findConfigFile(): string | undefined {
	for (const p of DEFAULT_CONFIG_PATHS) {
		if (existsSync(p)) {
			return p;
		}
	}
	return undefined;
}
