/**
 * Configuration schema for Pion.
 */

export interface Config {
	/** Base data directory (default: ~/.pion) */
	dataDir?: string;
	/** Directory containing skills (default: ~/.pion/skills) */
	skillsDir?: string;
	/** Auth storage path (default: ~/.pion/auth.json, same schema as pi auth.json) */
	authPath?: string;
	/** Optional global model override for session_query recall lookups. Defaults to the active session model. */
	recallQueryModel?: string;
	/** Message debounce window in milliseconds (default: 3000).
	 *  Batches rapid-fire messages into a single prompt.
	 *  Set to 0 to disable debouncing. */
	debounceMs?: number;
	telegram?: TelegramConfig;
	agents: Record<string, AgentConfig>;
	routes: Route[];
}

export interface TelegramConfig {
	botToken: string;
	/** Chat ID to notify on startup (optional) */
	startupNotify?: string;
	/** Telegram live-status behavior */
	status?: {
		/** Clear the live status message when a run completes (default: true) */
		clearOnComplete?: boolean;
	};
}

export interface AgentConfig {
	model: string;
	/** Path to agent workspace containing SOUL.md, IDENTITY.md, etc. */
	workspace: string;
	/** Optional execution cwd override. Defaults to workspace when unset. */
	cwd?: string;
	/** Optional inline system prompt (used if no workspace or as addition) */
	systemPrompt?: string;
	skills?: string[];
}

export interface Route {
	match: RouteMatch;
	/** Agent name from agents config, or null to ignore */
	agent: string | null;
	/** How to isolate conversation context */
	isolation: IsolationMode;
}

export type IsolationMode = "per-chat" | "per-contact";

export type RouteMatch =
	| { type: "dm" }
	| { type: "group" }
	| { contact: string }
	| { group: string }
	| { chatId: string };

/**
 * Validate a config object. Returns errors if invalid.
 */
export function validateConfig(config: unknown): string[] {
	const errors: string[] = [];

	if (!config || typeof config !== "object") {
		return ["Config must be an object"];
	}

	const cfg = config as Record<string, unknown>;

	// Must have agents
	if (!cfg.agents || typeof cfg.agents !== "object") {
		errors.push("Config must have 'agents' object");
	}

	// Must have routes
	if (!Array.isArray(cfg.routes)) {
		errors.push("Config must have 'routes' array");
	}

	if (cfg.recallQueryModel !== undefined && typeof cfg.recallQueryModel !== "string") {
		errors.push("recallQueryModel must be a string");
	}

	// Validate debounceMs if present
	if (cfg.debounceMs !== undefined) {
		if (typeof cfg.debounceMs !== "number" || !Number.isFinite(cfg.debounceMs as number)) {
			errors.push("debounceMs must be a finite number");
		} else if ((cfg.debounceMs as number) < 0) {
			errors.push("debounceMs must be non-negative");
		}
	}

	if (cfg.telegram !== undefined) {
		if (typeof cfg.telegram !== "object" || cfg.telegram === null) {
			errors.push("telegram must be an object");
		} else {
			const telegram = cfg.telegram as Record<string, unknown>;
			if (telegram.status !== undefined) {
				if (typeof telegram.status !== "object" || telegram.status === null) {
					errors.push("telegram.status must be an object");
				} else {
					const status = telegram.status as Record<string, unknown>;
					if (status.clearOnComplete !== undefined && typeof status.clearOnComplete !== "boolean") {
						errors.push("telegram.status.clearOnComplete must be a boolean");
					}
				}
			}
		}
	}

	if (cfg.agents && typeof cfg.agents === "object") {
		for (const [agentName, agentValue] of Object.entries(cfg.agents as Record<string, unknown>)) {
			if (!agentValue || typeof agentValue !== "object") {
				continue;
			}
			const agent = agentValue as Record<string, unknown>;
			if (agent.cwd !== undefined && typeof agent.cwd !== "string") {
				errors.push(`agents.${agentName}.cwd must be a string`);
			}
		}
	}

	// Validate routes reference existing agents
	if (cfg.agents && Array.isArray(cfg.routes)) {
		const agentNames = new Set(Object.keys(cfg.agents as object));
		for (const route of cfg.routes as Route[]) {
			if (route.agent !== null && !agentNames.has(route.agent)) {
				errors.push(`Route references unknown agent: ${route.agent}`);
			}
		}
	}

	return errors;
}
