import { describe, expect, test } from "bun:test";
import type { Config } from "../../src/config/schema.js";
import { Router } from "../../src/core/router.js";
import type { ActionMessage, Message } from "../../src/providers/types.js";

const makeMessage = (overrides: Partial<Message> = {}): Message => ({
	id: "msg-1",
	chatId: "chat-123",
	senderId: "+1234567890",
	text: "Hello",
	isGroup: false,
	provider: "telegram",
	timestamp: new Date(),
	raw: {},
	...overrides,
});

const makeConfig = (overrides: Partial<Config> = {}): Config => ({
	agents: {
		main: {
			model: "anthropic/claude-sonnet-4-20250514",
			workspace: "/tmp/pion/agents/main",
			systemPrompt: "You are helpful.",
			skills: [],
		},
		casual: {
			model: "anthropic/claude-sonnet-4-20250514",
			workspace: "/tmp/pion/agents/casual",
			systemPrompt: "Be casual.",
			skills: [],
		},
	},
	routes: [],
	...overrides,
});

describe("Router", () => {
	test("returns null agent when no routes match", () => {
		const config = makeConfig({ routes: [] });
		const router = new Router(config);
		const result = router.route(makeMessage());

		expect(result.agent).toBeNull();
		expect(result.agentName).toBeNull();
	});

	test("matches DM type", () => {
		const config = makeConfig({
			routes: [{ match: { type: "dm" }, agent: "main", isolation: "per-contact" }],
		});
		const router = new Router(config);

		const dm = makeMessage({ isGroup: false });
		const group = makeMessage({ isGroup: true });

		expect(router.route(dm).agentName).toBe("main");
		expect(router.route(group).agentName).toBeNull();
	});

	test("matches group type", () => {
		const config = makeConfig({
			routes: [{ match: { type: "group" }, agent: "casual", isolation: "per-chat" }],
		});
		const router = new Router(config);

		const dm = makeMessage({ isGroup: false });
		const group = makeMessage({ isGroup: true });

		expect(router.route(dm).agentName).toBeNull();
		expect(router.route(group).agentName).toBe("casual");
	});

	test("matches specific contact", () => {
		const config = makeConfig({
			routes: [
				{ match: { contact: "+1111111111" }, agent: "main", isolation: "per-contact" },
				{ match: { type: "dm" }, agent: "casual", isolation: "per-contact" },
			],
		});
		const router = new Router(config);

		const vip = makeMessage({ senderId: "+1111111111" });
		const other = makeMessage({ senderId: "+2222222222" });

		expect(router.route(vip).agentName).toBe("main");
		expect(router.route(other).agentName).toBe("casual");
	});

	test("matches specific group by name", () => {
		const config = makeConfig({
			routes: [
				{ match: { group: "Friends" }, agent: "casual", isolation: "per-chat" },
				{ match: { type: "group" }, agent: null, isolation: "per-chat" },
			],
		});
		const router = new Router(config);

		const friends = makeMessage({ chatId: "group-Friends-123", isGroup: true });
		const work = makeMessage({ chatId: "group-Work-456", isGroup: true });

		expect(router.route(friends).agentName).toBe("casual");
		expect(router.route(work).agentName).toBeNull();
	});

	test("first matching route wins", () => {
		const config = makeConfig({
			routes: [
				{ match: { contact: "+1111111111" }, agent: "main", isolation: "per-contact" },
				{ match: { type: "dm" }, agent: "casual", isolation: "per-contact" },
			],
		});
		const router = new Router(config);

		const msg = makeMessage({ senderId: "+1111111111", isGroup: false });
		expect(router.route(msg).agentName).toBe("main");
	});

	test("builds correct context key for per-chat isolation", () => {
		const config = makeConfig({
			routes: [{ match: { type: "group" }, agent: "casual", isolation: "per-chat" }],
		});
		const router = new Router(config);

		const msg = makeMessage({ chatId: "group-123", isGroup: true, provider: "whatsapp" });
		const result = router.route(msg);

		expect(result.contextKey).toBe("whatsapp:chat:group-123");
	});

	test("builds correct context key for per-contact isolation", () => {
		const config = makeConfig({
			routes: [{ match: { type: "dm" }, agent: "main", isolation: "per-contact" }],
		});
		const router = new Router(config);

		const msg = makeMessage({ senderId: "+1234567890", provider: "telegram" });
		const result = router.route(msg);

		expect(result.contextKey).toBe("telegram:contact:+1234567890");
	});

	test("null agent route ignores messages", () => {
		const config = makeConfig({
			routes: [{ match: { type: "group" }, agent: null, isolation: "per-chat" }],
		});
		const router = new Router(config);

		const msg = makeMessage({ isGroup: true });
		const result = router.route(msg);

		expect(result.agent).toBeNull();
		expect(result.agentName).toBeNull();
	});

	test("routes actions using the same context logic as messages", () => {
		const config = makeConfig({
			routes: [{ match: { type: "dm" }, agent: "main", isolation: "per-contact" }],
		});
		const router = new Router(config);
		const action: ActionMessage = {
			id: "action-1",
			chatId: "chat-123",
			senderId: "+1234567890",
			provider: "telegram",
			timestamp: new Date(),
			isGroup: false,
			actionId: "stop",
			raw: {},
		};

		const result = router.routeAction(action);
		expect(result.agentName).toBe("main");
		expect(result.contextKey).toBe("telegram:contact:+1234567890");
	});
});
