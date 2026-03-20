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
export function openUrlInBrowser(url: string): boolean {
	const { command, args } = getBrowserOpenCommand(process.platform, url);

	try {
		const child = spawn(command, args, {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
		return true;
	} catch {
		return false;
	}
}
