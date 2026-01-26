/**
 * Telegram-specific tools for the agent.
 * Tools = things Claude chooses to invoke (vs provider methods = system invokes)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { parse as parseYaml } from "yaml";
import type { TelegramProvider } from "./telegram.js";

// Import types from pi-coding-agent
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
	ToolDefinition,
} from "@mariozechner/pi-coding-agent";

// Schema for sendSticker tool
const sendStickerSchema = Type.Object({
	name: Type.String({
		description:
			"Name of the sticker to send (e.g., 'pepe_eyes', 'pepe_laugh'). Check stickers.yaml for available names.",
	}),
});

type SendStickerParams = Static<typeof sendStickerSchema>;

// Schema for sendFile tool
const sendFileSchema = Type.Object({
	path: Type.String({
		description: "Absolute path to the file to send (e.g., '/tmp/report.pdf')",
	}),
	caption: Type.Optional(
		Type.String({
			description: "Optional caption to accompany the file",
		}),
	),
});

type SendFileParams = Static<typeof sendFileSchema>;

interface SendStickerDetails {
	name: string;
	fileId?: string;
	success: boolean;
	error?: string;
}

interface SendFileDetails {
	path: string;
	success: boolean;
	messageId?: string;
	error?: string;
}

/**
 * Load stickers from workspace stickers.yaml
 */
function loadStickers(workspacePath: string): Record<string, string> {
	const stickersPath = join(workspacePath, "stickers.yaml");

	if (!existsSync(stickersPath)) {
		return {};
	}

	try {
		const content = readFileSync(stickersPath, "utf-8");
		return parseYaml(content) as Record<string, string>;
	} catch {
		return {};
	}
}

/**
 * Create sendSticker tool bound to a provider and chat.
 */
export function createSendStickerTool(
	provider: TelegramProvider,
	chatId: string,
	workspacePath: string,
): ToolDefinition<typeof sendStickerSchema, SendStickerDetails> {
	return {
		name: "send_sticker",
		description:
			"Send a sticker to the chat. Use semantic names like 'pepe_eyes'. Check your stickers.yaml for available stickers.",
		label: "Send Sticker",
		parameters: sendStickerSchema,

		async execute(
			_toolCallId: string,
			params: SendStickerParams,
			_onUpdate: AgentToolUpdateCallback<SendStickerDetails> | undefined,
			_ctx: ExtensionContext,
			_signal?: AbortSignal,
		): Promise<AgentToolResult<SendStickerDetails>> {
			const stickers = loadStickers(workspacePath);
			const fileId = stickers[params.name];

			if (!fileId) {
				const available = Object.keys(stickers).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Unknown sticker: "${params.name}". Available: ${available}`,
						},
					],
					details: {
						name: params.name,
						success: false,
						error: "Sticker not found",
					},
				};
			}

			try {
				await provider.sendSticker(chatId, fileId);
				return {
					content: [
						{
							type: "text",
							text: `Sent sticker: ${params.name}`,
						},
					],
					details: {
						name: params.name,
						fileId,
						success: true,
					},
				};
			} catch (err) {
				const error = err instanceof Error ? err.message : "Unknown error";
				return {
					content: [
						{
							type: "text",
							text: `Failed to send sticker: ${error}`,
						},
					],
					details: {
						name: params.name,
						fileId,
						success: false,
						error,
					},
				};
			}
		},
	};
}

/**
 * Create sendFile tool bound to a provider and chat.
 */
export function createSendFileTool(
	provider: TelegramProvider,
	chatId: string,
): ToolDefinition<typeof sendFileSchema, SendFileDetails> {
	return {
		name: "send_file",
		description:
			"Send a file from the filesystem to the chat. Works with any file type (PDF, images, documents, etc.).",
		label: "Send File",
		parameters: sendFileSchema,

		async execute(
			_toolCallId: string,
			params: SendFileParams,
			_onUpdate: AgentToolUpdateCallback<SendFileDetails> | undefined,
			_ctx: ExtensionContext,
			_signal?: AbortSignal,
		): Promise<AgentToolResult<SendFileDetails>> {
			try {
				const result = await provider.sendFile(chatId, params.path, {
					caption: params.caption,
				});

				return {
					content: [
						{
							type: "text",
							text: `Sent file: ${params.path}`,
						},
					],
					details: {
						path: params.path,
						success: true,
						messageId: result.messageId,
					},
				};
			} catch (err) {
				const error = err instanceof Error ? err.message : "Unknown error";
				return {
					content: [
						{
							type: "text",
							text: `Failed to send file: ${error}`,
						},
					],
					details: {
						path: params.path,
						success: false,
						error,
					},
				};
			}
		},
	};
}

/**
 * Create all Telegram-specific tools.
 */
export function createTelegramTools(
	provider: TelegramProvider,
	chatId: string,
	workspacePath: string,
): ToolDefinition[] {
	// Type assertion needed due to generic variance issues
	return [
		createSendStickerTool(provider, chatId, workspacePath) as unknown as ToolDefinition,
		createSendFileTool(provider, chatId) as unknown as ToolDefinition,
	];
}
