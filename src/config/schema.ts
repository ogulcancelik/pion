/**
 * Configuration schema for Pion.
 */

export interface Config {
	/** Base data directory (default: ~/.pion) */
	dataDir?: string;
	/** Directory containing skills (default: ~/.pion/skills) */
	skillsDir?: string;
	/** Auth storage path (default: ~/.pion/auth.json, same multi-provider schema as pi auth.json) */
	authPath?: string;
	/** Optional global model override for session_query recall lookups. Defaults to the active session model. */
	recallQueryModel?: string;
	/** Message debounce window in milliseconds (default: 3000).
	 *  Batches rapid-fire messages into a single prompt.
	 *  Set to 0 to disable debouncing. */
	debounceMs?: number;
	/** Default timeout for bash tool calls in seconds (default: 300). */
	bashTimeoutSec?: number;
	/** Optional dotenv-style env file loaded into tool subprocesses like bash. */
	toolEnvFile?: string;
	/** Repo update awareness and manual /checkupdate behavior. Enabled by default. */
	updateCheck?: UpdateCheckConfig;
	telegram?: TelegramConfig;
	cron?: CronConfig;
	agents: Record<string, AgentConfig>;
	routes: Route[];
}

export interface UpdateCheckConfig {
	/** Enable repo update awareness and /checkupdate (default: true). */
	enabled?: boolean;
	/** Repo checkout to inspect (default: the Pion repo containing the daemon sources). */
	repoPath?: string;
}

export interface CronConfig {
	/** Default execution profile for scheduled agent jobs. */
	agent?: AgentConfig;
}

export type TelegramStatusMode = "clear" | "keep" | "off";

export interface TelegramConfig {
	botToken: string;
	/** Chat ID to notify on startup (optional) */
	startupNotify?: string;
	/** Telegram live-status behavior */
	status?: {
		/** Live-status mode. clear = show while running then remove, keep = leave final bubbles in chat, off = disable status messages. */
		mode?: TelegramStatusMode;
		/** Deprecated compatibility flag. true = clear, false = keep. */
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

	if (cfg.bashTimeoutSec !== undefined) {
		if (typeof cfg.bashTimeoutSec !== "number" || !Number.isFinite(cfg.bashTimeoutSec as number)) {
			errors.push("bashTimeoutSec must be a finite number");
		} else if ((cfg.bashTimeoutSec as number) <= 0) {
			errors.push("bashTimeoutSec must be greater than 0");
		}
	}

	if (cfg.toolEnvFile !== undefined && typeof cfg.toolEnvFile !== "string") {
		errors.push("toolEnvFile must be a string");
	}

	if (cfg.updateCheck !== undefined) {
		if (typeof cfg.updateCheck !== "object" || cfg.updateCheck === null) {
			errors.push("updateCheck must be an object");
		} else {
			const updateCheck = cfg.updateCheck as Record<string, unknown>;
			if (updateCheck.enabled !== undefined && typeof updateCheck.enabled !== "boolean") {
				errors.push("updateCheck.enabled must be a boolean");
			}
			if (updateCheck.repoPath !== undefined && typeof updateCheck.repoPath !== "string") {
				errors.push("updateCheck.repoPath must be a string");
			}
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
					if (
						status.mode !== undefined &&
						status.mode !== "clear" &&
						status.mode !== "keep" &&
						status.mode !== "off"
					) {
						errors.push("telegram.status.mode must be one of: clear, keep, off");
					}
					if (status.clearOnComplete !== undefined && typeof status.clearOnComplete !== "boolean") {
						errors.push("telegram.status.clearOnComplete must be a boolean");
					}
				}
			}
		}
	}

	if (cfg.cron !== undefined) {
		if (typeof cfg.cron !== "object" || cfg.cron === null) {
			errors.push("cron must be an object");
		} else {
			const cron = cfg.cron as Record<string, unknown>;
			if (cron.agent !== undefined) {
				if (typeof cron.agent !== "object" || cron.agent === null) {
					errors.push("cron.agent must be an object");
				} else {
					const agent = cron.agent as Record<string, unknown>;
					if (typeof agent.model !== "string") {
						errors.push("cron.agent.model must be a string");
					}
					if (typeof agent.workspace !== "string") {
						errors.push("cron.agent.workspace must be a string");
					}
					if (agent.cwd !== undefined && typeof agent.cwd !== "string") {
						errors.push("cron.agent.cwd must be a string");
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
