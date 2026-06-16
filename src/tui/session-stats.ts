export interface SessionEntry {
	type: string;
	id?: string;
	timestamp?: string;
	cwd?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	message?: {
		role: string;
		content: Array<{
			type: string;
			text?: string;
			thinking?: string;
			thinkingSignature?: string;
			name?: string;
			id?: string;
			arguments?: unknown;
		}>;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
		details?: unknown;
		api?: string;
		provider?: string;
		model?: string;
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			cost?: { total?: number };
		};
		stopReason?: string;
		timestamp?: number;
		errorMessage?: string;
	};
}

export interface SessionStats {
	totalInput: number;
	totalOutput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalCost: number;
	contextTokens: number;
	contextPercent: number;
	model: string;
	thinkingLevel: string;
	cwd: string;
}

export function inferModelString(
	entries: SessionEntry[],
	options: { agentModel?: string } = {},
): string | undefined {
	if (options.agentModel) return options.agentModel;

	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "model_change" && entry.provider && entry.modelId) {
			return `${entry.provider}/${entry.modelId}`;
		}
	}

	const sessionHeader = entries.find((entry) => entry.type === "session");
	if (sessionHeader?.provider && sessionHeader.modelId) {
		return `${sessionHeader.provider}/${sessionHeader.modelId}`;
	}

	for (let index = entries.length - 1; index >= 0; index--) {
		const message = entries[index]?.message;
		if (message?.role === "assistant" && message.provider && message.model) {
			return `${message.provider}/${message.model}`;
		}
	}

	return undefined;
}

export function computeStats(
	entries: SessionEntry[],
	options: { contextWindow?: number } = {},
): SessionStats {
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;
	let contextTokens = 0;
	let model = "unknown";
	let thinkingLevel = "";
	let cwd = process.cwd();

	const sessionHeader = entries.find((entry) => entry.type === "session");
	if (sessionHeader?.cwd) {
		cwd = sessionHeader.cwd;
	}

	for (const entry of entries) {
		if (entry.type === "thinking_level_change" && entry.thinkingLevel) {
			thinkingLevel = entry.thinkingLevel;
		}
	}

	type MessageUsage = NonNullable<NonNullable<SessionEntry["message"]>["usage"]>;
	let lastAssistantUsage: MessageUsage | undefined;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
			const usage = entry.message.usage;
			totalInput += usage.input || 0;
			totalOutput += usage.output || 0;
			totalCacheRead += usage.cacheRead || 0;
			totalCacheWrite += usage.cacheWrite || 0;
			totalCost += usage.cost?.total || 0;
			lastAssistantUsage = usage;
			if (entry.message.model) {
				model = entry.message.model;
			}
		}
	}

	if (lastAssistantUsage) {
		contextTokens =
			(lastAssistantUsage.input || 0) +
			(lastAssistantUsage.output || 0) +
			(lastAssistantUsage.cacheRead || 0) +
			(lastAssistantUsage.cacheWrite || 0);
	}

	const contextWindow = options.contextWindow ?? 0;
	const contextPercent = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;

	return {
		totalInput,
		totalOutput,
		totalCacheRead,
		totalCacheWrite,
		totalCost,
		contextTokens,
		contextPercent,
		model,
		thinkingLevel,
		cwd,
	};
}
