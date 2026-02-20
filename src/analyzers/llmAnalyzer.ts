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
}

interface LLMIssue {
    message: string;
    severity?: string;
}

interface LLMReview {
    issues: LLMIssue[];
    rewrite?: string;
}

interface LLMReviewResult {
    review: LLMReview | undefined;
    prompt: string | { system: string; user: string };
    raw?: string;
}

const FUNCTION_WORDS = new Set([
    "即",
    "将",
    "的",
    "地",
    "得",
    "了",
    "在",
    "对",
    "与",
    "和",
    "及",
]);

function normalizeReviewContent(value: string): string {
    const trimmed = value.trim();
    const fenceMatch = trimmed.match(/```(?:[A-Za-z0-9_-]+)?\s*([\s\S]*?)```/i);
    if (fenceMatch?.[1]) {
        return fenceMatch[1].trim();
    }
    return trimmed;
}

function normalizeReviewKey(raw: string): string {
    return raw
        .trim()
        .toLowerCase()
        .replace(/[^\w]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

function normalizeSeverityLabel(value?: string): string | undefined {
    if (!value) {
        return undefined;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === "error" || normalized === "warning") {
        return normalized;
    }
    if (/error|err|严重|错误/.test(normalized)) {
        return "error";
    }
    if (/warning|warn|轻微|警告/.test(normalized)) {
        return "warning";
    }
    return undefined;
}

function stripWrappingQuotes(value?: string): string {
    if (!value) {
        return "";
    }
    const trimmed = value.trim();
    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
        (trimmed.startsWith("“") && trimmed.endsWith("”"))
    ) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}

function parseInteger(value?: string): number | undefined {
    if (!value) {
        return undefined;
    }
    const match = value.match(/-?\d+/);
    if (!match) {
        return undefined;
    }
    const parsed = Number.parseInt(match[0], 10);
    return Number.isNaN(parsed) ? undefined : parsed;
}

function parseKeyValueLines(value: string): Map<string, string> {
    const pairs = new Map<string, string>();
    const lines = value.split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine
            .replace(/^[\s]*(?:[-*•]+|\d+[.)、])\s*/, "")
            .replace(/＝/g, "=")
            .trim();
        if (!line) {
            continue;
        }
        const delimiterIndex = line.indexOf("=");
        if (delimiterIndex <= 0) {
            continue;
        }
        const key = normalizeReviewKey(line.slice(0, delimiterIndex));
        if (!key) {
            continue;
        }
        const valuePart = line.slice(delimiterIndex + 1);
        pairs.set(key, stripWrappingQuotes(valuePart));
    }
    return pairs;
}

function getFirstMatch(
    pairs: Map<string, string>,
    aliases: string[]
): string | undefined {
    for (const alias of aliases) {
        const value = pairs.get(alias);
        if (value !== undefined) {
            return value;
        }
    }
    return undefined;
}

function parseCombinedIssueValue(value: string): LLMIssue | undefined {
    const trimmed = stripWrappingQuotes(value);
    if (!trimmed) {
        return undefined;
    }

    const pipeParts = trimmed
        .split(/[|｜]/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    if (pipeParts.length >= 2) {
        const severity = normalizeSeverityLabel(pipeParts[0]) ?? "warning";
        const message = pipeParts.slice(1).join("|").trim();
        return message ? { message, severity } : undefined;
    }

    const levelAndMessage = trimmed.match(
        /^(error|warning|err|warn|错误|警告|严重|轻微)\s*[:：]\s*(.+)$/i
    );
    if (levelAndMessage?.[2]) {
        return {
            message: levelAndMessage[2].trim(),
            severity: normalizeSeverityLabel(levelAndMessage[1]) ?? "warning",
        };
    }

    return { message: trimmed, severity: "warning" };
}

function parseIndexedIssue(
    pairs: Map<string, string>,
    index: number
): LLMIssue | undefined {
    const messageAliases = [
        `issue${index}_message`,
        `issue_${index}_message`,
        `message${index}`,
        `message_${index}`,
    ];
    const severityAliases = [
        `issue${index}_severity`,
        `issue_${index}_severity`,
        `severity${index}`,
        `severity_${index}`,
    ];
    const combinedAliases = [`issue${index}`, `issue_${index}`];

    const message = getFirstMatch(pairs, messageAliases);
    if (message) {
        return {
            message,
            severity:
                normalizeSeverityLabel(getFirstMatch(pairs, severityAliases)) ??
                "warning",
        };
    }
    const combined = getFirstMatch(pairs, combinedAliases);
    if (combined) {
        return parseCombinedIssueValue(combined);
    }
    return undefined;
}

function parseKeyValueReview(value: string): LLMReview | undefined {
    const pairs = parseKeyValueLines(value);
    if (pairs.size === 0) {
        return undefined;
    }

    const issueCount = parseInteger(
        getFirstMatch(pairs, ["issue_count", "issues", "issuecount"])
    );
    if (issueCount === 0) {
        return { issues: [] };
    }

    const issues: LLMIssue[] = [];
    for (let index = 1; index <= 2; index += 1) {
        const issue = parseIndexedIssue(pairs, index);
        if (issue?.message) {
            issues.push(issue);
        }
    }

    if (issues.length === 0) {
        const singleMessage = getFirstMatch(pairs, ["issue_message", "message"]);
        if (singleMessage) {
            issues.push({
                message: singleMessage,
                severity:
                    normalizeSeverityLabel(
                        getFirstMatch(pairs, ["issue_severity", "severity"])
                    ) ?? "warning",
            });
        }
    }

    const limitedIssues =
        issueCount && issueCount > 0 ? issues.slice(0, issueCount) : issues;
    const rewrite = stripWrappingQuotes(getFirstMatch(pairs, ["rewrite"]));

    if (limitedIssues.length === 0) {
        return { issues: [] };
    }

    const result: LLMReview = { issues: limitedIssues };
    if (rewrite) {
        result.rewrite = rewrite;
    }
    return result;
}

function parseReview(value?: string): LLMReview | undefined {
    if (!value) {
        return undefined;
    }
    const normalized = normalizeReviewContent(value);
    return parseKeyValueReview(normalized) ?? { issues: [] };
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

function isKeyValueLikeIssue(message: string): boolean {
    const trimmed = message.trim();
    return /^[A-Za-z][\w-]*\s*=/.test(trimmed);
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

function isQuotedFragmentMissing(message: string, content: string): boolean {
    const fragments = extractQuotedFragments(message);
    if (!fragments) {
        return false;
    }
    return !content.includes(fragments.before);
}

function isFunctionWordSwap(message: string): boolean {
    const fragments = extractQuotedFragments(message);
    if (!fragments || fragments.before === fragments.after) {
        return false;
    }
    return (
        FUNCTION_WORDS.has(fragments.before) &&
        FUNCTION_WORDS.has(fragments.after)
    );
}

function isStopWordSingleReplacement(message: string): boolean {
    const fragments = extractQuotedFragments(message);
    if (!fragments || fragments.before === fragments.after) {
        return false;
    }
    return (
        fragments.before.length === 1 &&
        FUNCTION_WORDS.has(fragments.before)
    );
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
        containsLatinOrLatex(fragments.before) ||
        containsLatinOrLatex(fragments.after)
    ) {
        return false;
    }
    const typoSignal = /错别字|拼写错误|笔误|错字/.test(trimmed);
    const repeatSignal = /重复|多余/.test(trimmed);
    const insertionDeletion =
        fragments.before.includes(fragments.after) ||
        fragments.after.includes(fragments.before);
    if (!insertionDeletion) {
        const distance = editDistance(fragments.before, fragments.after);
        if (!typoSignal || distance > 1) {
            return false;
        }
    } else if (typoSignal) {
        // Allow minimal insert/delete for clear typo fixes.
    } else if (repeatSignal) {
        if (!isExactDuplication(fragments.before, fragments.after)) {
            return false;
        }
    } else {
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
    review(element: DocumentElement): Promise<LLMReviewResult | undefined>;
}

interface LLMAnalysisOptions {
    progress?: vscode.Progress<{ message?: string; increment?: number }>;
    token?: vscode.CancellationToken;
    onDiagnostics?: (items: AnalyzerDiagnostic[], element: DocumentElement) => void;
    onDebug?: (
        result: {
            prompt: LLMReviewResult["prompt"];
            response?: string;
            review?: LLMReview;
            providerId: string;
        },
        element: DocumentElement
    ) => void;
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
            const result = await provider.review(element);
            processed += 1;
            progress?.report({
                message: `LLM analyzing ${processed}/${targets.length}`,
                increment,
            });
            if (!result) {
                continue;
            }
            if (options?.onDebug) {
                options.onDebug(
                    {
                        prompt: result.prompt,
                        response: result.raw,
                        review: result.review,
                        providerId: provider.id,
                    },
                    element
                );
            }
            const review = result.review;
            if (!review) {
                continue;
            }
            const newDiagnostics: AnalyzerDiagnostic[] = [];
            const rewrite =
                typeof review.rewrite === "string"
                    ? review.rewrite.trim()
                    : "";
            for (const issue of review.issues) {
                if (
                    !issue.message ||
                    !hasRecognizedSeverity(issue) ||
                    isPunctuationIssue(issue.message) ||
                    isLowValueIssue(issue.message) ||
                    isStyleIssue(issue.message) ||
                    isKeyValueLikeIssue(issue.message) ||
                    isQuotedFragmentMissing(issue.message, element.content) ||
                    isFunctionWordSwap(issue.message) ||
                    isStopWordSingleReplacement(issue.message) ||
                    !isConcreteIssue(issue.message)
                ) {
                    continue;
                }
                if (!rewrite) {
                    continue;
                }
                const severity = this.mapSeverity(issue.severity);
                const message = rewrite
                    ? `[LLM] ${issue.message} 修改后：${rewrite}`
                    : `[LLM] ${issue.message}`;
                const diagnostic = new vscode.Diagnostic(
                    element.range,
                    message,
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
    ): Promise<LLMReviewResult | undefined> {
        const url =
            this.settings.openaiBaseUrl?.trim() ||
            "https://api.openai.com/v1/chat/completions";
        const normalizedUrl = this.normalizeUrl(url);
        const apiKey = this.settings.openaiApiKey?.trim();
        if (!apiKey) {
            return undefined;
        }

        const system = LLM_REVIEW_SYSTEM_PROMPT;
        const user = buildLlmReviewUserPrompt(element.content);
        const payload = {
            model: this.settings.openaiModel || "gpt-3.5-turbo",
            temperature: 0,
            top_p: 0.1,
            messages: [
                {
                    role: "system",
                    content: system,
                },
                {
                    role: "user",
                    content: user,
                },
            ],
        };

        try {
            const headers: Record<string, string> = {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            };
            const isOpenRouter = normalizedUrl.includes("openrouter.ai");
            const referer = isOpenRouter ? "https://localhost" : "";
            if (referer) {
                headers["HTTP-Referer"] = referer;
            }
            const title = isOpenRouter ? "thesis-checker" : "";
            if (title) {
                headers["X-Title"] = title;
            }
            const response = await fetch(normalizedUrl, {
                method: "POST",
                headers,
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
            return {
                review: parseReview(content),
                prompt: { system, user },
                raw: content,
            };
        } catch (error) {
            this.output.appendLine(`OpenAI request failed: ${String(error)}`);
            return undefined;
        }
    }

    private normalizeUrl(url: string): string {
        try {
            const parsed = new URL(url);
            if (parsed.hostname.includes("openrouter.ai")) {
                if (parsed.pathname === "/v1") {
                    parsed.pathname = "/api/v1";
                } else if (parsed.pathname === "/v1/") {
                    parsed.pathname = "/api/v1/";
                } else if (parsed.pathname.startsWith("/v1/")) {
                    parsed.pathname = `/api${parsed.pathname}`;
                }
            }
            return parsed.toString();
        } catch {
            return url;
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
    ): Promise<LLMReviewResult | undefined> {
        const endpoint = (
            this.settings.ollamaEndpoint || "http://localhost:11434"
        ).replace(/\/$/, "");
        const model = this.settings.ollamaModel || "llama3";
        const prompt = this.buildPrompt(element);
        const payload = {
            model,
            prompt,
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
            return {
                review: parseReview(data.response),
                prompt,
                raw: data.response,
            };
        } catch (error) {
            this.output.appendLine(`Ollama request failed: ${String(error)}`);
            return undefined;
        }
    }

    private buildPrompt(element: DocumentElement): string {
        return buildLlmReviewPrompt(element.content);
    }

}
