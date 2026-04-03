import type { ActionMessage } from "../providers/types.js";

/**
 * Command handling for pion.
 *
 * Commands:
 *   /new     - Start fresh session (clears history)
 *   /compact - Summarize and start new session with summary
 *   /stop    - Abort current processing immediately
 */

export interface CommandMatch {
	command: "new" | "compact" | "stop" | "settings" | "restart";
	args: string;
}

export interface CommandResult {
	handled: boolean;
	/** System message to send back (not from bot persona) */
	response?: string;
}

const KNOWN_COMMANDS = ["new", "compact", "stop", "settings", "restart"] as const;

/**
 * Parse and handle chat commands.
 */
export class Commands {
	/**
	 * Parse a message for commands.
	 * Returns null if not a command.
	 */
	parse(text: string): CommandMatch | null {
		const trimmed = text.trim();
		const nativeButtonCommands: Record<string, CommandMatch["command"]> = {
			"🆕 new session": "new",
			"🧠 compact": "compact",
			"⏹ stop": "stop",
			"↻ restart": "restart",
		};
		const nativeButtonCommand = nativeButtonCommands[trimmed];
		if (nativeButtonCommand) {
			return {
				command: nativeButtonCommand,
				args: "",
			};
		}

		// Must start with /
		if (!trimmed.startsWith("/")) {
			return null;
		}

		// Extract command and args
		const match = trimmed.match(/^\/(\w+)(?:\s+(.*))?$/i);
		if (!match) {
			return null;
		}

		const command = match[1]?.toLowerCase();
		const args = match[2]?.trim() ?? "";

		// Check if known command
		if (!KNOWN_COMMANDS.includes(command as (typeof KNOWN_COMMANDS)[number])) {
			return null;
		}

		return {
			command: command as CommandMatch["command"],
			args,
		};
	}

	fromAction(action: ActionMessage): CommandMatch | null {
		if (!KNOWN_COMMANDS.includes(action.actionId as (typeof KNOWN_COMMANDS)[number])) {
			return null;
		}

		return {
			command: action.actionId as CommandMatch["command"],
			args: "",
		};
	}
}
