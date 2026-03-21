import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	createSendFileTool,
	createSendStickerTool,
	createTelegramTools,
} from "../../src/providers/telegram-tools.js";
import type { TelegramProvider } from "../../src/providers/telegram.js";

// Temp workspace with stickers.yaml
const tmpWorkspace = join(tmpdir(), `pion-test-${Date.now()}`);
const emptyWorkspace = join(tmpdir(), `pion-test-empty-${Date.now()}`);

beforeAll(() => {
	mkdirSync(tmpWorkspace, { recursive: true });
	writeFileSync(join(tmpWorkspace, "stickers.yaml"), "pepe_happy: ABC123\npepe_sad: DEF456");
	mkdirSync(emptyWorkspace, { recursive: true });
});

afterAll(() => {
	rmSync(tmpWorkspace, { recursive: true, force: true });
	rmSync(emptyWorkspace, { recursive: true, force: true });
});

function createMockProvider(overrides?: Partial<TelegramProvider>) {
	return {
		sendSticker: mock(() => Promise.resolve()),
		sendFile: mock(() => Promise.resolve({ messageId: "123", chatId: "456" })),
		...overrides,
	} as unknown as TelegramProvider;
}

const CHAT_ID = "test-chat-123";
const mockExtensionContext = {} as ExtensionContext;

describe("createSendStickerTool", () => {
	test("returns tool with correct name and description", () => {
		const provider = createMockProvider();
		const tool = createSendStickerTool(provider, CHAT_ID, tmpWorkspace);

		expect(tool.name).toBe("send_sticker");
		expect(tool.description).toContain("sticker");
		expect(tool.parameters).toBeDefined();
	});

	test("execute with valid sticker name sends sticker", async () => {
		const provider = createMockProvider();
		const tool = createSendStickerTool(provider, CHAT_ID, tmpWorkspace);

		const result = await tool.execute(
			"test-id",
			{ name: "pepe_happy" },
			undefined,
			undefined,
			mockExtensionContext,
		);

		expect(provider.sendSticker).toHaveBeenCalledWith(CHAT_ID, "ABC123");
		expect(result.details?.success).toBe(true);
		expect(result.details?.name).toBe("pepe_happy");
		expect(result.details?.fileId).toBe("ABC123");
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Sent sticker: pepe_happy",
		});
	});

	test("execute with unknown sticker name returns error with available names", async () => {
		const provider = createMockProvider();
		const tool = createSendStickerTool(provider, CHAT_ID, tmpWorkspace);

		const result = await tool.execute(
			"test-id",
			{ name: "pepe_unknown" },
			undefined,
			undefined,
			mockExtensionContext,
		);

		expect(provider.sendSticker).not.toHaveBeenCalled();
		expect(result.details?.success).toBe(false);
		expect(result.details?.error).toBe("Sticker not found");
		expect(result.content[0]).toEqual({
			type: "text",
			text: 'Unknown sticker: "pepe_unknown". Available: pepe_happy, pepe_sad',
		});
	});

	test("execute with no stickers.yaml returns error with 'none' available", async () => {
		const provider = createMockProvider();
		const tool = createSendStickerTool(provider, CHAT_ID, emptyWorkspace);

		const result = await tool.execute(
			"test-id",
			{ name: "anything" },
			undefined,
			undefined,
			mockExtensionContext,
		);

		expect(provider.sendSticker).not.toHaveBeenCalled();
		expect(result.details?.success).toBe(false);
		expect(result.content[0]).toEqual({
			type: "text",
			text: 'Unknown sticker: "anything". Available: none',
		});
	});

	test("execute handles provider error", async () => {
		const provider = createMockProvider({
			sendSticker: mock(() =>
				Promise.reject(new Error("Network error")),
			) as TelegramProvider["sendSticker"],
		});
		const tool = createSendStickerTool(provider, CHAT_ID, tmpWorkspace);

		const result = await tool.execute(
			"test-id",
			{ name: "pepe_happy" },
			undefined,
			undefined,
			mockExtensionContext,
		);

		expect(result.details?.success).toBe(false);
		expect(result.details?.error).toBe("Network error");
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Failed to send sticker: Network error",
		});
	});
});

describe("createSendFileTool", () => {
	test("returns tool with correct name and description", () => {
		const provider = createMockProvider();
		const tool = createSendFileTool(provider, CHAT_ID);

		expect(tool.name).toBe("send_file");
		expect(tool.description).toContain("file");
		expect(tool.parameters).toBeDefined();
	});

	test("execute with valid path sends file and returns success", async () => {
		const provider = createMockProvider();
		const tool = createSendFileTool(provider, CHAT_ID);

		const result = await tool.execute(
			"test-id",
			{ path: "/tmp/report.pdf" },
			undefined,
			undefined,
			mockExtensionContext,
		);

		expect(provider.sendFile).toHaveBeenCalledWith(CHAT_ID, "/tmp/report.pdf", {
			caption: undefined,
		});
		expect(result.details?.success).toBe(true);
		expect(result.details?.path).toBe("/tmp/report.pdf");
		expect(result.details?.messageId).toBe("123");
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Sent file: /tmp/report.pdf",
		});
	});

	test("execute with caption passes it to provider", async () => {
		const provider = createMockProvider();
		const tool = createSendFileTool(provider, CHAT_ID);

		await tool.execute(
			"test-id",
			{ path: "/tmp/photo.jpg", caption: "Check this out" },
			undefined,
			undefined,
			mockExtensionContext,
		);

		expect(provider.sendFile).toHaveBeenCalledWith(CHAT_ID, "/tmp/photo.jpg", {
			caption: "Check this out",
		});
	});

	test("execute handles provider error", async () => {
		const provider = createMockProvider({
			sendFile: mock(() =>
				Promise.reject(new Error("File not found")),
			) as TelegramProvider["sendFile"],
		});
		const tool = createSendFileTool(provider, CHAT_ID);

		const result = await tool.execute(
			"test-id",
			{ path: "/nonexistent/file.pdf" },
			undefined,
			undefined,
			mockExtensionContext,
		);

		expect(result.details?.success).toBe(false);
		expect(result.details?.error).toBe("File not found");
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Failed to send file: File not found",
		});
	});
});

describe("createTelegramTools", () => {
	test("returns array of 2 tools", () => {
		const provider = createMockProvider();
		const tools = createTelegramTools(provider, CHAT_ID, tmpWorkspace);

		expect(tools).toHaveLength(2);
	});

	test("tools have correct names", () => {
		const provider = createMockProvider();
		const tools = createTelegramTools(provider, CHAT_ID, tmpWorkspace);

		const names = tools.map((t) => t.name);
		expect(names).toContain("send_sticker");
		expect(names).toContain("send_file");
	});
});
