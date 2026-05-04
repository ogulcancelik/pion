import { spawn } from "node:child_process";

export function getBrowserOpenCommand(platform: NodeJS.Platform, url = "https://example.com") {
	if (platform === "darwin") {
		return { command: "open", args: [url] };
	}

	if (platform === "win32") {
		return { command: "cmd", args: ["/c", "start", "", url] };
	}

	return { command: "xdg-open", args: [url] };
}

/**
 * Best-effort desktop browser open.
 * Returns false if we couldn't even launch the opener process.
 */
interface BrowserChild {
	on(event: "error", listener: (error: Error) => void): unknown;
	unref(): void;
}

type BrowserSpawn = (
	command: string,
	args: string[],
	options: { detached: true; stdio: "ignore" },
) => BrowserChild;

export function openUrlInBrowserWithSpawn(
	url: string,
	platform: NodeJS.Platform,
	spawnBrowser: BrowserSpawn,
): boolean {
	const { command, args } = getBrowserOpenCommand(platform, url);

	try {
		const child = spawnBrowser(command, args, {
			detached: true,
			stdio: "ignore",
		});
		child.on("error", () => {
			// Headless hosts often lack xdg-open/open/cmd. Browser opening is best-effort.
		});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

export function openUrlInBrowser(url: string): boolean {
	return openUrlInBrowserWithSpawn(url, process.platform, spawn as BrowserSpawn);
}
