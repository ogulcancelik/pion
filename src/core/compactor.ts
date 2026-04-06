/**
 * Session compactor - summarizes conversation history using Haiku.
 */

import { existsSync, readFileSync } from "node:fs";
import { completeSimple } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { getAuthPath } from "./auth.js";

// Hardcoded summarizer model
const SUMMARIZER_MODEL = "anthropic/claude-haiku-4-5";
export const HANDOFF_START = "<<<PI_HANDOFF_START>>>";
export const HANDOFF_END = "<<<PI_HANDOFF_END>>>";
export const AUTO_COMPACTION_THRESHOLD_PERCENT = 90;

export interface ConversationMessage {
	role: "user" | "assistant";
	content: string;
	/** Tool calls made in this message (e.g., "read src/foo.ts", "bash ls") */
	tools: string[];
}

/** Content part types we care about */
interface TextPart {
	type: "text";
	text: string;
}

interface ImagePart {
	type: "image";
}

interface ToolCallPart {
	type: "toolCall";
	name: string;
	arguments?: {
		path?: string;
		command?: string;
	};
}

type ContentPart = TextPart | ImagePart | ToolCallPart | { type: string };

/**
 * Extract conversation from a JSONL session file.
 * Returns simplified user/assistant messages with tool metadata for summarization.
 *
 * Handles pi-agent session format:
 * - Entries are wrapped: { type: "message", message: { role, content } }
 * - Content is an array of parts: text, toolCall, thinking, image, etc.
 */
export function extractConversation(sessionFile: string): ConversationMessage[] {
	if (!existsSync(sessionFile)) {
		return [];
	}

	const content = readFileSync(sessionFile, "utf-8");
	const lines = content.split("\n").filter((l) => l.trim());
	const messages: ConversationMessage[] = [];

	for (const line of lines) {
		try {
			const entry = JSON.parse(line);

			// Only process message entries (skip session, model_change, etc.)
			if (entry.type !== "message") {
				continue;
			}

			const msg = entry.message;
			if (!msg) continue;

			// Only include user and assistant messages
			if (msg.role !== "user" && msg.role !== "assistant") {
				continue;
			}

			// Skip toolResult messages
			if (msg.role === "toolResult") {
				continue;
			}

			// Extract text content and tool calls from content array
			const contentParts: ContentPart[] = Array.isArray(msg.content) ? msg.content : [];

			// Collect text parts
			const textParts: string[] = [];
			for (const part of contentParts) {
				if (part.type === "text" && "text" in part) {
					textParts.push(part.text);
				} else if (part.type === "image") {
					textParts.push("[image]");
				}
				// Skip thinking, toolCall for text (toolCalls extracted separately)
			}
			const textContent = textParts.join(" ").trim();

			// Collect tool calls (assistant messages only)
			const tools: string[] = [];
			if (msg.role === "assistant") {
				for (const part of contentParts) {
					if (part.type === "toolCall" && "name" in part) {
						const toolDesc = formatToolCall(part as ToolCallPart);
						if (toolDesc) tools.push(toolDesc);
					}
				}
			}

			// Only add if there's text content
			if (textContent) {
				messages.push({
					role: msg.role,
					content: textContent,
					tools,
				});
			}
		} catch {
			// Skip invalid JSON lines
		}
	}

	return messages;
}

/**
 * Format a tool call for the summary.
 * e.g., "read src/foo.ts", "bash ls -la", "edit src/bar.ts"
 */
function formatToolCall(part: ToolCallPart): string | null {
	const { name, arguments: args } = part;

	if (!name) return null;

	switch (name) {
		case "read":
		case "edit":
		case "write":
			return args?.path ? `${name} ${args.path}` : name;
		case "bash":
			// Include command but truncate if too long
			if (args?.command) {
				const cmd = args.command.length > 40 ? `${args.command.slice(0, 40)}...` : args.command;
				return `bash ${cmd}`;
			}
			return "bash";
		default:
			return name;
	}
}

/**
 * Build the summarization prompt.
 * Exported for testing.
 */
export function buildSummaryPrompt(messages: ConversationMessage[], focus?: string): string {
	const conversation = messages
		.map((m) => {
			let line = `${m.role.toUpperCase()}: `;

			// Add tool metadata for assistant messages
			if (m.tools && m.tools.length > 0) {
				line += `[tools: ${m.tools.join(", ")}]\n`;
			}

			line += m.content;
			return line;
		})
		.join("\n\n");

	let prompt = `Summarize this conversation concisely for continuity. 
Capture key context, decisions, and any ongoing work.
Be brief but preserve important details the assistant would need to continue helpfully.

`;

	if (focus) {
		prompt += `Focus especially on: ${focus}\n\n`;
	}

	prompt += `CONVERSATION:\n${conversation}\n\nSUMMARY:`;

	return prompt;
}

export interface HandoffPromptOptions {
	focus?: string;
	pendingUserMessage?: string;
}

export interface CompactorConfig {
	/** Path to auth storage (default: ~/.pion/auth.json) */
	authPath?: string;
}

export function shouldAutoCompact(
	contextUsagePercent: number | null | undefined,
	thresholdPercent = AUTO_COMPACTION_THRESHOLD_PERCENT,
): boolean {
	return (
		contextUsagePercent !== null &&
		contextUsagePercent !== undefined &&
		contextUsagePercent >= thresholdPercent
	);
}

export function buildHandoffPrompt(options: HandoffPromptOptions = {}): string {
	const sections = [
		"[SYSTEM] Context is nearly full. We are handing this conversation off to a fresh session.",
		"Do not answer the pending user request yet.",
		"Do not call tools.",
		"Write a concise but complete handoff for the next agent using the current session context.",
		"Include: current goals, important facts, decisions, unfinished work, open questions, and immediate next actions.",
		`Return exactly one final block using these standalone delimiters on their own lines:\n${HANDOFF_START}\n...your handoff...\n${HANDOFF_END}`,
		"Do not use those delimiters anywhere else.",
	];

	if (options.focus) {
		sections.push(`Focus especially on: ${options.focus}`);
	}
	if (options.pendingUserMessage) {
		sections.push(`Pending user request:\n${options.pendingUserMessage}`);
	}

	return sections.join("\n\n");
}

export function extractHandoffBlock(text: string): string | undefined {
	const pattern = new RegExp(`${HANDOFF_START}\\s*([\\s\\S]*?)\\s*${HANDOFF_END}`, "g");
	let last: string | undefined;
	for (const match of text.matchAll(pattern)) {
		const body = match[1]?.trim();
		if (body) {
			last = body;
		}
	}
	return last;
}

export function buildContinuationSeedPrompt(handoff: string, archivedSessionFile?: string): string {
	if (!archivedSessionFile) {
		return `[Previous conversation handoff]\n\n${handoff.trim()}`;
	}
	return [
		"[Previous conversation handoff]",
		"",
		`Parent session: ${archivedSessionFile}`,
		`Use session_query(\"${archivedSessionFile}\", "<question>") if you need more detail from the previous session.`,
		"",
		handoff.trim(),
	].join("\n");
}

/**
 * Compactor summarizes session history using Haiku.
 */
export class Compactor {
	private authStorage: AuthStorage;
	private modelRegistry: ModelRegistry;

	constructor(config: CompactorConfig = {}) {
		const authPath = getAuthPath(config);
		this.authStorage = AuthStorage.create(authPath);
		this.modelRegistry = ModelRegistry.create(this.authStorage);
	}

	/**
	 * Summarize a session file.
	 * @param sessionFile Path to the JSONL session file
	 * @param focus Optional focus for the summary (e.g., "the API design work")
	 * @returns The summary text
	 */
	async summarize(sessionFile: string, focus?: string): Promise<string> {
		// Extract conversation
		const messages = extractConversation(sessionFile);

		if (messages.length === 0) {
			return "No conversation history to summarize.";
		}

		// Build prompt
		const prompt = buildSummaryPrompt(messages, focus);

		// Get Haiku model
		const parts = SUMMARIZER_MODEL.split("/");
		const provider = parts[0];
		const modelId = parts[1];
		if (!provider || !modelId) {
			throw new Error(`Invalid summarizer model format: ${SUMMARIZER_MODEL}`);
		}
		const model = this.modelRegistry.find(provider, modelId);

		if (!model) {
			throw new Error(`Summarizer model not found: ${SUMMARIZER_MODEL}`);
		}

		// Get API key (handles OAuth token refresh)
		const apiKey = await this.authStorage.getApiKey(provider);
		if (!apiKey) {
			throw new Error(`No auth configured for provider: ${provider}`);
		}

		// Call the model using pi-ai's completeSimple
		const response = await completeSimple(
			model,
			{
				messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
			},
			{
				apiKey,
				maxTokens: 1024,
			},
		);

		// Extract text from response
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");

		return text.trim();
	}
}
