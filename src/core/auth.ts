import { join } from "node:path";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import type { Config } from "../config/schema.js";
import { expandTilde, homeDir } from "./paths.js";

export type AuthProviderMethod = "oauth" | "api_key";

export interface SupportedAuthProvider {
	id: string;
	label: string;
	method: AuthProviderMethod;
	envVar?: string;
}

export interface ConfiguredAuthProviderSummary {
	id: string;
	configured: true;
	credentialType: AuthProviderMethod;
}

type OAuthProviderSource = {
	getOAuthProviders(): Array<{ id: string }>;
};

type AuthStorageLike = {
	get(provider: string): { type: AuthProviderMethod } | undefined;
	list(): string[];
	set(provider: string, credential: { type: "api_key"; key: string }): void;
};

const API_KEY_AUTH_PROVIDERS: SupportedAuthProvider[] = [
	{
		id: "minimax",
		label: "MiniMax",
		method: "api_key",
		envVar: "MINIMAX_API_KEY",
	},
];

const AUTH_PROVIDER_LABELS: Record<string, string> = {
	anthropic: "Anthropic (Claude Pro/Max)",
	"openai-codex": "OpenAI Codex (ChatGPT Plus/Pro)",
	minimax: "MiniMax",
};

const AUTH_PROVIDER_ORDER = ["anthropic", "openai-codex", "minimax"];

function titleCaseProviderId(id: string): string {
	return id
		.split(/[-_]/g)
		.filter(Boolean)
		.map((part) => part[0]?.toUpperCase() + part.slice(1))
		.join(" ");
}

function compareProviderIds(left: string, right: string): number {
	const leftIndex = AUTH_PROVIDER_ORDER.indexOf(left);
	const rightIndex = AUTH_PROVIDER_ORDER.indexOf(right);
	if (leftIndex >= 0 || rightIndex >= 0) {
		if (leftIndex < 0) return 1;
		if (rightIndex < 0) return -1;
		return leftIndex - rightIndex;
	}
	return left.localeCompare(right);
}

function getDefaultOAuthProviderSource(): OAuthProviderSource {
	return AuthStorage.inMemory();
}

/**
 * Default auth path for pion.
 * Kept separate from pi, but uses the same auth.json schema for compatibility.
 */
export function getDefaultAuthPath(): string {
	return join(homeDir(), ".pion", "auth.json");
}

/**
 * Resolve the auth path from config or fall back to pion's default.
 */
export function getAuthPath(config?: Pick<Config, "authPath">): string {
	return expandTilde(config?.authPath ?? getDefaultAuthPath());
}

export function getSupportedAuthProviders(
	oauthProviderSource: OAuthProviderSource = getDefaultOAuthProviderSource(),
): SupportedAuthProvider[] {
	const providers = new Map<string, SupportedAuthProvider>();

	for (const provider of oauthProviderSource.getOAuthProviders()) {
		providers.set(provider.id, {
			id: provider.id,
			label: AUTH_PROVIDER_LABELS[provider.id] ?? titleCaseProviderId(provider.id),
			method: "oauth",
		});
	}

	for (const provider of API_KEY_AUTH_PROVIDERS) {
		providers.set(provider.id, provider);
	}

	return Array.from(providers.values()).sort((left, right) =>
		compareProviderIds(left.id, right.id),
	);
}

export function getSupportedAuthProvider(
	providerId: string,
	oauthProviderSource?: OAuthProviderSource,
): SupportedAuthProvider | undefined {
	return getSupportedAuthProviders(oauthProviderSource).find(
		(provider) => provider.id === providerId,
	);
}

export function getConfiguredAuthProviderSummaries(
	authStorage: Pick<AuthStorageLike, "get" | "list">,
): ConfiguredAuthProviderSummary[] {
	return authStorage
		.list()
		.sort(compareProviderIds)
		.flatMap((providerId) => {
			const credential = authStorage.get(providerId);
			if (!credential) {
				return [];
			}
			return [{ id: providerId, configured: true as const, credentialType: credential.type }];
		});
}

export function setApiKeyCredential(
	authStorage: Pick<AuthStorageLike, "set">,
	providerId: string,
	apiKey: string,
): void {
	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new Error(`Missing API key for provider: ${providerId}`);
	}
	if (getSupportedAuthProvider(providerId)?.method !== "api_key") {
		throw new Error(`Provider does not use API key login: ${providerId}`);
	}
	authStorage.set(providerId, { type: "api_key", key: trimmed });
}
