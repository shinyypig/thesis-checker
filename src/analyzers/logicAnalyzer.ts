import * as vscode from 'vscode';
import { AnalyzerDiagnostic, DocumentElement } from '../types';

interface SectionStat {
	element: DocumentElement;
	sentences: number;
}

const SENTENCE_PUNCTUATION_REGEX = /[.!?。？！]$/u;
const ACRONYM_HINT_MESSAGE = '缩写首次出现，应当给出全称，如 机器学习（Machine Learning, ML）或者 Machine Learning (ML)';

export class LogicAnalyzer {
	private readonly config = vscode.workspace.getConfiguration('thesisChecker');

	public analyze(elements: DocumentElement[]): AnalyzerDiagnostic[] {
		const diagnostics: AnalyzerDiagnostic[] = [];
		diagnostics.push(...this.checkSentencePunctuation(elements));
		diagnostics.push(...this.checkAbbreviations(elements));
		diagnostics.push(...this.checkSectionDensity(elements));
		diagnostics.push(...this.checkCaptions(elements));
		return diagnostics;
	}

	private checkSentencePunctuation(elements: DocumentElement[]): AnalyzerDiagnostic[] {
		const diagnostics: AnalyzerDiagnostic[] = [];

		for (const element of elements) {
			if (element.type !== 'sentence') {
				continue;
			}

			const value = element.content.trim();
			if (!value) {
				continue;
			}

			if (!SENTENCE_PUNCTUATION_REGEX.test(value)) {
				const diagnostic = new vscode.Diagnostic(
					element.range,
					'Sentence is missing terminal punctuation.',
					vscode.DiagnosticSeverity.Warning
				);
				diagnostic.source = 'Thesis Logic';
				diagnostics.push({ uri: vscode.Uri.file(element.filePath), diagnostic });
			}
		}

		return diagnostics;
	}

	private checkAbbreviations(elements: DocumentElement[]): AnalyzerDiagnostic[] {
		const diagnostics: AnalyzerDiagnostic[] = [];
		const seenAcronyms = new Set<string>();

		for (const element of elements) {
			if (element.type !== 'sentence') {
				continue;
			}

			const definitionsInSentence = this.extractDefinedAcronyms(element.content);
			const acronyms = this.extractAcronyms(element.content);

			for (const acronym of acronyms) {
				if (seenAcronyms.has(acronym)) {
					continue;
				}
				seenAcronyms.add(acronym);
				if (!definitionsInSentence.has(acronym)) {
					const diagnostic = new vscode.Diagnostic(
						element.range,
						ACRONYM_HINT_MESSAGE,
						vscode.DiagnosticSeverity.Warning
					);
					diagnostic.source = 'Thesis Logic';
					diagnostic.code = 'ACRONYM_FIRST_USE';
					diagnostic.relatedInformation = [
						new vscode.DiagnosticRelatedInformation(
							new vscode.Location(vscode.Uri.file(element.filePath), element.range),
							`缩写：${acronym}`
						)
					];
					diagnostics.push({ uri: vscode.Uri.file(element.filePath), diagnostic });
				}
			}
		}

		return diagnostics;
	}

	private checkSectionDensity(elements: DocumentElement[]): AnalyzerDiagnostic[] {
		const diagnostics: AnalyzerDiagnostic[] = [];
		const stats: SectionStat[] = [];
		let currentSection: SectionStat | undefined;
		const sectionTypes = new Set<ElementTypes>(['chapter', 'section', 'subsection', 'subsubsection']);
		const minSentences = this.config.get<number>('logic.minimumSentencesPerSection', 3);

		for (const element of elements) {
			if (sectionTypes.has(element.type as ElementTypes)) {
				currentSection = { element, sentences: 0 };
				stats.push(currentSection);
				continue;
			}
			if (element.type === 'sentence' && currentSection) {
				currentSection.sentences += 1;
			}
		}

		for (const stat of stats) {
			if (stat.sentences >= minSentences) {
				continue;
			}
			const diagnostic = new vscode.Diagnostic(
				stat.element.range,
				`Section "${stat.element.content}" only contains ${stat.sentences} sentences (minimum recommended: ${minSentences}).`,
				vscode.DiagnosticSeverity.Warning
			);
			diagnostic.source = 'Thesis Logic';
			diagnostics.push({ uri: vscode.Uri.file(stat.element.filePath), diagnostic });
		}

		return diagnostics;
	}

	private checkCaptions(elements: DocumentElement[]): AnalyzerDiagnostic[] {
		const diagnostics: AnalyzerDiagnostic[] = [];

		for (const element of elements) {
			if (element.type !== 'figure' && element.type !== 'table') {
				continue;
			}

			const hasCaption = Boolean(element.metadata?.hasCaption);
			if (hasCaption) {
				continue;
			}

			const diagnostic = new vscode.Diagnostic(
				element.range,
				`${element.type === 'figure' ? 'Figure' : 'Table'} is missing a \\caption{...}.`,
				vscode.DiagnosticSeverity.Warning
			);
			diagnostic.source = 'Thesis Logic';
			diagnostics.push({ uri: vscode.Uri.file(element.filePath), diagnostic });
		}

		return diagnostics;
	}

	private extractAcronyms(text: string): string[] {
		const matches = text.match(/\b[A-Z]{2,}\b/g);
		if (!matches) {
			return [];
		}
		return matches;
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
				definitions.add(token);
			}
		}

		return definitions;
	}
}

type ElementTypes = 'chapter' | 'section' | 'subsection' | 'subsubsection';
