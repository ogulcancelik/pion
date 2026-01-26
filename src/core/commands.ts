/**
 * Command handling for pion.
 *
 * Commands:
 *   /new     - Start fresh session (clears history)
 *   /compact - Summarize and start new session with summary
 *   /stop    - Abort current processing immediately
 */

export interface CommandMatch {
	command: "new" | "compact" | "stop";
	args: string;
}

export interface CommandResult {
	handled: boolean;
	/** System message to send back (not from bot persona) */
	response?: string;
}

const KNOWN_COMMANDS = ["new", "compact", "stop"] as const;

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
}
