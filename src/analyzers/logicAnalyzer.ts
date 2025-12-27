import * as vscode from "vscode";
import { AnalyzerDiagnostic, DocumentElement } from "../types";
import { COMMON_ACRONYMS } from "./commonAcronyms";

interface SectionStat {
    element: DocumentElement;
    sentences: number;
    level: number;
    hasChildSection: boolean;
}

interface LogicIncrementalPlan {
    punctuationTargets?: Set<string>;
    captionTargets?: Set<string>;
    abbreviationStartIndex?: number;
    sectionFilesToRecheck?: Set<string>;
    elementKeyFor: (element: DocumentElement) => string;
}

const SENTENCE_PUNCTUATION_REGEX = /[.!?。？！：:；;]/u;
const ACRONYM_HINT_EXAMPLE = "应当给出全称。";
const MIN_ACRONYM_LENGTH = 3;
const ENUMERATED_DEFINITION_HINT = /分别.*?(代表|表示|指|是)/u;
const SECTION_LEVELS: Record<ElementTypes, number> = {
    chapter: 0,
    section: 1,
    subsection: 2,
    subsubsection: 3,
};

export class LogicAnalyzer {
    private readonly config =
        vscode.workspace.getConfiguration("thesisChecker");

    public analyze(elements: DocumentElement[]): AnalyzerDiagnostic[] {
        const diagnostics: AnalyzerDiagnostic[] = [];
        diagnostics.push(...this.checkSentencePunctuation(elements));
        diagnostics.push(...this.checkAbbreviations(elements));
        diagnostics.push(...this.checkSectionDensity(elements));
        diagnostics.push(...this.checkCaptions(elements));
        return diagnostics;
    }

    public analyzeIncremental(
        elements: DocumentElement[],
        plan: LogicIncrementalPlan
    ): AnalyzerDiagnostic[] {
        const diagnostics: AnalyzerDiagnostic[] = [];

        if (plan.punctuationTargets?.size) {
            const targets = elements.filter(
                (element) =>
                    element.type === "sentence" &&
                    plan.punctuationTargets?.has(plan.elementKeyFor(element))
            );
            diagnostics.push(...this.checkSentencePunctuation(targets));
        }

        if (plan.abbreviationStartIndex !== undefined) {
            const sentences = elements.filter(
                (element) => element.type === "sentence"
            );
            const startIndex = Math.max(
                0,
                Math.min(plan.abbreviationStartIndex, sentences.length)
            );
            diagnostics.push(
                ...this.checkAbbreviationsFromIndex(sentences, startIndex)
            );
        }

        if (plan.sectionFilesToRecheck?.size) {
            const grouped = new Map<string, DocumentElement[]>();
            for (const element of elements) {
                if (!plan.sectionFilesToRecheck.has(element.filePath)) {
                    continue;
                }
                const bucket = grouped.get(element.filePath) ?? [];
                bucket.push(element);
                grouped.set(element.filePath, bucket);
            }
            for (const group of grouped.values()) {
                diagnostics.push(...this.checkSectionDensity(group));
            }
        }

        if (plan.captionTargets?.size) {
            const targets = elements.filter((element) => {
                if (element.type !== "figure" && element.type !== "table") {
                    return false;
                }
                return plan.captionTargets?.has(plan.elementKeyFor(element));
            });
            diagnostics.push(...this.checkCaptions(targets));
        }

        return diagnostics;
    }

    private checkSentencePunctuation(
        elements: DocumentElement[]
    ): AnalyzerDiagnostic[] {
        const diagnostics: AnalyzerDiagnostic[] = [];

        for (const element of elements) {
            if (element.type !== "sentence") {
                continue;
            }

            const value = element.content.trim();
            if (!value) {
                continue;
            }

            if (!SENTENCE_PUNCTUATION_REGEX.test(value)) {
                const diagnostic = new vscode.Diagnostic(
                    element.range,
                    "句子缺少句末标点。",
                    vscode.DiagnosticSeverity.Warning
                );
                diagnostic.source = "Thesis Logic";
                diagnostics.push({
                    uri: vscode.Uri.file(element.filePath),
                    diagnostic,
                });
            }
        }

        return diagnostics;
    }

    private checkAbbreviations(
        elements: DocumentElement[]
    ): AnalyzerDiagnostic[] {
        return this.checkAbbreviationsFromIndex(elements, 0);
    }

    private checkAbbreviationsFromIndex(
        elements: DocumentElement[],
        startIndex: number
    ): AnalyzerDiagnostic[] {
        const diagnostics: AnalyzerDiagnostic[] = [];
        const seenAcronyms = new Set<string>();

        const start = Math.max(0, Math.min(startIndex, elements.length));

        for (let index = 0; index < start; index += 1) {
            const element = elements[index];
            if (element.type !== "sentence") {
                continue;
            }
            for (const acronym of this.extractAcronyms(element.content)) {
                const normalized = acronym.toUpperCase();
                if (COMMON_ACRONYMS.has(normalized)) {
                    continue;
                }
                seenAcronyms.add(acronym);
            }
        }

        for (let index = start; index < elements.length; index += 1) {
            const element = elements[index];
            if (element.type !== "sentence") {
                continue;
            }

            const definitionsInSentence = this.extractDefinedAcronyms(
                element.content
            );
            const acronyms = this.extractAcronyms(element.content);

            for (const acronym of acronyms) {
                const normalized = acronym.toUpperCase();
                if (COMMON_ACRONYMS.has(normalized)) {
                    continue;
                }
                if (seenAcronyms.has(acronym)) {
                    continue;
                }
                seenAcronyms.add(acronym);
                if (!definitionsInSentence.has(acronym)) {
                    const diagnostic = new vscode.Diagnostic(
                        element.range,
                        `缩写“${acronym}”首次出现，${ACRONYM_HINT_EXAMPLE}`,
                        vscode.DiagnosticSeverity.Warning
                    );
                    diagnostic.source = "Thesis Logic";
                    diagnostic.code = "ACRONYM_FIRST_USE";
                    diagnostic.relatedInformation = [
                        new vscode.DiagnosticRelatedInformation(
                            new vscode.Location(
                                vscode.Uri.file(element.filePath),
                                element.range
                            ),
                            `缩写：${acronym}`
                        ),
                    ];
                    diagnostics.push({
                        uri: vscode.Uri.file(element.filePath),
                        diagnostic,
                    });
                }
            }
        }

        return diagnostics;
    }

    private checkSectionDensity(
        elements: DocumentElement[]
    ): AnalyzerDiagnostic[] {
        const diagnostics: AnalyzerDiagnostic[] = [];
        const stats: SectionStat[] = [];
        const stack: SectionStat[] = [];
        const minSentences = this.config.get<number>(
            "logic.minimumSentencesPerSection",
            3
        );

        for (const element of elements) {
            const level = SECTION_LEVELS[element.type as ElementTypes];
            if (typeof level === "number") {
                while (stack.length && stack[stack.length - 1].level >= level) {
                    stack.pop();
                }
                const stat: SectionStat = {
                    element,
                    sentences: 0,
                    level,
                    hasChildSection: false,
                };
                if (stack.length) {
                    stack[stack.length - 1].hasChildSection = true;
                }
                stack.push(stat);
                stats.push(stat);
                continue;
            }
            if (element.type === "sentence" && stack.length) {
                stack[stack.length - 1].sentences += 1;
            }
        }

        for (const stat of stats) {
            if (stat.sentences >= minSentences || stat.hasChildSection) {
                continue;
            }
            const diagnostic = new vscode.Diagnostic(
                stat.element.range,
                `章节“${stat.element.content}”过于简短，建议丰富内容。`,
                vscode.DiagnosticSeverity.Warning
            );
            diagnostic.source = "Thesis Logic";
            diagnostics.push({
                uri: vscode.Uri.file(stat.element.filePath),
                diagnostic,
            });
        }

        return diagnostics;
    }

    private checkCaptions(elements: DocumentElement[]): AnalyzerDiagnostic[] {
        const diagnostics: AnalyzerDiagnostic[] = [];

        for (const element of elements) {
            if (element.type !== "figure" && element.type !== "table") {
                continue;
            }

            const hasCaption = Boolean(element.metadata?.hasCaption);
            if (hasCaption) {
                continue;
            }

            const diagnostic = new vscode.Diagnostic(
                element.range,
                element.type === "figure"
                    ? "图缺少 \\caption{...}。"
                    : "表缺少 \\caption{...}。",
                vscode.DiagnosticSeverity.Warning
            );
            diagnostic.source = "Thesis Logic";
            diagnostics.push({
                uri: vscode.Uri.file(element.filePath),
                diagnostic,
            });
        }

        return diagnostics;
    }

    private extractAcronyms(text: string): string[] {
        const matches = text.match(/\b[A-Z]{2,}\b/g);
        if (!matches) {
            return [];
        }
        return matches.filter((token) => token.length >= MIN_ACRONYM_LENGTH);
    }

    private extractDefinedAcronyms(text: string): Set<string> {
        const definitions = new Set<string>();
        const genericParenRegex = /([^\(\)（）]{2,})\s*[\(（]([^\)）]+)[\)）]/g;
        let match: RegExpExecArray | null;

        while ((match = genericParenRegex.exec(text)) !== null) {
            const inner = match[2];
            const uppercaseTokens = inner.match(/\b[A-Z]{2,}\b/g);
            if (!uppercaseTokens) {
                continue;
            }
            for (const token of uppercaseTokens) {
                if (token.length >= MIN_ACRONYM_LENGTH) {
                    definitions.add(token);
                }
            }
        }

        if (ENUMERATED_DEFINITION_HINT.test(text)) {
            for (const token of this.extractAcronyms(text)) {
                definitions.add(token);
            }
        }

        return definitions;
    }
}

type ElementTypes = "chapter" | "section" | "subsection" | "subsubsection";
