import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config/loader.js";
import { Commands } from "../src/core/commands.js";
import { Router } from "../src/core/router.js";

/**
 * Daemon component tests.
 *
 * The Daemon class isn't exported, and importing daemon.ts would call main().
 * Instead, we test the composed pieces that the daemon relies on, verifying
 * they work together correctly in daemon-like scenarios.
 */
describe("Daemon components", () => {
	describe("config loading", () => {
		test("loads example config successfully", () => {
			const config = loadConfig("pion.example.yaml");
			expect(config).toBeDefined();
			expect(config.agents).toBeDefined();
			expect(config.routes).toBeArray();
		});

		test("example config has expected agents", () => {
			const config = loadConfig("pion.example.yaml");
			expect(Object.keys(config.agents)).toContain("main");
			expect(Object.keys(config.agents)).toContain("casual");
			expect(Object.keys(config.agents)).toContain("family");
		});

		test("example config agents have required fields", () => {
			const config = loadConfig("pion.example.yaml");
			for (const [name, agent] of Object.entries(config.agents)) {
				expect(agent.model).toBeString();
				expect(agent.model.length).toBeGreaterThan(0);
			}
		});

		test("example config routes reference valid agents", () => {
			const config = loadConfig("pion.example.yaml");
			const agentNames = Object.keys(config.agents);
			for (const route of config.routes) {
				if (route.agent !== null) {
					expect(agentNames).toContain(route.agent);
				}
			}
		});

		test("example config has telegram section", () => {
			const config = loadConfig("pion.example.yaml");
			expect(config.telegram).toBeDefined();
			expect(config.telegram!.botToken).toBeString();
		});

		test("throws on missing config file", () => {
			expect(() => loadConfig("nonexistent.yaml")).toThrow();
		});

		test("throws on invalid config", () => {
			// Write a temp invalid config
			const { writeFileSync, unlinkSync } = require("node:fs");
			const tmpPath = "/tmp/pion-test-invalid.yaml";
			writeFileSync(tmpPath, "invalid: true\n");
			try {
				expect(() => loadConfig(tmpPath)).toThrow("Invalid config");
			} finally {
				unlinkSync(tmpPath);
			}
		});
	});

	describe("command parsing for daemon commands", () => {
		const commands = new Commands();

		test("/new command is parsed correctly", () => {
			const result = commands.parse("/new");
			expect(result).toEqual({ command: "new", args: "" });
		});

		test("/compact command is parsed correctly", () => {
			const result = commands.parse("/compact");
			expect(result).toEqual({ command: "compact", args: "" });
		});

		test("/compact with focus args", () => {
			const result = commands.parse("/compact focus on API changes");
			expect(result).toEqual({ command: "compact", args: "focus on API changes" });
		});

		test("/stop command is parsed correctly", () => {
			const result = commands.parse("/stop");
			expect(result).toEqual({ command: "stop", args: "" });
		});

		test("regular messages are not commands", () => {
			expect(commands.parse("hello")).toBeNull();
			expect(commands.parse("what is new?")).toBeNull();
			expect(commands.parse("please stop that")).toBeNull();
		});

		test("unknown commands return null", () => {
			expect(commands.parse("/help")).toBeNull();
			expect(commands.parse("/restart")).toBeNull();
			expect(commands.parse("/reload")).toBeNull();
		});
	});

	describe("router with example config", () => {
		test("router initializes with example config", () => {
			const config = loadConfig("pion.example.yaml");
			const router = new Router(config);
			expect(router).toBeDefined();
		});

		test("routes DM messages to main agent", () => {
			const config = loadConfig("pion.example.yaml");
			const router = new Router(config);

			const result = router.route({
				id: "1",
				provider: "telegram",
				chatId: "some-chat",
				senderId: "unknown-sender",
				text: "hello",
				timestamp: Date.now(),
				isGroup: false,
			});

			// Example config routes all DMs to main
			expect(result.agentName).toBe("main");
			expect(result.agent).toBeDefined();
		});

		test("routes group messages to null (ignored)", () => {
			const config = loadConfig("pion.example.yaml");
			const router = new Router(config);

			const result = router.route({
				id: "2",
				provider: "telegram",
				chatId: "some-group",
				senderId: "someone",
				text: "hey all",
				timestamp: Date.now(),
				isGroup: true,
			});

			// Example config ignores unmatched groups (agent: null)
			expect(result.agent).toBeNull();
		});

		test("routes specific contact to configured agent", () => {
			const config = loadConfig("pion.example.yaml");
			const router = new Router(config);

			// Example config has contact: "+1234567890" → main
			const result = router.route({
				id: "3",
				provider: "whatsapp",
				chatId: "direct-chat",
				senderId: "+1234567890",
				text: "hi",
				timestamp: Date.now(),
				isGroup: false,
			});

			expect(result.agentName).toBe("main");
			expect(result.isolation).toBe("per-contact");
		});

		test("context key includes provider prefix", () => {
			const config = loadConfig("pion.example.yaml");
			const router = new Router(config);

			const result = router.route({
				id: "4",
				provider: "telegram",
				chatId: "chat-123",
				senderId: "user-456",
				text: "test",
				timestamp: Date.now(),
				isGroup: false,
			});

			expect(result.contextKey).toStartWith("telegram:");
		});
	});
});
