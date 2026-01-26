import { homedir } from "node:os";

/**
 * Get the user's home directory, cross-platform.
 * Works on Linux, macOS, and Windows.
 */
export function homeDir(): string {
	return process.env.HOME || process.env.USERPROFILE || homedir();
}

/**
 * Expand leading ~ to the user's home directory.
 */
export function expandTilde(path: string): string {
	if (path.startsWith("~/") || path === "~") {
		return homeDir() + path.slice(1);
	}
	return path;
}
