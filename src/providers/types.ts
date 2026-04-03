/**
 * Common message interface across all providers.
 * Providers normalize their native messages to this format.
 */
export interface Message {
	id: string;
	chatId: string;
	senderId: string;
	senderName?: string;
	text: string;
	media?: MediaAttachment[];
	isGroup: boolean;
	provider: ProviderType;
	timestamp: Date;
	/** Original provider-specific message object */
	raw: unknown;
}

export interface ActionMessage {
	id: string;
	chatId: string;
	senderId: string;
	senderName?: string;
	provider: ProviderType;
	timestamp: Date;
	isGroup: boolean;
	actionId: string;
	messageId?: string;
	data?: string;
	raw: unknown;
}

export type ProviderType = "telegram";

export interface MediaAttachment {
	type: "image" | "video" | "audio" | "document";
	url?: string;
	buffer?: Buffer;
	mimeType?: string;
	fileName?: string;
}

export interface MaterializedAttachment {
	kind: "image" | "video" | "audio" | "document";
	path: string;
	mimeType?: string;
	sourceMimeType?: string;
	originalFileName?: string;
	byteSize?: number;
	source: {
		provider: ProviderType;
		url?: string;
	};
}

export interface MaterializedMessage extends Omit<Message, "media"> {
	attachments: MaterializedAttachment[];
}

/**
 * Outbound message to send via a provider.
 */
export interface OutboundMessage {
	chatId: string;
	text: string;
	media?: MediaAttachment;
	/** Reply to a specific message */
	replyTo?: string;
}

/**
 * Result of sending a message.
 */
export interface SendResult {
	messageId: string;
	chatId: string;
}

export interface StatusHandle {
	provider: ProviderType;
	chatId: string;
	messageId: string;
}

export interface StatusAction {
	id: string;
	label: string;
}

export interface StatusUpdate {
	chatId: string;
	text: string;
	handle?: StatusHandle;
	actions?: StatusAction[];
}

/**
 * Provider interface - currently implemented by Telegram.
 */
export interface Provider {
	readonly type: ProviderType;

	/** Start the provider (connect, authenticate) */
	start(): Promise<void>;

	/** Stop the provider gracefully */
	stop(): Promise<void>;

	/** Send a message */
	send(message: OutboundMessage): Promise<SendResult>;

	/** Send typing indicator */
	sendTyping?(chatId: string): Promise<void>;

	/** Create or update an editable provider-native status message */
	upsertStatus?(status: StatusUpdate): Promise<StatusHandle>;

	/** Remove a previously created editable status message */
	clearStatus?(handle: StatusHandle): Promise<void>;

	/** Register handler for incoming messages */
	onMessage(handler: (message: Message) => void | Promise<void>): void;

	/** Register handler for incoming button/callback actions */
	onAction?(handler: (action: ActionMessage) => void | Promise<void>): void;

	/** Check if provider is connected */
	isConnected(): boolean;
}
