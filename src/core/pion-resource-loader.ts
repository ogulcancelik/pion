import { createExtensionRuntime } from "@mariozechner/pi-coding-agent";
import type { ResourceLoader } from "@mariozechner/pi-coding-agent";
import type { ResourceDiagnostic } from "@mariozechner/pi-coding-agent";
import type { PromptTemplate } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { LoadExtensionsResult } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "../config/schema.js";
import { type Skill, loadSkills } from "./skills.js";
import { buildSystemPrompt } from "./workspace.js";

const emptyExtensions = (): LoadExtensionsResult => ({
	extensions: [],
	errors: [],
	runtime: createExtensionRuntime(),
});

export class PionResourceLoader implements ResourceLoader {
	private systemPrompt: string | undefined;
	private skills: Skill[] = [];
	private diagnostics: ResourceDiagnostic[] = [];
	private readonly extensions = emptyExtensions();
	private readonly prompts: PromptTemplate[] = [];
	private readonly themes: Theme[] = [];

	constructor(
		private readonly agentConfig: AgentConfig,
		private readonly skillsDir: string,
	) {
		this.reloadSync();
	}

	getExtensions(): LoadExtensionsResult {
		return this.extensions;
	}

	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		return { skills: this.skills, diagnostics: this.diagnostics };
	}

	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		return { prompts: this.prompts, diagnostics: [] };
	}

	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		return { themes: this.themes, diagnostics: [] };
	}

	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } {
		return { agentsFiles: [] };
	}

	getSystemPrompt(): string | undefined {
		return this.systemPrompt;
	}

	getAppendSystemPrompt(): string[] {
		return [];
	}

	extendResources(): void {}

	async reload(): Promise<void> {
		this.reloadSync();
	}

	private reloadSync(): void {
		const prompt = buildSystemPrompt(this.agentConfig);
		this.systemPrompt = prompt.length > 0 ? prompt : undefined;
		const result = loadSkills(this.skillsDir, this.agentConfig.skills ?? []);
		this.skills = result.skills;
		this.diagnostics = result.diagnostics;
	}
}
