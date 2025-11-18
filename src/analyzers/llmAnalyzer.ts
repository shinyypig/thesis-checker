import * as vscode from 'vscode';
import { AnalyzerDiagnostic, DocumentElement } from '../types';

interface LLMSettings {
	enabled?: boolean;
	provider?: 'openai' | 'ollama';
	openaiModel?: string;
	openaiApiKey?: string;
	openaiBaseUrl?: string;
	ollamaEndpoint?: string;
	ollamaModel?: string;
	maxItems?: number;
}

interface LLMIssue {
	message: string;
	severity?: string;
}

interface LLMReview {
	issues: LLMIssue[];
}

interface LLMProvider {
	readonly id: string;
	isConfigured(): boolean;
	review(element: DocumentElement): Promise<LLMReview | undefined>;
}

export class LLMAnalyzer {
	private readonly configuration = vscode.workspace.getConfiguration('thesisChecker');
	private readonly output: vscode.OutputChannel;

	constructor(channel?: vscode.OutputChannel) {
		this.output = channel ?? vscode.window.createOutputChannel('Thesis Checker');
	}

	public async analyze(elements: DocumentElement[]): Promise<AnalyzerDiagnostic[]> {
		const settings = this.configuration.get<LLMSettings>('llm');
		if (!settings?.enabled) {
			return [];
		}

		const provider = this.createProvider(settings);
		if (!provider || !provider.isConfigured()) {
			this.output.appendLine('LLM provider not configured. Skipping LLM analysis.');
			return [];
		}

		const maxItems = settings.maxItems ?? 20;
		const candidates = elements.filter((element) => element.type === 'sentence' || element.type === 'equation');
		const targets = candidates.slice(0, maxItems);

		const diagnostics: AnalyzerDiagnostic[] = [];
		for (const element of targets) {
			const review = await provider.review(element);
			if (!review) {
				continue;
			}
			for (const issue of review.issues) {
				const severity = this.mapSeverity(issue.severity);
				const diagnostic = new vscode.Diagnostic(element.range, `[LLM] ${issue.message}`, severity);
				diagnostic.source = `LLM:${provider.id}`;
				diagnostics.push({ uri: vscode.Uri.file(element.filePath), diagnostic });
			}
		}

		return diagnostics;
	}

	private createProvider(settings: LLMSettings): LLMProvider | undefined {
		switch (settings.provider) {
			case 'ollama':
				return new OllamaProvider(settings, this.output);
			case 'openai':
			default:
				return new OpenAIProvider(settings, this.output);
		}
	}

	private mapSeverity(label?: string): vscode.DiagnosticSeverity {
		switch (label?.toLowerCase()) {
			case 'error':
				return vscode.DiagnosticSeverity.Error;
			case 'warning':
				return vscode.DiagnosticSeverity.Warning;
			case 'information':
			case 'info':
				return vscode.DiagnosticSeverity.Information;
			default:
				return vscode.DiagnosticSeverity.Information;
		}
	}
}

class OpenAIProvider implements LLMProvider {
	public readonly id = 'openai';

	constructor(private readonly settings: LLMSettings, private readonly output: vscode.OutputChannel) {}

	public isConfigured(): boolean {
		return Boolean(this.settings.openaiApiKey);
	}

	public async review(element: DocumentElement): Promise<LLMReview | undefined> {
		const url = this.settings.openaiBaseUrl?.trim() || 'https://api.openai.com/v1/chat/completions';
		const apiKey = this.settings.openaiApiKey?.trim();
		if (!apiKey) {
			return undefined;
		}

		const payload = {
			model: this.settings.openaiModel || 'gpt-3.5-turbo',
			temperature: 0.2,
			messages: [
				{
					role: 'system',
					content:
						'You review LaTeX thesis fragments. Respond ONLY with JSON: {"issues":[{"message":"","severity":"warning"}]} where severity is one of error|warning|info. Keep messages concise.'
				},
				{
					role: 'user',
					content: `Element type: ${element.type}\nLaTeX fragment:\n${element.content}`
				}
			]
		};

		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${apiKey}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(payload)
			});

			if (!response.ok) {
				const details = await response.text();
				this.output.appendLine(`OpenAI API error (${response.status}): ${details}`);
				return undefined;
			}

			const data = await response.json();
			const content: string | undefined = data.choices?.[0]?.message?.content;
			return this.safeParse(content);
		} catch (error) {
			this.output.appendLine(`OpenAI request failed: ${String(error)}`);
			return undefined;
		}
	}

	private safeParse(value?: string): LLMReview | undefined {
		if (!value) {
			return undefined;
		}
		try {
			const parsed = JSON.parse(value) as LLMReview;
			if (Array.isArray(parsed.issues)) {
				return parsed;
			}
			return { issues: [] };
		} catch {
			return { issues: [{ message: value.trim(), severity: 'info' }] };
		}
	}
}

class OllamaProvider implements LLMProvider {
	public readonly id = 'ollama';

	constructor(private readonly settings: LLMSettings, private readonly output: vscode.OutputChannel) {}

	public isConfigured(): boolean {
		return Boolean(this.settings.ollamaEndpoint);
	}

	public async review(element: DocumentElement): Promise<LLMReview | undefined> {
		const endpoint = (this.settings.ollamaEndpoint || 'http://localhost:11434').replace(/\/$/, '');
		const model = this.settings.ollamaModel || 'llama3';
		const payload = {
			model,
			prompt: this.buildPrompt(element),
			stream: false
		};

		try {
			const response = await fetch(`${endpoint}/api/generate`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (!response.ok) {
				const text = await response.text();
				this.output.appendLine(`Ollama API error (${response.status}): ${text}`);
				return undefined;
			}
			const data = await response.json();
			return this.safeParse(data.response);
		} catch (error) {
			this.output.appendLine(`Ollama request failed: ${String(error)}`);
			return undefined;
		}
	}

	private buildPrompt(element: DocumentElement): string {
		return `You are reviewing LaTeX thesis content. Respond ONLY with JSON matching {"issues":[{"message":"","severity":"warning"}]}.
Element type: ${element.type}
Content:
${element.content}`;
	}

	private safeParse(value?: string): LLMReview | undefined {
		if (!value) {
			return undefined;
		}
		try {
			const parsed = JSON.parse(value) as LLMReview;
			if (Array.isArray(parsed.issues)) {
				return parsed;
			}
			return { issues: [] };
		} catch {
			return { issues: [{ message: value.trim(), severity: 'info' }] };
		}
	}
}
