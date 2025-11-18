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

        for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
            const originalLine = lines[lineNumber];
            const lineWithoutComments = this.stripComments(originalLine);
            const trimmed = lineWithoutComments.trim();

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

            const sentences =
                this.extractSentenceFragments(lineWithoutComments);
            for (const sentence of sentences) {
                const start = new vscode.Position(lineNumber, sentence.start);
                const end = new vscode.Position(lineNumber, sentence.end);
                elements.push({
                    type: "sentence",
                    content: sentence.content,
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
