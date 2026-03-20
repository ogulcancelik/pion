#!/usr/bin/env bun

import { createInterface } from "node:readline";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../src/config/loader.js";
import { getAuthPath, getDefaultAuthPath } from "../src/core/auth.js";
import { openUrlInBrowser } from "../src/core/browser.js";
import { expandTilde } from "../src/core/paths.js";

const ANTHROPIC_PROVIDER = "anthropic";

type CliOptions = {
	authPath?: string;
	command: "login" | "list";
	provider?: string;
};

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
	return new Promise((resolve) => rl.question(question, resolve));
}

function parseArgs(argv: string[]): CliOptions {
	let authPath: string | undefined;
	let command: "login" | "list" = "login";
	let provider: string | undefined;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg) continue;

		if (arg === "list") {
			command = "list";
			continue;
		}

		if (arg === "--auth") {
			authPath = argv[i + 1];
			i++;
			continue;
		}

		if (arg === "-h" || arg === "--help" || arg === "help") {
			printHelp();
			process.exit(0);
		}

		if (!provider) {
			provider = arg;
		}
	}

	return { authPath, command, provider };
}

function printHelp(): void {
	console.log(`Usage: bun run login [anthropic] [--auth /path/to/auth.json]\n
Commands:
  login [anthropic]  Login to Anthropic OAuth and save pion credentials
  list               Show supported login providers

Notes:
  - pion defaults to ~/.pion/auth.json
  - pion auth.json is schema-compatible with pi auth.json
  - for now, pion login only supports Anthropic

Examples:
  bun run login
  bun run login anthropic
  bun run login list
  bun run login --auth ~/.pion/auth.json
`);
}

function resolveAuthPath(cliAuthPath?: string): string {
	if (cliAuthPath) {
		return expandTilde(cliAuthPath);
	}

	try {
		const config = loadConfig();
		return getAuthPath(config);
	} catch {
		return getDefaultAuthPath();
	}
}

async function loginAnthropic(authPath: string): Promise<void> {
	const authStorage = AuthStorage.create(authPath);
	const rl = createInterface({ input: process.stdin, output: process.stdout });

	try {
		await authStorage.login(ANTHROPIC_PROVIDER, {
			onAuth: (info) => {
				console.log(`\nOpen this URL in your browser:\n${info.url}`);
				const opened = openUrlInBrowser(info.url);
				console.log(opened ? "Attempted to open browser automatically." : "Could not auto-open browser; open the URL manually.");
				if (info.instructions) console.log(info.instructions);
				console.log();
			},
			onPrompt: async (p) => {
				const suffix = p.placeholder ? ` (${p.placeholder})` : "";
				return prompt(rl, `${p.message}${suffix}: `);
			},
			onProgress: (message) => console.log(message),
		});
	} finally {
		rl.close();
	}
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));

	if (options.command === "list") {
		console.log("Supported OAuth providers:\n");
		console.log(`  ${ANTHROPIC_PROVIDER}           Anthropic (Claude Pro/Max)`);
		return;
	}

	if (options.provider && options.provider !== ANTHROPIC_PROVIDER) {
		throw new Error(`Unsupported provider: ${options.provider}. For now, pion login only supports '${ANTHROPIC_PROVIDER}'.`);
	}

	const authPath = resolveAuthPath(options.authPath);
	console.log(`Logging in to ${ANTHROPIC_PROVIDER}...`);
	console.log(`Auth file: ${authPath}`);
	await loginAnthropic(authPath);
	console.log(`\nCredentials saved to ${authPath}`);
	console.log("Format is compatible with pi auth.json, but pion keeps its own auth file by default.");
}

main().catch((error) => {
	console.error("Error:", error instanceof Error ? error.message : String(error));
	process.exit(1);
});
