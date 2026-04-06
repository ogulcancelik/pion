#!/usr/bin/env bun

import { createInterface } from "node:readline";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../src/config/loader.js";
import {
	getAuthPath,
	getConfiguredAuthProviderSummaries,
	getDefaultAuthPath,
	getSupportedAuthProvider,
	getSupportedAuthProviders,
	setApiKeyCredential,
	type SupportedAuthProvider,
} from "../src/core/auth.js";
import { openUrlInBrowser } from "../src/core/browser.js";
import { expandTilde } from "../src/core/paths.js";

type CliOptions = {
	apiKey?: string;
	authPath?: string;
	command: "login" | "list";
	provider?: string;
};

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
	return new Promise((resolve) => rl.question(question, resolve));
}

function parseArgs(argv: string[]): CliOptions {
	let apiKey: string | undefined;
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

		if (arg === "--api-key") {
			apiKey = argv[i + 1];
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

	return { apiKey, authPath, command, provider };
}

function printHelp(): void {
	console.log(`Usage: bun run login [provider] [--api-key <key>] [--auth /path/to/auth.json]\n
Commands:
  login [provider]   Save credentials for an OAuth or API-key provider
  list               Show supported auth providers and configured credentials

Notes:
  - pion defaults to ~/.pion/auth.json
  - pion auth.json is schema-compatible with pi auth.json
  - provider defaults to anthropic when omitted
  - API-key providers can use --api-key or the matching env var

Examples:
  bun run login
  bun run login anthropic
  bun run login openai-codex
  bun run login minimax --api-key "$MINIMAX_API_KEY"
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

async function loginWithOAuth(provider: SupportedAuthProvider, authPath: string): Promise<void> {
	const authStorage = AuthStorage.create(authPath);
	const rl = createInterface({ input: process.stdin, output: process.stdout });

	try {
		await authStorage.login(provider.id, {
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

async function loginWithApiKey(
	provider: SupportedAuthProvider,
	authPath: string,
	cliApiKey?: string,
): Promise<void> {
	const authStorage = AuthStorage.create(authPath);
	const rl = createInterface({ input: process.stdin, output: process.stdout });

	try {
		const apiKey = cliApiKey?.trim() || (provider.envVar ? process.env[provider.envVar]?.trim() : undefined);
		const resolvedApiKey = apiKey || (await prompt(rl, `Enter API key for ${provider.label}: `)).trim();
		setApiKeyCredential(authStorage, provider.id, resolvedApiKey);
	} finally {
		rl.close();
	}
}

function printProviderList(authPath: string): void {
	console.log(`Auth file: ${authPath}\n`);
	console.log("Supported auth providers:\n");
	for (const provider of getSupportedAuthProviders()) {
		const detail = provider.method === "api_key" && provider.envVar ? ` (${provider.envVar})` : "";
		console.log(`  ${provider.id.padEnd(16)} ${provider.method.padEnd(7)} ${provider.label}${detail}`);
	}

	const authStorage = AuthStorage.create(authPath);
	const configured = getConfiguredAuthProviderSummaries(authStorage);
	console.log("\nConfigured providers:\n");
	if (configured.length === 0) {
		console.log("  (none)");
		return;
	}
	for (const provider of configured) {
		console.log(`  ${provider.id.padEnd(16)} ${provider.credentialType}`);
	}
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const authPath = resolveAuthPath(options.authPath);

	if (options.command === "list") {
		printProviderList(authPath);
		return;
	}

	const provider = getSupportedAuthProvider(options.provider ?? "anthropic");
	if (!provider) {
		throw new Error(
			`Unsupported provider: ${options.provider}. Run 'bun run login list' to see supported providers.`,
		);
	}

	console.log(`Auth file: ${authPath}`);
	console.log(`Provider: ${provider.id} (${provider.method})`);

	if (provider.method === "oauth") {
		if (options.apiKey) {
			throw new Error(`Provider '${provider.id}' uses OAuth and does not accept --api-key.`);
		}
		console.log(`Logging in to ${provider.label}...`);
		await loginWithOAuth(provider, authPath);
	} else {
		console.log(`Saving API key for ${provider.label}...`);
		await loginWithApiKey(provider, authPath, options.apiKey);
	}

	console.log(`\nCredentials saved to ${authPath}`);
	console.log("Format is compatible with pi auth.json, but pion keeps its own auth file by default.");
}

main().catch((error) => {
	console.error("Error:", error instanceof Error ? error.message : String(error));
	process.exit(1);
});
