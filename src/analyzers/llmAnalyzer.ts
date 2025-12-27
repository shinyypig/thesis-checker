import * as vscode from "vscode";
import { AnalyzerDiagnostic, DocumentElement } from "../types";
import {
    buildLlmReviewPrompt,
    buildLlmReviewUserPrompt,
    LLM_REVIEW_SYSTEM_PROMPT,
} from "./llmPrompts";

interface LLMSettings {
    enabled?: boolean;
    provider?: "openai" | "ollama";
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

function normalizeReviewContent(value: string): string {
    const trimmed = value.trim();
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch?.[1]) {
        return fenceMatch[1].trim();
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
        return trimmed.slice(start, end + 1).trim();
    }
    return trimmed;
}

function parseReview(value?: string): LLMReview | undefined {
    if (!value) {
        return undefined;
    }
    const normalized = normalizeReviewContent(value);
    try {
        const parsed = JSON.parse(normalized) as LLMReview;
        if (Array.isArray(parsed.issues)) {
            return parsed;
        }
        return { issues: [] };
    } catch {
        return { issues: [] };
    }
}

function isPunctuationIssue(message: string): boolean {
    return /标点|句号|逗号|分号|冒号|顿号|括号|引号/.test(message);
}

function isLowValueIssue(message: string): boolean {
    const trimmed = message.trim();
    return (
        trimmed.length === 0 ||
        /^(无明显错误|没有明显问题|无明显问题|无问题|没有问题)$/.test(trimmed) ||
        /^(语病导致不通顺|事实性明显错误|明显错别字|错别字|拼写错误)$/.test(trimmed)
    );
}

function isStyleIssue(message: string): boolean {
    return /格式|规范|统一|一致性|命名|大小写|首字母|空格|引用|引文|编号|图表|表格|公式编号|位置不当/.test(
        message
    );
}

function isJsonLikeIssue(message: string): boolean {
    const trimmed = message.trim();
    return (
        trimmed.startsWith("{") && /"issues"\s*:/.test(trimmed)
    );
}

function hasExplicitReplacement(message: string): boolean {
    return /应改为|应为|应写为|改为/.test(message);
}

function extractQuotedFragments(
    message: string
): { before: string; after: string } | undefined {
    const chineseMatches = [...message.matchAll(/“([^”]+)”/g)].map(
        (match) => match[1]
    );
    if (chineseMatches.length >= 2) {
        return { before: chineseMatches[0], after: chineseMatches[1] };
    }
    const asciiMatches = [...message.matchAll(/"([^"]+)"/g)].map(
        (match) => match[1]
    );
    if (asciiMatches.length >= 2) {
        return { before: asciiMatches[0], after: asciiMatches[1] };
    }
    return undefined;
}

function containsLatinOrLatex(value: string): boolean {
    return /[A-Za-z]/.test(value) || /\\/.test(value);
}

function editDistance(a: string, b: string): number {
    const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
        new Array(b.length + 1).fill(0)
    );
    for (let i = 0; i <= a.length; i += 1) {
        dp[i][0] = i;
    }
    for (let j = 0; j <= b.length; j += 1) {
        dp[0][j] = j;
    }
    for (let i = 1; i <= a.length; i += 1) {
        for (let j = 1; j <= b.length; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost
            );
        }
    }
    return dp[a.length][b.length];
}

function isExactDuplication(before: string, after: string): boolean {
    return before === after + after || after === before + before;
}

function isConcreteIssue(message: string): boolean {
    const trimmed = message.trim();
    const weakSignal =
        /建议|可能|不够清晰|不明确|歧义|更通顺|更清晰|更准确|更正式|建议补充|建议说明|建议明确|建议修改为|建议改为|建议将|可能需要/.test(
            trimmed
        );
    if (weakSignal) {
        return false;
    }
    if (!hasExplicitReplacement(trimmed)) {
        return false;
    }
    const fragments = extractQuotedFragments(trimmed);
    if (!fragments) {
        return false;
    }
    if (
        fragments.before.length < 2 ||
        fragments.after.length < 2 ||
        fragments.before.length > 20 ||
        fragments.after.length > 20 ||
        containsLatinOrLatex(fragments.before) ||
        containsLatinOrLatex(fragments.after)
    ) {
        return false;
    }
    const typoSignal = /错别字|拼写错误|笔误|错字/.test(trimmed);
    const insertionDeletion =
        fragments.before.includes(fragments.after) ||
        fragments.after.includes(fragments.before);
    if (!insertionDeletion) {
        const maxLen = Math.max(
            fragments.before.length,
            fragments.after.length
        );
        const distance = editDistance(fragments.before, fragments.after);
        if (
            !typoSignal ||
            fragments.before.length < 3 ||
            fragments.after.length < 3 ||
            maxLen > 6 ||
            distance > 1
        ) {
            return false;
        }
    } else {
        const lengthDiff = Math.abs(
            fragments.before.length - fragments.after.length
        );
        if (lengthDiff > 1 && !isExactDuplication(fragments.before, fragments.after)) {
            return false;
        }
    }
    if (trimmed.length > 140) {
        return false;
    }
    return true;
}

function hasRecognizedSeverity(issue: LLMIssue): boolean {
    const label = issue.severity?.toLowerCase();
    return label === "error" || label === "warning";
}

interface LLMProvider {
    readonly id: string;
    isConfigured(): boolean;
    review(element: DocumentElement): Promise<LLMReview | undefined>;
}

interface LLMAnalysisOptions {
    progress?: vscode.Progress<{ message?: string; increment?: number }>;
    token?: vscode.CancellationToken;
    onDiagnostics?: (items: AnalyzerDiagnostic[], element: DocumentElement) => void;
}

export class LLMAnalyzer {
    private readonly configuration =
        vscode.workspace.getConfiguration("thesisChecker");
    private readonly output: vscode.OutputChannel;

    constructor(channel?: vscode.OutputChannel) {
        this.output =
            channel ?? vscode.window.createOutputChannel("Thesis Checker");
    }

    public async analyze(
        elements: DocumentElement[],
        options?: LLMAnalysisOptions
    ): Promise<AnalyzerDiagnostic[]> {
        const settings = this.configuration.get<LLMSettings>("llm");
        if (!settings?.enabled) {
            return [];
        }

        const provider = this.createProvider(settings);
        if (!provider || !provider.isConfigured()) {
            this.output.appendLine(
                "LLM provider not configured. Skipping LLM analysis."
            );
            return [];
        }

        const targets = elements.filter(
            (element) => element.type === "sentence"
        );

        const diagnostics: AnalyzerDiagnostic[] = [];
        if (targets.length === 0) {
            return diagnostics;
        }

        const progress = options?.progress;
        const token = options?.token;
        const increment = 100 / targets.length;
        let processed = 0;

        for (const element of targets) {
            if (token?.isCancellationRequested) {
                break;
            }
            const review = await provider.review(element);
            processed += 1;
            progress?.report({
                message: `LLM analyzing ${processed}/${targets.length}`,
                increment,
            });
            if (!review) {
                continue;
            }
            const newDiagnostics: AnalyzerDiagnostic[] = [];
            for (const issue of review.issues) {
                if (
                    !issue.message ||
                    !hasRecognizedSeverity(issue) ||
                    isPunctuationIssue(issue.message) ||
                    isLowValueIssue(issue.message) ||
                    isStyleIssue(issue.message) ||
                    isJsonLikeIssue(issue.message) ||
                    !isConcreteIssue(issue.message)
                ) {
                    continue;
                }
                const severity = this.mapSeverity(issue.severity);
                const diagnostic = new vscode.Diagnostic(
                    element.range,
                    `[LLM] ${issue.message}`,
                    severity
                );
                diagnostic.source = `LLM:${provider.id}`;
                const entry = {
                    uri: vscode.Uri.file(element.filePath),
                    diagnostic,
                };
                diagnostics.push(entry);
                newDiagnostics.push(entry);
            }
            if (newDiagnostics.length) {
                options?.onDiagnostics?.(newDiagnostics, element);
            }
        }

        return diagnostics;
    }

    private createProvider(settings: LLMSettings): LLMProvider | undefined {
        switch (settings.provider) {
            case "ollama":
                return new OllamaProvider(settings, this.output);
            case "openai":
            default:
                return new OpenAIProvider(settings, this.output);
        }
    }

    private mapSeverity(label?: string): vscode.DiagnosticSeverity {
        switch (label?.toLowerCase()) {
            case "error":
                return vscode.DiagnosticSeverity.Error;
            case "warning":
                return vscode.DiagnosticSeverity.Warning;
            case "information":
            case "info":
                return vscode.DiagnosticSeverity.Information;
            default:
                return vscode.DiagnosticSeverity.Information;
        }
    }
}

class OpenAIProvider implements LLMProvider {
    public readonly id = "openai";

    constructor(
        private readonly settings: LLMSettings,
        private readonly output: vscode.OutputChannel
    ) {}

    public isConfigured(): boolean {
        return Boolean(this.settings.openaiApiKey);
    }

    public async review(
        element: DocumentElement
    ): Promise<LLMReview | undefined> {
        const url =
            this.settings.openaiBaseUrl?.trim() ||
            "https://api.openai.com/v1/chat/completions";
        const apiKey = this.settings.openaiApiKey?.trim();
        if (!apiKey) {
            return undefined;
        }

        const payload = {
            model: this.settings.openaiModel || "gpt-3.5-turbo",
            temperature: 0,
            top_p: 0.1,
            messages: [
                {
                    role: "system",
                    content: LLM_REVIEW_SYSTEM_PROMPT,
                },
                {
                    role: "user",
                    content: buildLlmReviewUserPrompt(element.content),
                },
            ],
        };

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const details = await response.text();
                this.output.appendLine(
                    `OpenAI API error (${response.status}): ${details}`
                );
                return undefined;
            }

            const data = await response.json();
            const content: string | undefined =
                data.choices?.[0]?.message?.content;
            return parseReview(content);
        } catch (error) {
            this.output.appendLine(`OpenAI request failed: ${String(error)}`);
            return undefined;
        }
    }
}

class OllamaProvider implements LLMProvider {
    public readonly id = "ollama";

    constructor(
        private readonly settings: LLMSettings,
        private readonly output: vscode.OutputChannel
    ) {}

    public isConfigured(): boolean {
        return Boolean(this.settings.ollamaEndpoint);
    }

    public async review(
        element: DocumentElement
    ): Promise<LLMReview | undefined> {
        const endpoint = (
            this.settings.ollamaEndpoint || "http://localhost:11434"
        ).replace(/\/$/, "");
        const model = this.settings.ollamaModel || "llama3";
        const payload = {
            model,
            prompt: this.buildPrompt(element),
            stream: false,
            options: {
                temperature: 0,
                top_p: 0.1,
                top_k: 1,
            },
        };

        try {
            const response = await fetch(`${endpoint}/api/generate`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            if (!response.ok) {
                const text = await response.text();
                this.output.appendLine(
                    `Ollama API error (${response.status}): ${text}`
                );
                return undefined;
            }
            const data = await response.json();
            return parseReview(data.response);
        } catch (error) {
            this.output.appendLine(`Ollama request failed: ${String(error)}`);
            return undefined;
        }
    }

    private buildPrompt(element: DocumentElement): string {
        return buildLlmReviewPrompt(element.content);
    }

}
