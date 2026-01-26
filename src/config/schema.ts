/**
 * Configuration schema for Pion.
 */

export interface Config {
	/** Base data directory (default: ~/.pion) */
	dataDir?: string;
	/** Directory containing skills (default: ~/.pion/skills) */
	skillsDir?: string;
	telegram?: TelegramConfig;
	whatsapp?: WhatsAppConfig;
	agents: Record<string, AgentConfig>;
	routes: Route[];
}

export interface TelegramConfig {
	botToken: string;
	/** Chat ID to notify on startup (optional) */
	startupNotify?: string;
}

export interface WhatsAppConfig {
	/** Directory to store auth session */
	sessionDir?: string;
	/** Allowed phone numbers for DMs (e.g., ["+1234567890"]) */
	allowDMs?: string[];
	/** Allowed group JIDs (e.g., ["120363403098358590@g.us"]) */
	allowGroups?: string[];
}

export interface AgentConfig {
	model: string;
	/** Path to agent workspace containing SOUL.md, IDENTITY.md, etc. */
	workspace: string;
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
