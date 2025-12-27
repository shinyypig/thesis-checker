import * as vscode from 'vscode';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { DocumentParser } from './parser/documentParser';
import { LogicAnalyzer } from './analyzers/logicAnalyzer';
import { LLMAnalyzer } from './analyzers/llmAnalyzer';
import { AnalyzerDiagnostic, DocumentElement } from './types';

export function activate(context: vscode.ExtensionContext) {
	const diagnostics = vscode.languages.createDiagnosticCollection('thesis-checker');
	context.subscriptions.push(diagnostics);

	const controller = new ThesisCheckerController(diagnostics);
	context.subscriptions.push(controller);

	void controller.restoreDiagnostics();

	context.subscriptions.push(
		vscode.commands.registerCommand('thesis-checker.scanWorkspace', () => controller.runFullAnalysis()),
		vscode.commands.registerCommand('thesis-checker.exportStructure', () => controller.exportStructure())
	);
}

export function deactivate() {
	// Nothing to clean up for now.
}

class ThesisCheckerController implements vscode.Disposable {
	private readonly parser = new DocumentParser();
	private readonly logicAnalyzer = new LogicAnalyzer();
	private readonly llmAnalyzer = new LLMAnalyzer();
	private readonly statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	private latestElements: DocumentElement[] = [];

	constructor(private readonly diagnosticCollection: vscode.DiagnosticCollection) {
		this.statusBarItem.command = 'thesis-checker.scanWorkspace';
		this.statusBarItem.text = 'Thesis Checker';
		this.statusBarItem.tooltip = 'Run thesis checks';
		this.statusBarItem.show();
	}

	public async restoreDiagnostics(): Promise<void> {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			return;
		}

		const [logicCache, llmCache] = await Promise.all([
			this.loadDiagnosticsCache(workspaceFolder, 'logic', 'current'),
			this.loadDiagnosticsCache(workspaceFolder, 'llm', 'current')
		]);

		const diagnostics = this.deserializeDiagnostics([
			...(logicCache?.diagnostics ?? []),
			...(llmCache?.diagnostics ?? [])
		]);

		if (!diagnostics.length) {
			return;
		}

		this.publishDiagnostics(diagnostics);
	}

	public async runFullAnalysis(): Promise<void> {
		if (!vscode.workspace.workspaceFolders?.length) {
			vscode.window.showWarningMessage('Open a workspace before running Thesis Checker.');
			return;
		}

		try {
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Thesis Checker',
					cancellable: false
				},
				async (progress) => {
					progress.report({ message: 'Parsing LaTeX files...' });
					const elements = await this.parser.parseWorkspace();
					this.latestElements = elements;

					if (elements.length === 0) {
						this.diagnosticCollection.clear();
						vscode.window.showInformationMessage('No .tex files found in the workspace.');
						return;
					}

					const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
					const parseCache = workspaceFolder
						? await this.loadParseCache(workspaceFolder, 'current')
						: undefined;
					const elementCache = this.buildElementCache(elements, parseCache);
					const logicCache = workspaceFolder
						? await this.loadDiagnosticsCache(workspaceFolder, 'logic', 'current')
						: undefined;
					const llmCache = workspaceFolder
						? await this.loadDiagnosticsCache(workspaceFolder, 'llm', 'current')
						: undefined;
					const parseCacheAvailable = Boolean(parseCache?.elements);
					const logicCacheAvailable = parseCacheAvailable && Boolean(logicCache?.diagnostics?.length);
					const llmCacheAvailable = parseCacheAvailable && Boolean(llmCache?.diagnostics?.length);
					const sentenceElements = elements.filter((element) => element.type === 'sentence');
					const changedSentenceElements = elementCache.changedElements.filter(
						(element) => element.type === 'sentence'
					);
					const changedSentenceKeys = new Set(
						changedSentenceElements.map((element) => this.buildElementKey(element))
					);
					const changedCaptionKeys = new Set(
						elementCache.changedElements
							.filter((element) => element.type === 'figure' || element.type === 'table')
							.map((element) => this.buildElementKey(element))
					);
					const sectionFilesToRecheck = this.collectSectionFilesToRecheck(elementCache);
					const abbreviationStartIndex = this.findEarliestChangedSentenceIndex(
						sentenceElements,
						elementCache.unchangedKeys,
						elementCache.removedSentence
					);
					const elementKeyByLocation = this.buildElementKeyMap(elements);
					const currentKeys = new Set(Object.keys(elementCache.entries));

					progress.report({ message: 'Running logic checks...' });
					let logicDiagnostics: AnalyzerDiagnostic[] = [];
					let logicRecheckKeys = new Set<string>();
					if (logicCacheAvailable) {
						const abbreviationTargets = this.collectSentenceKeysFromIndex(
							sentenceElements,
							abbreviationStartIndex
						);
						const sectionTargets = this.collectSectionKeysForFiles(
							elements,
							sectionFilesToRecheck
						);
						logicRecheckKeys = new Set([
							...changedSentenceKeys,
							...changedCaptionKeys,
							...sectionTargets,
							...abbreviationTargets
						]);
						logicDiagnostics = this.logicAnalyzer.analyzeIncremental(elements, {
							punctuationTargets: changedSentenceKeys,
							captionTargets: changedCaptionKeys,
							abbreviationStartIndex,
							sectionFilesToRecheck,
							elementKeyFor: this.buildElementKey.bind(this)
						});
					} else {
						logicDiagnostics = this.logicAnalyzer.analyze(elements);
						logicRecheckKeys = new Set(currentKeys);
					}

					progress.report({ message: 'Running LLM analysis (if enabled)...' });
					const llmDiagnostics = await this.llmAnalyzer.analyze(changedSentenceElements);
					const unchangedSentenceKeys = new Set(
						sentenceElements
							.filter((element) => elementCache.unchangedKeys.has(this.buildElementKey(element)))
							.map((element) => this.buildElementKey(element))
					);
					const cachedLlmEntries = llmCacheAvailable
						? this.filterCachedLlmEntries(
							llmCache,
							unchangedSentenceKeys,
							currentKeys
						)
						: [];
					const cachedLogicEntries = logicCacheAvailable
						? this.filterCachedLogicEntries(logicCache, logicRecheckKeys, currentKeys)
						: [];
					const cachedLlmDiagnostics = this.deserializeDiagnostics(cachedLlmEntries);
					const cachedLogicDiagnostics = this.deserializeDiagnostics(cachedLogicEntries);

					const combinedDiagnostics = [
						...cachedLogicDiagnostics,
						...cachedLlmDiagnostics,
						...logicDiagnostics,
						...llmDiagnostics
					];

					this.publishDiagnostics(combinedDiagnostics);
					if (workspaceFolder) {
						const freshDiagnostics = this.serializeDiagnostics(
							[...logicDiagnostics, ...llmDiagnostics],
							elementKeyByLocation
						);
						await this.saveParseCache(workspaceFolder, {
							version: 1,
							generatedAt: new Date().toISOString(),
							elements: elementCache.entries
						});
						await this.saveDiagnosticsCache(workspaceFolder, 'logic', {
							version: 1,
							generatedAt: new Date().toISOString(),
							diagnostics: [
								...cachedLogicEntries,
								...freshDiagnostics.filter(
									(entry) => entry.source !== undefined && !entry.source.startsWith('LLM:')
								)
							]
						});
						await this.saveDiagnosticsCache(workspaceFolder, 'llm', {
							version: 1,
							generatedAt: new Date().toISOString(),
							diagnostics: [
								...cachedLlmEntries,
								...freshDiagnostics.filter((entry) => entry.source?.startsWith('LLM:'))
							]
						});
					}
					vscode.window.showInformationMessage(`Thesis Checker analyzed ${elements.length} elements.`);
				}
			);
		} catch (error) {
			vscode.window.showErrorMessage(`Thesis Checker failed: ${String(error)}`);
			console.error(error);
		}
	}

	public async exportStructure(): Promise<void> {
		if (!this.latestElements.length) {
			await this.runFullAnalysis();
			return;
		}

		try {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) {
				return;
			}
			const elementCache = this.buildElementCache(this.latestElements, undefined);
			await this.saveParseCache(workspaceFolder, {
				version: 1,
				generatedAt: new Date().toISOString(),
				elements: elementCache.entries
			});
			vscode.window.showInformationMessage('Thesis Checker exported the parsed JSON.');
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to export thesis structure: ${String(error)}`);
		}
	}

	private publishDiagnostics(results: AnalyzerDiagnostic[]): void {
		this.diagnosticCollection.clear();
		const grouped = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();

		for (const result of results) {
			const key = result.uri.toString();
			const entry = grouped.get(key) ?? { uri: result.uri, diagnostics: [] };
			entry.diagnostics.push(result.diagnostic);
			grouped.set(key, entry);
		}

		for (const entry of grouped.values()) {
			this.diagnosticCollection.set(entry.uri, entry.diagnostics);
		}
	}

	private buildElementCache(elements: DocumentElement[], cache?: ParseCache): ElementCacheResult {
		const entries: Record<string, CachedElement> = {};
		const changedElements: DocumentElement[] = [];
		const unchangedKeys = new Set<string>();
		const previous = cache?.elements ?? {};

		for (const element of elements) {
			const key = this.buildElementKey(element);
			const hash = this.hashContent(element.content);
			entries[key] = {
				hash,
				filePath: element.filePath,
				type: element.type,
				range: this.serializeRange(element.range),
				content: element.content,
				metadata: element.metadata ?? {}
			};

			if (previous[key]?.hash === hash) {
				unchangedKeys.add(key);
			} else {
				changedElements.push(element);
			}
		}

		const removedKeys = new Set<string>();
		const removedFiles = new Set<string>();
		let removedSentence = false;
		for (const [key, entry] of Object.entries(previous)) {
			if (entries[key]) {
				continue;
			}
			removedKeys.add(key);
			removedFiles.add(entry.filePath);
			if (entry.type === 'sentence') {
				removedSentence = true;
			}
		}

		return {
			entries,
			changedElements,
			unchangedKeys,
			removedKeys,
			removedFiles,
			removedSentence
		};
	}

	private collectSectionFilesToRecheck(cache: ElementCacheResult): Set<string> {
		const files = new Set<string>(cache.removedFiles);
		for (const element of cache.changedElements) {
			if (element.type === 'sentence' || this.isSectionType(element.type)) {
				files.add(element.filePath);
			}
		}
		return files;
	}

	private collectSectionKeysForFiles(elements: DocumentElement[], files: Set<string>): Set<string> {
		const keys = new Set<string>();
		if (!files.size) {
			return keys;
		}
		for (const element of elements) {
			if (!files.has(element.filePath)) {
				continue;
			}
			if (this.isSectionType(element.type)) {
				keys.add(this.buildElementKey(element));
			}
		}
		return keys;
	}

	private collectSentenceKeysFromIndex(sentences: DocumentElement[], startIndex?: number): Set<string> {
		const keys = new Set<string>();
		if (startIndex === undefined) {
			return keys;
		}
		for (let index = startIndex; index < sentences.length; index += 1) {
			keys.add(this.buildElementKey(sentences[index]));
		}
		return keys;
	}

	private findEarliestChangedSentenceIndex(
		sentences: DocumentElement[],
		unchangedKeys: Set<string>,
		removedSentence: boolean
	): number | undefined {
		if (removedSentence) {
			return 0;
		}
		for (let index = 0; index < sentences.length; index += 1) {
			const key = this.buildElementKey(sentences[index]);
			if (!unchangedKeys.has(key)) {
				return index;
			}
		}
		return undefined;
	}

	private isSectionType(type: DocumentElement['type']): boolean {
		return type === 'chapter' || type === 'section' || type === 'subsection' || type === 'subsubsection';
	}

	private buildElementKey(element: DocumentElement): string {
		const range = element.range;
		return `${element.filePath}:${element.type}:${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
	}

	private buildElementKeyMap(elements: DocumentElement[]): Map<string, string> {
		const map = new Map<string, string>();
		for (const element of elements) {
			map.set(this.buildLocationKey(element.filePath, element.range), this.buildElementKey(element));
		}
		return map;
	}

	private buildLocationKey(filePath: string, range: vscode.Range): string {
		return `${filePath}:${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
	}

	private hashContent(value: string): string {
		let hash = 5381;
		for (let i = 0; i < value.length; i += 1) {
			hash = ((hash << 5) + hash) + value.charCodeAt(i);
			hash |= 0;
		}
		return String(hash >>> 0);
	}

	private filterCachedLlmEntries(
		cache: DiagnosticsCache | undefined,
		unchangedKeys: Set<string>,
		currentKeys: Set<string>
	): CachedDiagnostic[] {
		if (!cache?.diagnostics?.length) {
			return [];
		}
		return cache.diagnostics.filter((entry) => {
			if (!entry.elementKey || !entry.source?.startsWith('LLM:')) {
				return false;
			}
			return currentKeys.has(entry.elementKey) && unchangedKeys.has(entry.elementKey);
		});
	}

	private filterCachedLogicEntries(
		cache: DiagnosticsCache | undefined,
		recheckKeys: Set<string>,
		currentKeys: Set<string>
	): CachedDiagnostic[] {
		if (!cache?.diagnostics?.length) {
			return [];
		}
		return cache.diagnostics.filter((entry) => {
			if (!entry.elementKey) {
				return false;
			}
			if (entry.source?.startsWith('LLM:')) {
				return false;
			}
			if (!currentKeys.has(entry.elementKey)) {
				return false;
			}
			return !recheckKeys.has(entry.elementKey);
		});
	}

	private serializeDiagnostics(
		results: AnalyzerDiagnostic[],
		elementKeyByLocation: Map<string, string>
	): CachedDiagnostic[] {
		return results.map((result) => {
			const locationKey = this.buildLocationKey(result.uri.fsPath, result.diagnostic.range);
			const elementKey = elementKeyByLocation.get(locationKey);
			const code = this.normalizeDiagnosticCode(result.diagnostic.code);
			return {
				filePath: result.uri.fsPath,
				range: this.serializeRange(result.diagnostic.range),
				message: result.diagnostic.message,
				severity: result.diagnostic.severity,
				source: result.diagnostic.source,
				code,
				elementKey
			};
		});
	}

	private deserializeDiagnostics(entries: CachedDiagnostic[]): AnalyzerDiagnostic[] {
		return entries.map((entry) => {
			const range = new vscode.Range(
				new vscode.Position(entry.range.start.line, entry.range.start.character),
				new vscode.Position(entry.range.end.line, entry.range.end.character)
			);
			const diagnostic = new vscode.Diagnostic(range, entry.message, entry.severity);
			if (entry.source) {
				diagnostic.source = entry.source;
			}
			if (entry.code !== undefined) {
				diagnostic.code = entry.code;
			}
			return {
				uri: vscode.Uri.file(entry.filePath),
				diagnostic
			};
		});
	}

	private serializeRange(range: vscode.Range): CachedRange {
		return {
			start: { line: range.start.line, character: range.start.character },
			end: { line: range.end.line, character: range.end.character }
		};
	}

	private normalizeDiagnosticCode(
		code: vscode.Diagnostic['code']
	): string | number | undefined {
		if (code === undefined) {
			return undefined;
		}
		if (typeof code === 'string' || typeof code === 'number') {
			return code;
		}
		return code.value;
	}

	private getCacheFolder(workspaceFolder: vscode.WorkspaceFolder): string {
		return path.join(workspaceFolder.uri.fsPath, '.vscode', 'thesis-checker');
	}

	private getCachePath(
		workspaceFolder: vscode.WorkspaceFolder,
		name: 'parse' | 'logic' | 'llm',
		kind: 'current' | 'prev'
	): string {
		const folderPath = this.getCacheFolder(workspaceFolder);
		return path.join(folderPath, `${name}.${kind}.json`);
	}

	private async loadParseCache(
		workspaceFolder: vscode.WorkspaceFolder,
		kind: 'current' | 'prev'
	): Promise<ParseCache | undefined> {
		const cachePath = this.getCachePath(workspaceFolder, 'parse', kind);
		try {
			const content = await fs.readFile(cachePath, 'utf8');
			return JSON.parse(content) as ParseCache;
		} catch {
			return undefined;
		}
	}

	private async saveParseCache(workspaceFolder: vscode.WorkspaceFolder, cache: ParseCache): Promise<void> {
		const folderPath = this.getCacheFolder(workspaceFolder);
		await fs.mkdir(folderPath, { recursive: true });

		const cachePath = this.getCachePath(workspaceFolder, 'parse', 'current');
		const prevPath = this.getCachePath(workspaceFolder, 'parse', 'prev');
		try {
			await fs.copyFile(cachePath, prevPath);
		} catch {
			// Ignore when cache does not exist yet.
		}
		await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf8');
	}

	private async loadDiagnosticsCache(
		workspaceFolder: vscode.WorkspaceFolder,
		name: 'logic' | 'llm',
		kind: 'current' | 'prev'
	): Promise<DiagnosticsCache | undefined> {
		const cachePath = this.getCachePath(workspaceFolder, name, kind);
		try {
			const content = await fs.readFile(cachePath, 'utf8');
			return JSON.parse(content) as DiagnosticsCache;
		} catch {
			return undefined;
		}
	}

	private async saveDiagnosticsCache(
		workspaceFolder: vscode.WorkspaceFolder,
		name: 'logic' | 'llm',
		cache: DiagnosticsCache
	): Promise<void> {
		const folderPath = this.getCacheFolder(workspaceFolder);
		await fs.mkdir(folderPath, { recursive: true });

		const cachePath = this.getCachePath(workspaceFolder, name, 'current');
		const prevPath = this.getCachePath(workspaceFolder, name, 'prev');
		try {
			await fs.copyFile(cachePath, prevPath);
		} catch {
			// Ignore when cache does not exist yet.
		}
		await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf8');
	}
	public dispose(): void {
		this.statusBarItem.dispose();
	}
}

interface CachedRange {
	start: { line: number; character: number };
	end: { line: number; character: number };
}

interface ElementCacheResult {
	entries: Record<string, CachedElement>;
	changedElements: DocumentElement[];
	unchangedKeys: Set<string>;
	removedKeys: Set<string>;
	removedFiles: Set<string>;
	removedSentence: boolean;
}

interface CachedElement {
	hash: string;
	filePath: string;
	type: DocumentElement['type'];
	range: CachedRange;
	content: string;
	metadata: Record<string, unknown>;
}

interface CachedDiagnostic {
	filePath: string;
	range: CachedRange;
	message: string;
	severity: number;
	source?: string;
	code?: string | number;
	elementKey?: string;
}

interface ParseCache {
	version: number;
	generatedAt: string;
	elements: Record<string, CachedElement>;
}

interface DiagnosticsCache {
	version: number;
	generatedAt: string;
	diagnostics: CachedDiagnostic[];
}
