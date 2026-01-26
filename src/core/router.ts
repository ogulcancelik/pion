import type { AgentConfig, Config, IsolationMode, Route } from "../config/schema.js";
import type { Message } from "../providers/types.js";

export interface RouteResult {
	agent: AgentConfig | null;
	agentName: string | null;
	isolation: IsolationMode;
	/** Key for context isolation */
	contextKey: string;
}

/**
 * Router matches incoming messages to agent configurations.
 */
export class Router {
	constructor(private config: Config) {}

	/**
	 * Route a message to an agent.
	 * Returns null agent if message should be ignored.
	 */
	route(message: Message): RouteResult {
		for (const rule of this.config.routes) {
			if (this.matches(rule, message)) {
				const agentName = rule.agent;
				const agent = agentName ? (this.config.agents[agentName] ?? null) : null;
				const contextKey = this.buildContextKey(message, rule.isolation);

				return {
					agent,
					agentName,
					isolation: rule.isolation,
					contextKey,
				};
			}
		}

		// No route matched - ignore by default
		return {
			agent: null,
			agentName: null,
			isolation: "per-chat",
			contextKey: this.buildContextKey(message, "per-chat"),
		};
	}

	private matches(rule: Route, message: Message): boolean {
		const match = rule.match;

		if ("type" in match) {
			if (match.type === "dm" && !message.isGroup) return true;
			if (match.type === "group" && message.isGroup) return true;
			return false;
		}

		if ("contact" in match) {
			return message.senderId === match.contact;
		}

		if ("group" in match) {
			// Match by group name or chat ID
			return message.chatId.includes(match.group);
		}

		if ("chatId" in match) {
			return message.chatId === match.chatId;
		}

		return false;
	}

	private buildContextKey(message: Message, isolation: IsolationMode): string {
		const prefix = message.provider;

		switch (isolation) {
			case "per-chat":
				return `${prefix}:chat:${message.chatId}`;
			case "per-contact":
				return `${prefix}:contact:${message.senderId}`;
			default:
				return `${prefix}:chat:${message.chatId}`;
		}
	}
}
