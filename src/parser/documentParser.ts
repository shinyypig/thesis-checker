import * as vscode from "vscode";
import { split as splitIntoSentences } from "sentence-splitter";
import type {
    SentenceSplitterTxtNode,
    TxtSentenceNode,
} from "sentence-splitter";
import { DocumentElement, ElementType } from "../types";

const HEADING_REGEX =
    /^\\(title|chapter|section|subsection|subsubsection)\*?\{(.+)\}/;
const ENVIRONMENT_REGEX = /^\\begin\{([a-zA-Z*]+)\}/;
const ENVIRONMENT_TYPE_MAP: Record<string, ElementType> = {
    equation: "equation",
    "equation*": "equation",
    align: "equation",
    "align*": "equation",
    alignat: "equation",
    "alignat*": "equation",
    gather: "equation",
    "gather*": "equation",
    figure: "figure",
    "figure*": "figure",
    table: "table",
    "table*": "table",
    titlepage: "environment",
};

export class DocumentParser {
    constructor(private readonly workspace = vscode.workspace) {}

    public async parseWorkspace(): Promise<DocumentElement[]> {
        const files = await this.workspace.findFiles(
            "**/*.tex",
            "**/{node_modules,.git}/**"
        );
        files.sort((a, b) => a.fsPath.localeCompare(b.fsPath));

        const elements: DocumentElement[] = [];
        for (const uri of files) {
            try {
                const document = await this.workspace.openTextDocument(uri);
                const parsed = this.parseDocument(document);
                elements.push(...parsed);
            } catch (error) {
                console.error(`Failed to parse ${uri.fsPath}`, error);
            }
        }

        return elements;
    }

    private parseDocument(document: vscode.TextDocument): DocumentElement[] {
        const elements: DocumentElement[] = [];
        const lines = document.getText().split(/\r?\n/);
        const filePath = document.uri.fsPath;

        let pendingDisplayMath: MultiLineMathState | null = null;

        for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
            const originalLine = lines[lineNumber];
            const lineWithoutComments = this.stripComments(originalLine);
            const trimmed = lineWithoutComments.trim();

            if (pendingDisplayMath) {
                pendingDisplayMath.lines.push(lineWithoutComments);
                if (
                    this.lineEndsDisplayMath(
                        lineWithoutComments,
                        pendingDisplayMath.delimiter
                    )
                ) {
                    const range = new vscode.Range(
                        new vscode.Position(pendingDisplayMath.startLine, 0),
                        new vscode.Position(
                            lineNumber,
                            originalLine.length ?? 0
                        )
                    );
                    elements.push({
                        type: "equation",
                        content: pendingDisplayMath.lines.join("\n").trim(),
                        filePath,
                        range,
                        metadata: {
                            inline: false,
                            delimiter: pendingDisplayMath.delimiter,
                            block: true,
                        },
                    });
                    pendingDisplayMath = null;
                }
                continue;
            }

            const displayMathStart =
                this.detectDisplayMathBlockStart(lineWithoutComments);
            if (displayMathStart) {
                pendingDisplayMath = {
                    delimiter: displayMathStart,
                    startLine: lineNumber,
                    lines: [lineWithoutComments],
                };
                continue;
            }

            if (!trimmed) {
                continue;
            }

            const headingMatch = trimmed.match(HEADING_REGEX);
            if (headingMatch) {
                const [, headingType, title] = headingMatch;
                const elementType =
                    headingType === "title"
                        ? "title"
                        : (headingType as ElementType);
                elements.push({
                    type: elementType,
                    content: title.trim(),
                    filePath,
                    range: new vscode.Range(
                        new vscode.Position(lineNumber, 0),
                        new vscode.Position(lineNumber, originalLine.length)
                    ),
                    metadata: { command: headingType },
                });
                continue;
            }

            const environmentMatch = trimmed.match(ENVIRONMENT_REGEX);
            if (environmentMatch) {
                const environmentName = environmentMatch[1];
                const normalized =
                    environmentName in ENVIRONMENT_TYPE_MAP
                        ? environmentName
                        : environmentName.replace("*", "");
                const elementType =
                    ENVIRONMENT_TYPE_MAP[environmentName] ??
                    ENVIRONMENT_TYPE_MAP[normalized];
                if (elementType) {
                    const { content, endLine } = this.readEnvironmentBlock(
                        lines,
                        lineNumber,
                        environmentName
                    );
                    const range = new vscode.Range(
                        new vscode.Position(lineNumber, 0),
                        new vscode.Position(
                            endLine,
                            lines[endLine]?.length ?? 0
                        )
                    );
                    elements.push({
                        type: elementType,
                        content,
                        filePath,
                        range,
                        metadata: {
                            environment: environmentName,
                            hasCaption: content.includes("\\caption"),
                        },
                    });
                    lineNumber = endLine;
                    continue;
                }
            }

            if (trimmed.startsWith("\\")) {
                continue;
            }

            const displayMath = this.extractDisplayMath(lineWithoutComments);
            for (const math of displayMath) {
                const start = new vscode.Position(lineNumber, math.start);
                const end = new vscode.Position(lineNumber, math.end);
                elements.push({
                    type: "equation",
                    content: math.content,
                    filePath,
                    range: new vscode.Range(start, end),
                    metadata: {
                        inline: math.inline,
                        delimiter: math.delimiter,
                    },
                });
            }

            const sentences =
                this.extractSentenceFragments(lineWithoutComments);
            for (const sentence of sentences) {
                const normalizedContent = this.normalizeSentenceContent(
                    sentence.content
                );
                if (!normalizedContent) {
                    continue;
                }
                const start = new vscode.Position(lineNumber, sentence.start);
                const end = new vscode.Position(lineNumber, sentence.end);
                elements.push({
                    type: "sentence",
                    content: normalizedContent,
                    filePath,
                    range: new vscode.Range(start, end),
                });
            }
        }

        return elements;
    }

    private extractSentenceFragments(text: string): SentenceFragment[] {
        if (!text.trim()) {
            return [];
        }

        const nodes = splitIntoSentences(text);
        const fragments: SentenceFragment[] = [];
        for (const node of nodes) {
            if (!isTxtNode(node) || !isSentenceNode(node)) {
                continue;
            }

            const raw = node.raw ?? "";
            const trimmedStart = raw.length - raw.trimStart().length;
            const trimmedEnd = raw.length - raw.trimEnd().length;
            const content = raw.trim();
            if (!content) {
                continue;
            }

            const baseStart = node.range?.[0] ?? 0;
            const baseEnd = node.range?.[1] ?? baseStart + raw.length;
            const start = baseStart + trimmedStart;
            const end = baseEnd - trimmedEnd;

            fragments.push({ content, start, end });
        }

        return fragments;
    }

    private normalizeSentenceContent(content: string): string | null {
        const withoutDisplayMath = this.removeDisplayMathSegments(content);
        const stripped = this.stripLatexCommands(withoutDisplayMath);
        const collapsed = stripped.replace(/\s+/g, " ").trim();
        if (!collapsed) {
            return null;
        }
        if (this.isPureCommandLine(withoutDisplayMath)) {
            return null;
        }
        if (!this.hasTextualPayload(withoutDisplayMath)) {
            return null;
        }
        if (!/[\p{Letter}\p{Number}]/u.test(collapsed)) {
            return null;
        }
        const alphanumericCore = collapsed.replace(
            /[^\p{Letter}\p{Number}]/gu,
            ""
        );
        if (alphanumericCore.length <= 1) {
            return null;
        }
        return collapsed;
    }

    private removeDisplayMathSegments(text: string): string {
        return text
            .replace(/\\\[(?:[\s\S]*?)\\\]/g, " ")
            .replace(/\$\$(?:[\s\S]*?)\$\$/g, " ");
    }

    private stripLatexCommands(text: string): string {
        let result = "";
        let index = 0;

        while (index < text.length) {
            const char = text[index];

            if (char === "{" || char === "}") {
                result += " ";
                index++;
                continue;
            }

            if (char === "\\") {
                const commandStart = index;
                const parsed = this.readCommandName(text, index + 1);
                if (!parsed) {
                    index++;
                    continue;
                }
                const literal = this.extractLiteralCommand(
                    text,
                    commandStart,
                    parsed.newIndex
                );
                result += literal.raw;
                index = literal.endIndex;

                continue;
            }

            if (char === "~") {
                result += " ";
                index++;
                continue;
            }

            result += char;
            index++;
        }

        return result;
    }

    private isPureCommandLine(text: string): boolean {
        const trimmed = text.trim();
        if (!trimmed) {
            return true;
        }
        if (/\$|\\\(|\\\)/.test(trimmed)) {
            return false;
        }
        return /^(\\[a-zA-Z@]+\\*?(?:\s*\[[^\]]*\]|\s*\{[^}]*\})*\s*)+[。！？.!?：:；;，,]*$/.test(
            trimmed
        );
    }

    private hasTextualPayload(text: string): boolean {
        let index = 0;
        while (index < text.length) {
            const char = text[index];
            if (/\s/.test(char)) {
                index++;
                continue;
            }
            if (char === "\\") {
                const parsed = this.readCommandName(text, index + 1);
                if (!parsed) {
                    index++;
                    continue;
                }
                let cursor = parsed.newIndex;
                let advanced = false;
                while (cursor < text.length) {
                    let next = cursor;
                    while (next < text.length && /\s/.test(text[next])) {
                        next++;
                    }
                    if (text[next] === "[") {
                        const block = this.extractBracketContent(
                            text,
                            next,
                            "[",
                            "]"
                        );
                        if (!block) {
                            break;
                        }
                        if (this.containsText(block.content)) {
                            return true;
                        }
                        cursor = block.endIndex;
                        advanced = true;
                        continue;
                    }
                    if (text[next] === "{") {
                        const block = this.extractBracedContent(text, next);
                        if (!block) {
                            break;
                        }
                        if (this.containsText(block.content)) {
                            return true;
                        }
                        cursor = block.endIndex;
                        advanced = true;
                        continue;
                    }
                    break;
                }
                index = advanced ? cursor : parsed.newIndex;
                continue;
            }
            if (char === "$") {
                return true;
            }
            if (/[\p{Letter}\p{Number}]/u.test(char)) {
                return true;
            }
            index++;
        }
        return false;
    }

    private containsText(value: string): boolean {
        if (!value) {
            return false;
        }
        if (/[\p{Letter}\p{Number}]/u.test(value)) {
            return true;
        }
        if (value.includes("$") || value.includes("\\(") || value.includes("\\[")) {
            return true;
        }
        return false;
    }

    private extractLiteralCommand(
        text: string,
        commandStart: number,
        afterCommand: number
    ): { raw: string; endIndex: number } {
        let cursor = afterCommand;
        let lastEnd = afterCommand;

        while (cursor < text.length) {
            let next = cursor;
            while (next < text.length && /\s/.test(text[next])) {
                next++;
            }
            if (text[next] === "[") {
                const block = this.extractBracketContent(
                    text,
                    next,
                    "[",
                    "]"
                );
                if (!block) {
                    break;
                }
                cursor = block.endIndex;
                lastEnd = cursor;
                continue;
            }
            if (text[next] === "{") {
                const block = this.extractBracedContent(text, next);
                if (!block) {
                    break;
                }
                cursor = block.endIndex;
                lastEnd = cursor;
                continue;
            }
            break;
        }

        return {
            raw: text.slice(commandStart, lastEnd),
            endIndex: lastEnd,
        };
    }

    private readCommandName(
        text: string,
        start: number
    ): CommandParseResult | null {
        if (start >= text.length) {
            return null;
        }
        const first = text[start];
        if (!/[a-zA-Z@]/.test(first)) {
            return {
                command: first,
                newIndex: start + 1,
                isSymbol: true,
            };
        }

        let index = start;
        let buffer = "";
        while (index < text.length && /[a-zA-Z*@]/.test(text[index])) {
            buffer += text[index];
            index++;
        }

        return {
            command: buffer,
            newIndex: index,
            isSymbol: false,
        };
    }

    private extractBracketContent(
        text: string,
        start: number,
        open: string,
        close: string
    ): { content: string; endIndex: number } | null {
        if (text[start] !== open) {
            return null;
        }
        let depth = 1;
        let index = start + 1;
        while (index < text.length && depth > 0) {
            if (text[index] === open) {
                depth++;
            } else if (text[index] === close) {
                depth--;
            }
            index++;
        }
        if (depth !== 0) {
            return null;
        }
        return {
            content: text.slice(start + 1, index - 1),
            endIndex: index,
        };
    }

    private extractBracedContent(
        text: string,
        start: number
    ): { content: string; endIndex: number } | null {
        if (text[start] !== "{") {
            return null;
        }
        let depth = 1;
        let index = start + 1;
        while (index < text.length && depth > 0) {
            if (text[index] === "{") {
                depth++;
            } else if (text[index] === "}") {
                depth--;
            }
            index++;
        }
        if (depth !== 0) {
            return null;
        }
        return {
            content: text.slice(start + 1, index - 1),
            endIndex: index,
        };
    }

    private stripComments(line: string): string {
        let escaped = false;
        let result = "";
        for (const char of line) {
            if (escaped) {
                result += char;
                escaped = false;
                continue;
            }
            if (char === "\\") {
                result += char;
                escaped = true;
                continue;
            }
            if (char === "%") {
                break;
            }
            result += char;
        }
        return result;
    }

    private readEnvironmentBlock(
        lines: string[],
        startLine: number,
        environmentName: string
    ): { content: string; endLine: number } {
        const closingTag = `\\end{${environmentName}}`;
        const blockLines: string[] = [];
        let currentLine = startLine;

        while (currentLine < lines.length) {
            blockLines.push(lines[currentLine]);
            if (lines[currentLine].includes(closingTag)) {
                break;
            }
            currentLine++;
        }

        return {
            content: blockLines.join("\n").trim(),
            endLine: Math.min(currentLine, lines.length - 1),
        };
    }

    private extractDisplayMath(text: string): DisplayMathFragment[] {
        if (!text) {
            return [];
        }
        const fragments: DisplayMathFragment[] = [];
        for (const pattern of DISPLAY_MATH_PATTERNS) {
            pattern.regex.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = pattern.regex.exec(text)) !== null) {
                const raw = match[0];
                fragments.push({
                    content: raw,
                    start: match.index,
                    end: match.index + raw.length,
                    inline: pattern.inline,
                    delimiter: pattern.delimiter,
                });
            }
        }
        return fragments;
    }

    private detectDisplayMathBlockStart(
        line: string
    ): DisplayMathFragment["delimiter"] | null {
        const trimmed = line.trimStart();
        if (!trimmed) {
            return null;
        }

        if (trimmed.startsWith("\\[")) {
            const closingIndex = trimmed.indexOf("\\]", 2);
            if (closingIndex === -1) {
                return "bracket";
            }
        }

        if (trimmed.startsWith("$$")) {
            const matches = trimmed.match(/\$\$/g);
            if (matches && matches.length === 1) {
                return "dollar";
            }
        }

        return null;
    }

    private lineEndsDisplayMath(
        line: string,
        delimiter: DisplayMathFragment["delimiter"]
    ): boolean {
        if (delimiter === "bracket") {
            return line.includes("\\]");
        }

        return /\$\$/g.test(line);
    }
}

interface SentenceFragment {
    content: string;
    start: number;
    end: number;
}

function isSentenceNode(
    node: SentenceSplitterTxtNode
): node is TxtSentenceNode {
    return node.type === "Sentence";
}

function isTxtNode(node: unknown): node is SentenceSplitterTxtNode {
    return Boolean(
        node && typeof (node as SentenceSplitterTxtNode).type === "string"
    );
}

interface DisplayMathFragment {
    content: string;
    start: number;
    end: number;
    inline: boolean;
    delimiter: "bracket" | "dollar";
}

interface MultiLineMathState {
    startLine: number;
    delimiter: DisplayMathFragment["delimiter"];
    lines: string[];
}

const DISPLAY_MATH_PATTERNS: {
    regex: RegExp;
    inline: boolean;
    delimiter: DisplayMathFragment["delimiter"];
}[] = [
    { regex: /\\\[(.+?)\\\]/g, inline: false, delimiter: "bracket" },
    { regex: /\$\$(.+?)\$\$/g, inline: false, delimiter: "dollar" },
];

interface CommandParseResult {
    command: string;
    newIndex: number;
    isSymbol: boolean;
}
