import type { SupportedAuthProvider } from "./auth.js";

export function buildProviderSelectionPrompt(providers: SupportedAuthProvider[]): string {
	const lines = ["Choose auth provider:", ""];
	for (const [index, provider] of providers.entries()) {
		lines.push(`${index + 1}. ${provider.id} — ${provider.label}`);
	}
	lines.push("", "Enter number or provider id: ");
	return lines.join("\n");
}

export function resolveProviderSelection(
	providers: SupportedAuthProvider[],
	selection: string,
): SupportedAuthProvider | undefined {
	const trimmed = selection.trim();
	if (!trimmed) {
		return undefined;
	}

	const numericIndex = Number.parseInt(trimmed, 10);
	if (Number.isInteger(numericIndex) && String(numericIndex) === trimmed) {
		return providers[numericIndex - 1];
	}

	const normalized = trimmed.toLowerCase();
	const normalizedAlias = normalized === "openai" ? "openai-codex" : normalized;
	return providers.find((provider) => provider.id.toLowerCase() === normalizedAlias);
}

export async function chooseLoginProvider(params: {
	requestedProvider?: string;
	providers: SupportedAuthProvider[];
	prompt: (question: string) => Promise<string>;
}): Promise<string> {
	if (params.requestedProvider) {
		return params.requestedProvider;
	}

	if (params.providers.length === 0) {
		throw new Error("No supported auth providers available.");
	}

	const question = buildProviderSelectionPrompt(params.providers);
	while (true) {
		const answer = await params.prompt(question);
		const provider = resolveProviderSelection(params.providers, answer);
		if (provider) {
			return provider.id;
		}
		console.log("Invalid selection. Enter a provider number or id.");
	}
}
