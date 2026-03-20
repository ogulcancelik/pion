import { join } from "node:path";
import type { Config } from "../config/schema.js";
import { expandTilde, homeDir } from "./paths.js";

/**
 * Default auth path for pion.
 * Kept separate from pi, but uses the same auth.json schema for compatibility.
 */
export function getDefaultAuthPath(): string {
	return join(homeDir(), ".pion", "auth.json");
}

/**
 * Resolve the auth path from config or fall back to pion's default.
 */
export function getAuthPath(config?: Pick<Config, "authPath">): string {
	return expandTilde(config?.authPath ?? getDefaultAuthPath());
}
