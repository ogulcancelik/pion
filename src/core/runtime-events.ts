import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
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
			reason: "new_message" | "stop" | "new" | "compact";
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

		appendFileSync(this.getEventLogFile(stampedEvent.contextKey), `${JSON.stringify(stampedEvent)}\n`);

		for (const listener of this.listeners) {
			listener(stampedEvent);
		}

		return stampedEvent;
	}

	getEventLogFile(contextKey: string): string {
		return join(this.runtimeEventsDir, `${sanitizeContextKey(contextKey)}.jsonl`);
	}
}
