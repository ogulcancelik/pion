#!/usr/bin/env bun

/**
 * Pion - Simple messaging bridge for pi-agent
 */

import { loadConfig } from "./config/loader.js";
import type { Config } from "./config/schema.js";
import { Router } from "./core/router.js";

async function main() {
	console.log("🔮 Pion starting...\n");

	// Load config
	let config: Config;
	try {
		config = loadConfig();
		console.log(`✓ Loaded config with ${Object.keys(config.agents).length} agents`);
		console.log(`  Routes: ${config.routes.length}`);
	} catch (error) {
		console.error("Failed to load config:", error);
		process.exit(1);
	}

	// Initialize router
	const router = new Router(config);
	console.log("✓ Router initialized");

	// TODO: Initialize providers
	// TODO: Initialize runner
	// TODO: Wire everything together

	console.log("\n🚧 Core not yet implemented. Run tests: bun test");
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
