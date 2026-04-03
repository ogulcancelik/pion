import { existsSync } from "node:fs";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { type Api, type Model, completeSimple } from "@mariozechner/pi-ai";
import {
	type ExtensionCommandContext,
	SessionManager,
	type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import type { IndexedSessionMessage } from "./sqlite-index.js";

const sessionSearchSchema = Type.Object({
	query: Type.String({
		description:
			"Search keywords or a short phrase for finding relevant past sessions. Use simple words, not SQL.",
	}),
});

const sessionQuerySchema = Type.Object({
	sessionPath: Type.String({
		description: "Absolute path to the session JSONL file to inspect.",
	}),
	question: Type.String({
		description: "A direct question about that session.",
	}),
});

type SessionSearchParams = Static<typeof sessionSearchSchema>;
type SessionQueryParams = Static<typeof sessionQuerySchema>;

export interface RecallAnswerInput {
	sessionPath: string;
	question: string;
	serializedConversation: string;
	queryModel: Model<Api>;
	signal?: AbortSignal;
	ctx: ExtensionCommandContext;
}

export interface RecallToolsOptions {
	searchSessionMessages: (query: string, limit: number) => IndexedSessionMessage[];
	recallQueryModel?: string;
	loadSessionMessages?: (sessionPath: string) => AgentMessage[];
	answerSessionQuestion?: (input: RecallAnswerInput) => Promise<string>;
}

const SEARCH_LIMIT = 50;
const MAX_SESSION_RESULTS = 8;
const MAX_SNIPPETS_PER_SESSION = 3;
const SNIPPET_LENGTH = 180;
const RECALL_SYSTEM_PROMPT = `You are analyzing a past Pion session.
Answer only from the provided session transcript.
Be concise and concrete.
If the answer is not present in the session, say so.`;

export function createRecallTools(options: RecallToolsOptions): ToolDefinition[] {
	const loadSessionMessages = options.loadSessionMessages ?? defaultLoadSessionMessages;
	const answerSessionQuestion = options.answerSessionQuestion ?? defaultAnswerSessionQuestion;

	const sessionSearchTool: ToolDefinition<typeof sessionSearchSchema> = {
		name: "session_search",
		label: "Session Search",
		description:
			"Search past Pion sessions by plain words or a short phrase. Returns matching session files with short snippets.",
		promptSnippet:
			"session_search(query) - search past sessions by simple keywords/phrases and return matching session files with snippets",
		promptGuidelines: [
			"Use session_search when the user refers to a previous conversation, past task, or earlier decision.",
			"After session_search, use session_query with a specific session path if you need details from one session.",
		],
		parameters: sessionSearchSchema,
		async execute(_toolCallId, params: SessionSearchParams) {
			const query = params.query.trim();
			if (query.length === 0) {
				return {
					content: [{ type: "text", text: "Search query must not be empty." }],
					details: { error: true },
				};
			}

			const rows = options.searchSessionMessages(query, SEARCH_LIMIT);
			if (rows.length === 0) {
				return {
					content: [{ type: "text", text: `No sessions found matching \"${query}\".` }],
					details: { matchCount: 0, query },
				};
			}

			const grouped = groupSearchRows(rows);
			const topSessions = grouped
				.sort(
					(a, b) => b.hitCount - a.hitCount || b.latestTimestamp.localeCompare(a.latestTimestamp),
				)
				.slice(0, MAX_SESSION_RESULTS);

			const body = topSessions
				.map(
					(group) =>
						`${group.sessionFile}\n${group.hitCount} hit(s)\n${group.snippets
							.slice(0, MAX_SNIPPETS_PER_SESSION)
							.map((snippet) => `  [${snippet.role}] ${snippet.text}`)
							.join("\n")}`,
				)
				.join("\n\n---\n\n");

			return {
				content: [
					{
						type: "text",
						text: `Found ${topSessions.length} session(s) matching \"${query}\":\n\n${body}`,
					},
				],
				details: { matchCount: topSessions.length, query },
			};
		},
	};

	const sessionQueryTool: ToolDefinition<typeof sessionQuerySchema> = {
		name: "session_query",
		label: "Session Query",
		description:
			"Ask a direct question about a specific past Pion session file. Use after session_search or when you already know the session path.",
		promptSnippet:
			"session_query(sessionPath, question) - ask a direct question about one specific past session",
		parameters: sessionQuerySchema,
		async execute(
			_toolCallId,
			params: SessionQueryParams,
			signal: AbortSignal | undefined,
			_onUpdate,
			ctx: ExtensionCommandContext,
		) {
			const sessionPath = params.sessionPath.trim();
			const question = params.question.trim();

			if (!sessionPath.endsWith(".jsonl")) {
				return {
					content: [{ type: "text", text: `Invalid session path: ${sessionPath}` }],
					details: { error: true },
				};
			}
			if (!existsSync(sessionPath)) {
				return {
					content: [{ type: "text", text: `Session file not found: ${sessionPath}` }],
					details: { error: true },
				};
			}
			if (question.length === 0) {
				return {
					content: [{ type: "text", text: "Question must not be empty." }],
					details: { error: true },
				};
			}

			const messages = loadSessionMessages(sessionPath);
			if (messages.length === 0) {
				return {
					content: [{ type: "text", text: "Session is empty - no messages found." }],
					details: { empty: true },
				};
			}

			const queryModel = resolveRecallQueryModel(options.recallQueryModel, ctx);
			if (!queryModel) {
				return {
					content: [
						{
							type: "text",
							text: "No model available for session recall. Configure recallQueryModel or ensure the current session has an active model.",
						},
					],
					details: { error: true },
				};
			}

			const serializedConversation = serializeSessionMessagesForRecall(messages);
			const answer = await answerSessionQuestion({
				sessionPath,
				question,
				serializedConversation,
				queryModel,
				signal,
				ctx,
			});

			return {
				content: [{ type: "text", text: answer }],
				details: { sessionPath, question, model: `${queryModel.provider}/${queryModel.id}` },
			};
		},
	};

	return [
		sessionSearchTool as unknown as ToolDefinition,
		sessionQueryTool as unknown as ToolDefinition,
	];
}

export function serializeSessionMessagesForRecall(messages: AgentMessage[]): string {
	const lines: string[] = [];

	for (const message of messages) {
		if (message.role === "toolResult") {
			continue;
		}

		if (message.role === "user") {
			const text = extractTextBlocks(message.content);
			if (text) {
				lines.push(`[User]: ${text}`);
			}
			continue;
		}

		if (message.role === "assistant") {
			const text = extractTextBlocks(message.content);
			const toolCalls = extractAssistantToolCalls(message.content);
			if (text) {
				lines.push(`[Assistant]: ${text}`);
			}
			if (toolCalls.length > 0) {
				lines.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		}
	}

	return lines.join("\n\n");
}

function extractTextBlocks(content: unknown): string {
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.flatMap((part) => {
			if (!part || typeof part !== "object" || !("type" in part)) {
				return [];
			}
			if (part.type === "text" && "text" in part && typeof part.text === "string") {
				return [part.text];
			}
			if (part.type === "image") {
				return ["[image]"];
			}
			return [];
		})
		.join("\n")
		.trim();
}

function extractAssistantToolCalls(content: unknown): string[] {
	if (!Array.isArray(content)) {
		return [];
	}

	const toolCalls: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object" || !("type" in part) || part.type !== "toolCall") {
			continue;
		}
		const name = "name" in part && typeof part.name === "string" ? part.name : "tool";
		const args =
			"arguments" in part && part.arguments && typeof part.arguments === "object"
				? (part.arguments as Record<string, unknown>)
				: {};
		toolCalls.push(formatToolCall(name, args));
	}
	return toolCalls;
}

function formatToolCall(name: string, args: Record<string, unknown>): string {
	const details: string[] = [];
	if (typeof args.path === "string") {
		details.push(`path=${args.path}`);
	}
	if (typeof args.command === "string") {
		details.push(`command=${args.command}`);
	}
	if (typeof args.pattern === "string") {
		details.push(`pattern=${args.pattern}`);
	}
	if (typeof args.query === "string") {
		details.push(`query=${args.query}`);
	}
	return details.length > 0 ? `${name} ${details.join(" ")}` : name;
}

function groupSearchRows(rows: IndexedSessionMessage[]): Array<{
	sessionFile: string;
	hitCount: number;
	latestTimestamp: string;
	snippets: Array<{ role: string; text: string }>;
}> {
	const grouped = new Map<
		string,
		{
			sessionFile: string;
			hitCount: number;
			latestTimestamp: string;
			snippets: Array<{ role: string; text: string }>;
		}
	>();

	for (const row of rows) {
		const existing = grouped.get(row.sessionFile) ?? {
			sessionFile: row.sessionFile,
			hitCount: 0,
			latestTimestamp: row.timestamp,
			snippets: [],
		};
		existing.hitCount += 1;
		if (row.timestamp > existing.latestTimestamp) {
			existing.latestTimestamp = row.timestamp;
		}
		if (existing.snippets.length < MAX_SNIPPETS_PER_SESSION) {
			existing.snippets.push({ role: row.role.toLowerCase(), text: snippet(row.text) });
		}
		grouped.set(row.sessionFile, existing);
	}

	return Array.from(grouped.values());
}

function snippet(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= SNIPPET_LENGTH) {
		return normalized;
	}
	return `${normalized.slice(0, SNIPPET_LENGTH - 3)}...`;
}

function resolveRecallQueryModel(
	recallQueryModel: string | undefined,
	ctx: ExtensionCommandContext,
): Model<Api> | undefined {
	if (!recallQueryModel) {
		return ctx.model as Model<Api> | undefined;
	}

	const slashIndex = recallQueryModel.indexOf("/");
	if (slashIndex <= 0 || slashIndex >= recallQueryModel.length - 1) {
		return undefined;
	}

	return ctx.modelRegistry.find(
		recallQueryModel.slice(0, slashIndex),
		recallQueryModel.slice(slashIndex + 1),
	) as Model<Api> | undefined;
}

function defaultLoadSessionMessages(sessionPath: string): AgentMessage[] {
	const sessionManager = SessionManager.open(sessionPath);
	return sessionManager
		.getBranch()
		.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

async function defaultAnswerSessionQuestion(input: RecallAnswerInput): Promise<string> {
	const auth = await input.ctx.modelRegistry.getApiKeyAndHeaders(input.queryModel);
	if (!auth.ok) {
		throw new Error(`Error resolving model auth: ${auth.error}`);
	}

	const conversation = windowConversationForQuestion(
		input.serializedConversation,
		input.question,
		Math.floor((input.queryModel.contextWindow || 32_000) * 0.8),
	);
	const response = await completeSimple(
		input.queryModel,
		{
			systemPrompt: RECALL_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: `## Session transcript\n\n${conversation}\n\n## Question\n\n${input.question}`,
						},
					],
					timestamp: Date.now(),
				},
			],
		},
		input.queryModel.reasoning
			? {
					apiKey: auth.apiKey,
					headers: auth.headers,
					signal: input.signal,
					maxTokens: 1024,
					reasoning: "medium",
				}
			: {
					apiKey: auth.apiKey,
					headers: auth.headers,
					signal: input.signal,
					maxTokens: 1024,
				},
	);

	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "Session recall query failed.");
	}

	return response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function windowConversationForQuestion(
	serializedConversation: string,
	question: string,
	tokenBudget: number,
): string {
	if (estimateTokens(serializedConversation) <= tokenBudget) {
		return serializedConversation;
	}

	const blocks = serializedConversation.split(/\n\n+/).filter(Boolean);
	if (blocks.length <= 8) {
		return serializedConversation;
	}

	const included = new Set<number>();
	for (let i = 0; i < Math.min(4, blocks.length); i++) included.add(i);
	for (let i = Math.max(0, blocks.length - 4); i < blocks.length; i++) included.add(i);

	const keywords = extractKeywords(question);
	const scored = blocks
		.map((block, index) => ({
			index,
			score: keywords.reduce(
				(total, keyword) => total + (block.toLowerCase().includes(keyword) ? 1 : 0),
				0,
			),
		}))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score);

	for (const entry of scored) {
		included.add(entry.index);
		if (estimateTokens(joinBlocks(blocks, included)) > tokenBudget) {
			included.delete(entry.index);
			break;
		}
	}

	return joinBlocks(blocks, included);
}

function joinBlocks(blocks: string[], included: Set<number>): string {
	const sorted = [...included].sort((a, b) => a - b);
	const parts: string[] = [];
	let previous = -1;
	for (const index of sorted) {
		if (previous >= 0 && index > previous + 1) {
			parts.push(`[... ${index - previous - 1} omitted block(s) ...]`);
		}
		const block = blocks[index];
		if (!block) {
			continue;
		}
		parts.push(block);
		previous = index;
	}
	return parts.join("\n\n");
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function extractKeywords(question: string): string[] {
	const stopWords = new Set([
		"the",
		"and",
		"for",
		"with",
		"that",
		"this",
		"what",
		"when",
		"where",
		"how",
		"did",
		"was",
		"were",
		"are",
		"our",
		"your",
		"about",
		"from",
		"into",
		"have",
		"has",
		"had",
		"they",
		"them",
		"then",
		"than",
		"just",
		"session",
	]);
	return question
		.toLowerCase()
		.replace(/[^\w\s-]/g, " ")
		.split(/\s+/)
		.filter((word) => word.length > 2 && !stopWords.has(word));
}
