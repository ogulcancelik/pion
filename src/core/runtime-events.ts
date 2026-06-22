import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Message, ProviderType } from "../providers/types.js";

export type PiRuntimeEvent = {
	id: string;
	timestamp: string;
	source: "pi";
	contextKey: string;
	sessionFile: string;
	type: AgentSessionEvent["type"];
	event: AgentSessionEvent;
};

export type PionRuntimeEvent =
	| {
			id: string;
			timestamp: string;
			source: "pion";
			contextKey: string;
			type: "runtime_message_received";
			provider: ProviderType;
			chatId: string;
			messageId: string;
			senderId: string;
			isGroup: boolean;
			text: string;
			mediaCount: number;
	  }
	| {
			id: string;
			timestamp: string;
			source: "pion";
			contextKey: string;
			type: "runtime_message_buffered";
			messageCount: number;
	  }
	| {
			id: string;
			timestamp: string;
			source: "pion";
			contextKey: string;
			type: "runtime_compaction_start";
			provider: ProviderType;
			chatId: string;
			trigger: "manual" | "automatic";
	  }
	| {
			id: string;
			timestamp: string;
			source: "pion";
			contextKey: string;
			type: "runtime_messages_merged";
			messageCount: number;
			messageIds: string[];
	  }
	| {
			id: string;
			timestamp: string;
			source: "pion";
			contextKey: string;
			type: "runtime_processing_start";
			agentName: string;
			provider: ProviderType;
			chatId: string;
			messageId: string;
	  }
	| {
			id: string;
			timestamp: string;
			source: "pion";
			contextKey: string;
			type: "runtime_superseded";
			reason: "new_message" | "stop" | "new" | "compact" | "restart";
	  }
	| {
			id: string;
			timestamp: string;
			source: "pion";
			contextKey: string;
			type: "runtime_warning_emitted";
			warning: string;
	  }
	| {
			id: string;
			timestamp: string;
			source: "pion";
			contextKey: string;
			type: "runtime_output_sent";
			provider: ProviderType;
			chatId: string;
			replyTo?: string;
			text: string;
	  }
	| {
			id: string;
			timestamp: string;
			source: "pion";
			contextKey: string;
			type: "runtime_processing_complete";
			outcome: "completed" | "superseded" | "failed";
			messagesSent: number;
			responseLength: number;
			errorMessage?: string;
	  };

export type RuntimeEvent = PiRuntimeEvent | PionRuntimeEvent;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type PiRuntimeEventInput = Omit<PiRuntimeEvent, "id" | "timestamp"> & { timestamp?: string };
export type PionRuntimeEventInput = DistributiveOmit<PionRuntimeEvent, "id" | "timestamp"> & {
	timestamp?: string;
};
export type RuntimeEventInput = PiRuntimeEventInput | PionRuntimeEventInput;
export type RuntimeEventListener = (event: RuntimeEvent) => void;

export function sanitizeContextKey(contextKey: string): string {
	return contextKey.replace(/[:/\\]/g, "-");
}

export function createPiRuntimeEvent(
	contextKey: string,
	sessionFile: string,
	event: AgentSessionEvent,
): PiRuntimeEventInput {
	return {
		source: "pi",
		contextKey,
		sessionFile,
		type: event.type,
		event,
	};
}

export function createMessageReceivedRuntimeEvent(
	contextKey: string,
	message: Message,
): PionRuntimeEventInput {
	return {
		source: "pion",
		contextKey,
		type: "runtime_message_received",
		provider: message.provider,
		chatId: message.chatId,
		messageId: message.id,
		senderId: message.senderId,
		isGroup: message.isGroup,
		text: message.text,
		mediaCount: message.media?.length ?? 0,
	};
}

export class RuntimeEventBus {
	private listeners = new Set<RuntimeEventListener>();
	private runtimeEventsDir: string;
	private writeBuffers = new Map<string, string[]>();
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly flushIntervalMs = 250;

	constructor(dataDir: string) {
		this.runtimeEventsDir = join(dataDir, "runtime-events");
		mkdirSync(this.runtimeEventsDir, { recursive: true });
	}

	subscribe(listener: RuntimeEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	emit(event: RuntimeEventInput): RuntimeEvent {
		const stampedEvent = {
			...event,
			id: randomUUID(),
			timestamp: event.timestamp ?? new Date().toISOString(),
		} as RuntimeEvent;

		const line = `${JSON.stringify(stampedEvent)}\n`;
		const fileKey = stampedEvent.contextKey;
		let buffer = this.writeBuffers.get(fileKey);
		if (!buffer) {
			buffer = [];
			this.writeBuffers.set(fileKey, buffer);
		}
		buffer.push(line);

		this.scheduleFlush();

		for (const listener of this.listeners) {
			listener(stampedEvent);
		}

		return stampedEvent;
	}

	private scheduleFlush(): void {
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			this.flushAll();
		}, this.flushIntervalMs);
	}

	private flushAll(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}

		for (const [contextKey, lines] of this.writeBuffers) {
			if (lines.length === 0) {
				this.writeBuffers.delete(contextKey);
				continue;
			}
			const filePath = this.getEventLogFile(contextKey);
			try {
				appendFileSync(filePath, lines.join(""));
			} catch (err) {
				console.error(`[runtime-events] Failed to flush events for ${contextKey}:`, err);
			}
			this.writeBuffers.delete(contextKey);
		}
	}

	/** Flush remaining buffered events synchronously. Public for tests and shutdown. */
	flush(): void {
		this.flushAll();
	}

	/** Lifecycle hook — flush remaining buffered events synchronously on shutdown. */
	close(): void {
		this.flush();
	}

	getEventLogFile(contextKey: string): string {
		return join(this.runtimeEventsDir, `${sanitizeContextKey(contextKey)}.jsonl`);
	}
}
