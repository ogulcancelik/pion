import type { Provider } from "./types.js";

export async function sendTypingBestEffort(
	provider: Provider,
	chatId: string,
	onError: (message: string) => void = (message) => console.warn(message),
): Promise<void> {
	if (!provider.sendTyping) {
		return;
	}

	try {
		await provider.sendTyping(chatId);
	} catch (error) {
		onError(
			`[${provider.type}] typing failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
