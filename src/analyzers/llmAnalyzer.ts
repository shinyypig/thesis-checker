import * as vscode from "vscode";
import { AnalyzerDiagnostic, DocumentElement } from "../types";
import {
    buildLlmReviewPrompt,
    buildLlmReviewUserPrompt,
    getLlmReviewSystemPrompt,
    LLMReviewMode,
    normalizeLlmReviewMode,
} from "./llmPrompts";

interface LLMSettings {
    enabled?: boolean;
    provider?: "openai" | "ollama";
    reviewMode?: LLMReviewMode;
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

class LLMProviderFatalError extends Error {
    public readonly userNotified: boolean;

    constructor(message: string, userNotified = false) {
        super(message);
        this.name = "LLMProviderFatalError";
        this.userNotified = userNotified;
    }
}

function extractApiErrorMessage(payload: string): string | undefined {
    const trimmed = payload.trim();
    if (!trimmed) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(trimmed) as {
            error?: { message?: unknown };
            message?: unknown;
        };
        if (typeof parsed.error?.message === "string") {
            return parsed.error.message;
        }
        if (typeof parsed.message === "string") {
            return parsed.message;
        }
    } catch {
        // Non-JSON response body, keep raw text fallback.
    }
    return trimmed;
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
    "中",
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

function isCorrectedFragmentAlreadyPresent(
    message: string,
    content: string
): boolean {
    if (!/错别字|拼写错误|笔误|错字/.test(message)) {
        return false;
    }
    const fragments = extractQuotedFragments(message);
    if (!fragments || fragments.before === fragments.after) {
        return false;
    }
    return content.includes(fragments.after);
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

function isExactDuplication(before: string, after: string): boolean {
    return before === after + after || after === before + before;
}

function extractDifferenceSegment(longer: string, shorter: string): string | undefined {
    const index = longer.indexOf(shorter);
    if (index < 0) {
        return undefined;
    }
    return `${longer.slice(0, index)}${longer.slice(index + shorter.length)}`;
}

function isAllowedIssueType(message: string): boolean {
    return /【(错别字|拼写错误|笔误|错字|重复)】/.test(
        message
    );
}

function editDistance(a: string, b: string): number {
    const rows = a.length + 1;
    const cols = b.length + 1;
    const dp: number[][] = Array.from({ length: rows }, () =>
        new Array(cols).fill(0)
    );
    for (let row = 0; row < rows; row += 1) {
        dp[row][0] = row;
    }
    for (let col = 0; col < cols; col += 1) {
        dp[0][col] = col;
    }
    for (let row = 1; row < rows; row += 1) {
        for (let col = 1; col < cols; col += 1) {
            const replaceCost = a[row - 1] === b[col - 1] ? 0 : 1;
            dp[row][col] = Math.min(
                dp[row - 1][col] + 1,
                dp[row][col - 1] + 1,
                dp[row - 1][col - 1] + replaceCost
            );
        }
    }
    return dp[rows - 1][cols - 1];
}

function isConcreteIssue(message: string, mode: LLMReviewMode): boolean {
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
    if (!isAllowedIssueType(trimmed)) {
        return false;
    }
    const fragments = extractQuotedFragments(trimmed);
    if (!fragments) {
        return false;
    }
    if (!fragments.before.trim() || !fragments.after.trim()) {
        return false;
    }
    if (fragments.before === fragments.after) {
        return false;
    }

    const isLowFalsePositive = mode === "lowFalsePositive";
    const isTypos = /错别字|拼写错误|笔误|错字/.test(trimmed);
    const isRepeatOrRedundant = /重复|多余/.test(trimmed);

    if (isTypos) {
        if (
            containsLatinOrLatex(fragments.before) ||
            containsLatinOrLatex(fragments.after)
        ) {
            return false;
        }
        if (
            !/[\p{Letter}\p{Number}]/u.test(fragments.before) ||
            !/[\p{Letter}\p{Number}]/u.test(fragments.after)
        ) {
            return false;
        }

        if (isLowFalsePositive) {
            // Keep precision high: only accept "missing-character" fixes,
            // i.e. corrected fragment must contain the original fragment.
            if (!fragments.after.includes(fragments.before)) {
                return false;
            }
            const delta = extractDifferenceSegment(
                fragments.after,
                fragments.before
            );
            if (!delta) {
                return false;
            }
            const deltaChars = [...delta];
            if (deltaChars.length !== 1) {
                return false;
            }
            if (
                deltaChars.some((char) => !/[\p{Letter}\p{Number}]/u.test(char))
            ) {
                return false;
            }
            if (deltaChars.every((char) => FUNCTION_WORDS.has(char))) {
                return false;
            }
            return true;
        }

        const insertionDeletion =
            fragments.before.includes(fragments.after) ||
            fragments.after.includes(fragments.before);
        if (insertionDeletion) {
            const longer =
                fragments.before.length >= fragments.after.length
                    ? fragments.before
                    : fragments.after;
            const shorter =
                longer === fragments.before
                    ? fragments.after
                    : fragments.before;
            const delta = extractDifferenceSegment(longer, shorter);
            if (!delta) {
                return false;
            }
            const deltaChars = [...delta];
            if (deltaChars.length !== 1) {
                return false;
            }
            if (
                deltaChars.some((char) => !/[\p{Letter}\p{Number}]/u.test(char))
            ) {
                return false;
            }
            if (deltaChars.every((char) => FUNCTION_WORDS.has(char))) {
                return false;
            }
            return true;
        }

        if (editDistance(fragments.before, fragments.after) !== 1) {
            return false;
        }
        const beforeChars = [...fragments.before];
        const afterChars = [...fragments.after];
        if (beforeChars.length !== afterChars.length) {
            return false;
        }
        const mismatchPairs = beforeChars
            .map((char, index) => ({ before: char, after: afterChars[index] }))
            .filter((pair) => pair.before !== pair.after);
        if (mismatchPairs.length !== 1) {
            return false;
        }
        const [pair] = mismatchPairs;
        if (
            FUNCTION_WORDS.has(pair.before) &&
            FUNCTION_WORDS.has(pair.after)
        ) {
            return false;
        }
        return true;
    }

    if (isRepeatOrRedundant) {
        if (!isExactDuplication(fragments.before, fragments.after)) {
            return false;
        }
        return true;
    }
    return false;
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
    private readonly output: vscode.OutputChannel;

    constructor(channel?: vscode.OutputChannel) {
        this.output =
            channel ?? vscode.window.createOutputChannel("Thesis Checker");
    }

    public async analyze(
        elements: DocumentElement[],
        options?: LLMAnalysisOptions
    ): Promise<AnalyzerDiagnostic[]> {
        const settings = vscode.workspace
            .getConfiguration("thesisChecker")
            .get<LLMSettings>("llm");
        if (!settings?.enabled) {
            return [];
        }

        const reviewMode = normalizeLlmReviewMode(settings.reviewMode);
        const provider = this.createProvider(settings, reviewMode);
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
            let result: LLMReviewResult | undefined;
            try {
                result = await provider.review(element);
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                this.output.appendLine(
                    `Stopping LLM analysis after provider error: ${message}`
                );
                if (
                    !(error instanceof LLMProviderFatalError) ||
                    !error.userNotified
                ) {
                    void vscode.window.showWarningMessage(message);
                }
                break;
            }
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
                    (reviewMode === "lowFalsePositive" &&
                        isCorrectedFragmentAlreadyPresent(
                            issue.message,
                            element.content
                        )) ||
                    isFunctionWordSwap(issue.message) ||
                    isStopWordSingleReplacement(issue.message) ||
                    !isConcreteIssue(issue.message, reviewMode)
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

    private createProvider(
        settings: LLMSettings,
        reviewMode: LLMReviewMode
    ): LLMProvider | undefined {
        switch (settings.provider) {
            case "ollama":
                return new OllamaProvider(settings, this.output, reviewMode);
            case "openai":
            default:
                return new OpenAIProvider(settings, this.output, reviewMode);
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
    private hasShownUserWarning = false;

    constructor(
        private readonly settings: LLMSettings,
        private readonly output: vscode.OutputChannel,
        private readonly reviewMode: LLMReviewMode
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

        const system = getLlmReviewSystemPrompt(this.reviewMode);
        const user = buildLlmReviewUserPrompt(element.content, this.reviewMode);
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
                const errorMessage = extractApiErrorMessage(details) ?? details;
                const message = `OpenAI API error (${response.status}): ${errorMessage}`;
                this.output.appendLine(message);
                this.notifyUserWarningOnce(message);
                throw new LLMProviderFatalError(message, true);
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
            if (error instanceof LLMProviderFatalError) {
                throw error;
            }
            const message = `OpenAI request failed: ${String(error)}`;
            this.output.appendLine(message);
            this.notifyUserWarningOnce(message);
            throw new LLMProviderFatalError(message, true);
        }
    }

    private notifyUserWarningOnce(message: string): void {
        if (this.hasShownUserWarning) {
            return;
        }
        this.hasShownUserWarning = true;
        void vscode.window.showWarningMessage(message);
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
                if (
                    parsed.pathname === "/api/v1" ||
                    parsed.pathname === "/api/v1/"
                ) {
                    parsed.pathname = "/api/v1/chat/completions";
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
        private readonly output: vscode.OutputChannel,
        private readonly reviewMode: LLMReviewMode
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
                const message = `Ollama API error (${response.status}): ${text}`;
                this.output.appendLine(message);
                throw new LLMProviderFatalError(message);
            }
            const data = await response.json();
            return {
                review: parseReview(data.response),
                prompt,
                raw: data.response,
            };
        } catch (error) {
            if (error instanceof LLMProviderFatalError) {
                throw error;
            }
            const message = `Ollama request failed: ${String(error)}`;
            this.output.appendLine(message);
            throw new LLMProviderFatalError(message);
        }
    }

    private buildPrompt(element: DocumentElement): string {
        return buildLlmReviewPrompt(element.content, this.reviewMode);
    }

}
