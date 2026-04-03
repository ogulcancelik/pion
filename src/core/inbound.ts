import { mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { MaterializedAttachment, MaterializedMessage, Message } from "../providers/types.js";

export type SavedMediaAttachment = MaterializedAttachment;

export interface PreparedInboundMessage {
	message: MaterializedMessage;
	promptText: string;
}

const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MEDIA_FILE_EXTENSIONS: Record<string, string> = {
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/gif": ".gif",
	"image/webp": ".webp",
};

function sanitizeFilePart(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function extensionForMedia(mimeType?: string, fileName?: string): string {
	const normalizedMimeType = mimeType?.toLowerCase();
	if (normalizedMimeType && MEDIA_FILE_EXTENSIONS[normalizedMimeType]) {
		return MEDIA_FILE_EXTENSIONS[normalizedMimeType];
	}
	const fileExtension = fileName ? extname(fileName) : "";
	if (fileExtension) {
		return fileExtension.toLowerCase();
	}
	return ".bin";
}

export function resolveFetchedImageMimeType(
	currentMimeType?: string,
	responseContentType?: string | null,
): string {
	const normalizedResponseMimeType = responseContentType?.split(";")[0]?.trim().toLowerCase();
	if (normalizedResponseMimeType && SUPPORTED_IMAGE_MIME_TYPES.has(normalizedResponseMimeType)) {
		return normalizedResponseMimeType;
	}
	return currentMimeType || "image/jpeg";
}

export async function materializeMediaAttachments(
	message: Message,
	mediaDir: string,
): Promise<SavedMediaAttachment[]> {
	if (!message.media || message.media.length === 0) {
		return [];
	}

	mkdirSync(mediaDir, { recursive: true });
	const savedAttachments: SavedMediaAttachment[] = [];

	for (const [index, media] of message.media.entries()) {
		try {
			let buffer: Buffer | null = null;
			const sourceMimeType = media.mimeType;
			let mimeType = sourceMimeType;

			if (media.buffer) {
				buffer = media.buffer;
			} else if (media.url) {
				const response = await fetch(media.url);
				if (!response.ok) {
					console.warn(`[runner] Failed to fetch media: ${response.status}`);
					continue;
				}
				buffer = Buffer.from(await response.arrayBuffer());
				if (media.type === "image") {
					mimeType = resolveFetchedImageMimeType(mimeType, response.headers.get("content-type"));
				} else {
					mimeType = response.headers.get("content-type")?.split(";")[0] || mimeType;
				}
			} else {
				continue;
			}

			const extension = extensionForMedia(mimeType, media.fileName);
			const rawBaseName = media.fileName
				? media.fileName.slice(0, media.fileName.length - extname(media.fileName).length)
				: `${message.timestamp.toISOString()}-${message.id}-${index + 1}`;
			const baseName = sanitizeFilePart(rawBaseName);
			const filePath = join(mediaDir, `${baseName}${extension}`);
			writeFileSync(filePath, buffer);
			savedAttachments.push({
				kind: media.type,
				path: filePath,
				mimeType,
				sourceMimeType,
				originalFileName: media.fileName,
				byteSize: buffer.length,
				source: {
					provider: message.provider,
					url: media.url,
				},
			});
		} catch (err) {
			console.warn("[runner] Failed to store media:", err instanceof Error ? err.message : err);
		}
	}

	return savedAttachments;
}

export async function materializeInboundMessage(
	message: Message,
	mediaDir: string,
): Promise<MaterializedMessage> {
	return {
		...message,
		attachments: await materializeMediaAttachments(message, mediaDir),
	};
}

export function buildPromptTextWithMediaPaths(
	messageText: string,
	attachments: SavedMediaAttachment[],
): string {
	if (attachments.length === 0) {
		return messageText;
	}

	const trimmedText = messageText.trim();
	const parts: string[] = [];
	if (trimmedText) {
		parts.push(messageText);
	}
	parts.push(
		attachments.map((attachment) => `[User attached ${attachment.kind}: ${attachment.path}]`).join("\n"),
	);
	return parts.join("\n\n");
}

export async function prepareInboundMessage(
	message: Message,
	mediaDir: string,
): Promise<PreparedInboundMessage> {
	const materializedMessage = await materializeInboundMessage(message, mediaDir);
	return {
		message: materializedMessage,
		promptText: buildPromptTextWithMediaPaths(
			materializedMessage.text,
			materializedMessage.attachments,
		),
	};
}
