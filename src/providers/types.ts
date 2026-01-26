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

export type ProviderType = "telegram" | "whatsapp";

export interface MediaAttachment {
	type: "image" | "video" | "audio" | "document";
	url?: string;
	buffer?: Buffer;
	mimeType?: string;
	fileName?: string;
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

/**
 * Provider interface - implemented by Telegram, WhatsApp, etc.
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

	/** Register handler for incoming messages */
	onMessage(handler: (message: Message) => void | Promise<void>): void;

	/** Check if provider is connected */
	isConnected(): boolean;
}
