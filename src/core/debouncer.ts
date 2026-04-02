/**
 * Message debouncer for batching rapid-fire messages.
 *
 * When users send multiple messages in quick succession (common in chat),
 * the debouncer collects them into a single batch before processing.
 * This avoids partial processing and provides a better experience.
 *
 * Each context key (chat/contact) has its own independent buffer and timer.
 */

import type { Message } from "../providers/types.js";

export interface DebouncerConfig {
	/** Debounce window in milliseconds (default: 3000) */
	timeoutMs: number;
	/** Called when the debounce window closes with all buffered messages */
	onFlush: (contextKey: string, messages: Message[]) => void | Promise<void>;
}

export class MessageDebouncer {
	private buffers = new Map<string, Message[]>();
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private config: DebouncerConfig;

	constructor(config: DebouncerConfig) {
		this.config = config;
	}

	/**
	 * Add a message to the buffer. Resets the debounce timer for this context.
	 */
	add(contextKey: string, message: Message): void {
		let buffer = this.buffers.get(contextKey);
		if (!buffer) {
			buffer = [];
			this.buffers.set(contextKey, buffer);
		}
		buffer.push(message);

		// Reset timer
		const existing = this.timers.get(contextKey);
		if (existing) clearTimeout(existing);

		const timer = setTimeout(() => {
			this.doFlush(contextKey);
		}, this.config.timeoutMs);
		this.timers.set(contextKey, timer);
	}

	/**
	 * Cancel pending buffer for a context. Returns cancelled messages.
	 * Use for /stop — cancels buffered messages without processing them.
	 */
	cancel(contextKey: string): Message[] {
		const timer = this.timers.get(contextKey);
		if (timer) clearTimeout(timer);
		this.timers.delete(contextKey);

		const messages = this.buffers.get(contextKey) || [];
		this.buffers.delete(contextKey);
		return messages;
	}

	/**
	 * Flush immediately without waiting for timeout.
	 * Use when we need to force processing (e.g., shutdown).
	 */
	flush(contextKey: string): void {
		this.doFlush(contextKey);
	}

	/**
	 * Check if there are buffered messages for a context.
	 */
	hasPending(contextKey: string): boolean {
		const buffer = this.buffers.get(contextKey);
		return !!buffer && buffer.length > 0;
	}

	getPendingCount(contextKey: string): number {
		return this.buffers.get(contextKey)?.length ?? 0;
	}

	/**
	 * Clear all buffers and timers. Call on shutdown.
	 */
	dispose(): void {
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.timers.clear();
		this.buffers.clear();
	}

	private doFlush(contextKey: string): void {
		const timer = this.timers.get(contextKey);
		if (timer) clearTimeout(timer);
		this.timers.delete(contextKey);

		const messages = this.buffers.get(contextKey);
		this.buffers.delete(contextKey);

		if (messages && messages.length > 0) {
			this.config.onFlush(contextKey, messages);
		}
	}
}

/**
 * Merge multiple messages into a single message for processing.
 *
 * - Text: joined with newlines
 * - Identity (id, chatId, senderId): from first message
 * - Timestamp: from last message
 * - Media: collected from all messages
 */
export function mergeMessages(messages: Message[]): Message {
	if (messages.length === 0) {
		throw new Error("Cannot merge empty message array");
	}

	if (messages.length === 1) {
		return messages[0]!;
	}

	const first = messages[0]!;
	const last = messages[messages.length - 1]!;

	return {
		...first,
		text: messages.map((m) => m.text).join("\n"),
		timestamp: last.timestamp,
		media: messages.flatMap((m) => m.media || []),
	};
}
