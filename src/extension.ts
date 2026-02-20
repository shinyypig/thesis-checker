import * as vscode from "vscode";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { DocumentParser } from "./parser/documentParser";
import { LogicAnalyzer } from "./analyzers/logicAnalyzer";
import { LLMAnalyzer } from "./analyzers/llmAnalyzer";
import { AnalyzerDiagnostic, DocumentElement } from "./types";

const CACHE_VERSION = 2;

export function activate(context: vscode.ExtensionContext) {
    const diagnostics =
        vscode.languages.createDiagnosticCollection("thesis-checker");
    context.subscriptions.push(diagnostics);

    const controller = new ThesisCheckerController(diagnostics);
    context.subscriptions.push(controller);

    void controller.restoreDiagnostics();

    context.subscriptions.push(
        vscode.commands.registerCommand("thesis-checker.scanWorkspace", () =>
            controller.runFullAnalysis()
        ),
        vscode.commands.registerCommand("thesis-checker.parseWorkspace", () =>
            controller.runFullAnalysis({ mode: "parse" })
        ),
        vscode.commands.registerCommand(
            "thesis-checker.parseWorkspaceRescan",
            () => controller.runFullAnalysis({ mode: "parse", force: true })
        ),
        vscode.commands.registerCommand("thesis-checker.runLogicAnalyzer", () =>
            controller.runFullAnalysis({ mode: "logic" })
        ),
        vscode.commands.registerCommand("thesis-checker.runLlmAnalyzer", () =>
            controller.runFullAnalysis({ mode: "llm" })
        ),
        vscode.commands.registerCommand("thesis-checker.rescanWorkspace", () =>
            controller.runFullAnalysis({ force: true, mode: "full" })
        ),
        vscode.commands.registerCommand("thesis-checker.exportStructure", () =>
            controller.exportStructure()
        )
    );
}

export function deactivate() {
    // Nothing to clean up for now.
}

class ThesisCheckerController implements vscode.Disposable {
    private readonly parser = new DocumentParser();
    private readonly logicAnalyzer = new LogicAnalyzer();
    private readonly llmAnalyzer = new LLMAnalyzer();
    private readonly statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    private latestElements: DocumentElement[] = [];
    private elementKeyCache: Map<DocumentElement, string> | null = null;

    constructor(
        private readonly diagnosticCollection: vscode.DiagnosticCollection
    ) {
        this.statusBarItem.command = "thesis-checker.scanWorkspace";
        this.statusBarItem.text = "Thesis Checker";
        this.statusBarItem.tooltip = "Run thesis checks";
        this.statusBarItem.show();
    }

    public async restoreDiagnostics(): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return;
        }

        const [logicCache, llmCache] = await Promise.all([
            this.loadDiagnosticsCache(workspaceFolder, "logic", "current"),
            this.loadDiagnosticsCache(workspaceFolder, "llm", "current"),
        ]);

        const diagnostics = this.deserializeDiagnostics([
            ...(logicCache?.diagnostics ?? []),
            ...(llmCache?.diagnostics ?? []),
        ]);

        if (!diagnostics.length) {
            return;
        }

        this.publishDiagnostics(diagnostics);
    }

    public async runFullAnalysis(options?: {
        force?: boolean;
        mode?: AnalysisMode;
    }): Promise<void> {
        if (!vscode.workspace.workspaceFolders?.length) {
            vscode.window.showWarningMessage(
                "Open a workspace before running Thesis Checker."
            );
            return;
        }

        try {
            const force = Boolean(options?.force);
            const mode = options?.mode ?? "full";
            const runLogic = mode === "full" || mode === "logic";
            const runLlm = mode === "full" || mode === "llm";
            const parseOnly = mode === "parse";

            if (force) {
                this.diagnosticCollection.clear();
            }
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: "Thesis Checker",
                    cancellable: false,
                },
                async (progress) => {
                    progress.report({ message: "Parsing LaTeX files..." });
                    const elements = await this.parser.parseWorkspace();
                    this.latestElements = elements;
                    this.elementKeyCache = this.buildElementKeyCache(elements);

                    if (elements.length === 0) {
                        this.diagnosticCollection.clear();
                        vscode.window.showInformationMessage(
                            "No .tex files found in the workspace."
                        );
                        return;
                    }

                    const workspaceFolder =
                        vscode.workspace.workspaceFolders?.[0];
                    if (workspaceFolder && force) {
                        await this.clearAllCaches(workspaceFolder);
                    }
                    const parseCache =
                        workspaceFolder && !force
                            ? await this.loadParseCache(
                                  workspaceFolder,
                                  "current"
                              )
                            : undefined;
                    const elementCache = this.buildElementCache(
                        elements,
                        parseCache
                    );
                    let logicCache: DiagnosticsCache | undefined;
                    if (workspaceFolder && !force) {
                        if (runLogic) {
                            await this.promoteDiagnosticsCache(
                                workspaceFolder,
                                "logic"
                            );
                            logicCache = await this.loadDiagnosticsCache(
                                workspaceFolder,
                                "logic",
                                "prev"
                            );
                        } else {
                            logicCache = await this.loadDiagnosticsCache(
                                workspaceFolder,
                                "logic",
                                "current"
                            );
                        }
                    }
                    let llmCache: DiagnosticsCache | undefined;
                    if (workspaceFolder && !force) {
                        if (runLlm) {
                            await this.promoteDiagnosticsCache(
                                workspaceFolder,
                                "llm"
                            );
                            llmCache = await this.loadDiagnosticsCache(
                                workspaceFolder,
                                "llm",
                                "prev"
                            );
                        } else {
                            llmCache = await this.loadDiagnosticsCache(
                                workspaceFolder,
                                "llm",
                                "current"
                            );
                        }
                    }
                    const parseCacheAvailable = Boolean(parseCache?.elements);
                    const logicBaselineKeys =
                        this.collectBaselineKeys(logicCache);
                    const llmBaselineKeys = this.collectBaselineKeys(llmCache);
                    const logicCacheAvailable =
                        !force && logicBaselineKeys.size > 0;
                    const llmCacheAvailable =
                        !force && llmBaselineKeys.size > 0;
                    const incrementalSummary = parseCacheAvailable
                        ? this.formatIncrementalSummary(elementCache)
                        : undefined;
                    const sentenceElements = elements.filter(
                        (element) => element.type === "sentence"
                    );
                    const currentSentenceKeys = new Set(
                        sentenceElements.map((element) =>
                            this.buildElementKey(element)
                        )
                    );
                    const currentKeys = new Set(
                        Object.keys(elementCache.entries)
                    );
                    const elementKeyByLocation =
                        this.buildElementKeyMap(elements);
                    const llmRecheckKeys = runLlm
                        ? llmCacheAvailable
                            ? this.collectRecheckKeys(
                                  currentSentenceKeys,
                                  llmBaselineKeys
                              )
                            : new Set(currentSentenceKeys)
                        : new Set<string>();
                    const llmTargets = runLlm
                        ? sentenceElements
                              .filter((element) =>
                                  llmRecheckKeys.has(
                                      this.buildElementKey(element)
                                  )
                              )
                        : [];
                    const llmReviewKeys = new Set(
                        llmTargets.map((element) =>
                            this.buildElementKey(element)
                        )
                    );
                    let changedSentenceKeys = new Set<string>();
                    let changedCaptionKeys = new Set<string>();
                    let sectionFilesToRecheck = new Set<string>();
                    let abbreviationStartIndex: number | undefined;
                    let logicHasRemovals = false;
                    if (logicCacheAvailable) {
                        changedSentenceKeys = this.collectChangedSentenceKeys(
                            sentenceElements,
                            logicBaselineKeys
                        );
                        changedCaptionKeys = this.collectChangedCaptionKeys(
                            elements,
                            logicBaselineKeys
                        );
                        logicHasRemovals = this.hasRemovedKeys(
                            currentKeys,
                            logicBaselineKeys
                        );
                        abbreviationStartIndex =
                            this.findEarliestChangedSentenceIndex(
                                sentenceElements,
                                logicBaselineKeys,
                                logicHasRemovals
                            );
                        sectionFilesToRecheck =
                            this.collectSectionFilesForLogic(
                                elements,
                                logicBaselineKeys,
                                changedSentenceKeys,
                                logicHasRemovals
                            );
                    }

                    if (workspaceFolder) {
                        await this.saveParseCache(workspaceFolder, {
                            version: CACHE_VERSION,
                            generatedAt: new Date().toISOString(),
                            elements: elementCache.entries,
                        });
                    }

                    if (parseOnly) {
                        const message = incrementalSummary
                            ? `Thesis Checker parsed ${elements.length} elements. ${incrementalSummary}.`
                            : `Thesis Checker parsed ${elements.length} elements.`;
                        vscode.window.showInformationMessage(message);
                        return;
                    }

                    if (runLogic) {
                        progress.report({ message: "Running logic checks..." });
                    }
                    let logicDiagnostics: AnalyzerDiagnostic[] = [];
                    let logicRecheckKeys = new Set<string>();
                    let logicAnalyzedCount = 0;
                    if (logicCacheAvailable) {
                        if (runLogic) {
                            const abbreviationTargets =
                                this.collectSentenceKeysFromIndex(
                                    sentenceElements,
                                    abbreviationStartIndex
                                );
                            const sectionTargets =
                                this.collectSectionKeysForFiles(
                                    elements,
                                    sectionFilesToRecheck
                                );
                            logicRecheckKeys = new Set([
                                ...changedSentenceKeys,
                                ...changedCaptionKeys,
                                ...sectionTargets,
                                ...abbreviationTargets,
                            ]);
                            logicDiagnostics =
                                this.logicAnalyzer.analyzeIncremental(
                                    elements,
                                    {
                                        punctuationTargets: changedSentenceKeys,
                                        captionTargets: changedCaptionKeys,
                                        abbreviationStartIndex,
                                        sectionFilesToRecheck,
                                        elementKeyFor:
                                            this.buildElementKey.bind(this),
                                    }
                                );
                            logicAnalyzedCount = logicRecheckKeys.size;
                        } else {
                            logicRecheckKeys = new Set<string>();
                        }
                    } else if (runLogic) {
                        logicDiagnostics = this.logicAnalyzer.analyze(elements);
                        logicRecheckKeys = new Set(currentKeys);
                        logicAnalyzedCount = currentKeys.size;
                    } else {
                        logicRecheckKeys = new Set<string>();
                    }

                    if (runLlm) {
                        progress.report({
                            message: "Running LLM analysis ...",
                        });
                    }
                    const cachedLlmEntries = llmCacheAvailable
                        ? this.filterCachedLlmEntries(
                              llmCache,
                              llmReviewKeys,
                              currentSentenceKeys
                          )
                        : [];
                    let llmDebugWrite = Promise.resolve();
                    const llmDebugFolder =
                        runLlm && workspaceFolder
                            ? this.getCacheFolder(workspaceFolder)
                            : undefined;
                    const llmDebugPath = llmDebugFolder
                        ? path.join(llmDebugFolder, "llm.debug.jsonl")
                        : undefined;
                    if (llmDebugPath && llmDebugFolder) {
                        llmDebugWrite = fs
                            .mkdir(llmDebugFolder, {
                                recursive: true,
                            })
                            .then(() => fs.writeFile(llmDebugPath, "", "utf8"))
                            .catch((error) => {
                                console.error(
                                    "Failed to initialize LLM debug log:",
                                    error
                                );
                            });
                    }
                    const appendLlmDebug = (entry: Record<string, unknown>) => {
                        if (!llmDebugPath) {
                            return;
                        }
                        const line = `${JSON.stringify(entry)}\n`;
                        llmDebugWrite = llmDebugWrite
                            .then(() => fs.appendFile(llmDebugPath, line, "utf8"))
                            .catch((error) => {
                                console.error(
                                    "Failed to write LLM debug log:",
                                    error
                                );
                            });
                    };
                    let llmSnapshotWrite = Promise.resolve();
                    const saveLlmSnapshot = (items: AnalyzerDiagnostic[]) => {
                        if (!workspaceFolder) {
                            return;
                        }
                        const snapshotDiagnostics = this.serializeDiagnostics(
                            items,
                            elementKeyByLocation
                        );
                        const snapshotCache: DiagnosticsCache = {
                            version: CACHE_VERSION,
                            generatedAt: new Date().toISOString(),
                            diagnostics: [
                                ...cachedLlmEntries,
                                ...snapshotDiagnostics,
                            ],
                            elementKeys: [...currentSentenceKeys],
                        };
                        llmSnapshotWrite = llmSnapshotWrite
                            .then(() =>
                                this.saveDiagnosticsCache(
                                    workspaceFolder,
                                    "llm",
                                    snapshotCache
                                )
                            )
                            .catch((error) => {
                                console.error(
                                    "Failed to save LLM snapshot:",
                                    error
                                );
                            });
                    };
                    const cachedLogicEntries = logicCacheAvailable
                        ? this.filterCachedLogicEntries(
                              logicCache,
                              logicRecheckKeys,
                              currentKeys
                          )
                        : [];
                    const cachedLlmDiagnostics = this.deserializeDiagnostics(
                        cachedLlmEntries,
                        elementCache.entries
                    );
                    const cachedLogicDiagnostics = this.deserializeDiagnostics(
                        cachedLogicEntries,
                        elementCache.entries
                    );
                    const baseDiagnostics = [
                        ...cachedLogicDiagnostics,
                        ...cachedLlmDiagnostics,
                        ...logicDiagnostics,
                    ];
                    const streamingLlmDiagnostics: AnalyzerDiagnostic[] = [];
                    const llmDiagnostics = runLlm
                        ? await this.llmAnalyzer.analyze(llmTargets, {
                              progress,
                              onDiagnostics: (items) => {
                                  streamingLlmDiagnostics.push(...items);
                                  this.publishDiagnostics([
                                      ...baseDiagnostics,
                                      ...streamingLlmDiagnostics,
                                  ]);
                                  saveLlmSnapshot(streamingLlmDiagnostics);
                              },
                              onDebug: (result, element) => {
								appendLlmDebug({
									timestamp: new Date().toISOString(),
									providerId: result.providerId,
									filePath: element.filePath,
									range: this.serializeRange(element.range),
									elementKey: this.buildElementKey(element),
									content: element.content,
									prompt: result.prompt,
									response: result.response,
									issues: result.review?.issues ?? [],
									rewrite: result.review?.rewrite,
								});
							},
                          })
                        : [];
                    const llmAnalyzedCount = runLlm ? llmTargets.length : 0;

                    const combinedDiagnostics = [
                        ...baseDiagnostics,
                        ...llmDiagnostics,
                    ];

                    this.publishDiagnostics(combinedDiagnostics);
                    if (workspaceFolder) {
                        const freshDiagnostics = this.serializeDiagnostics(
                            [...logicDiagnostics, ...llmDiagnostics],
                            elementKeyByLocation
                        );
                        if (runLogic) {
                            await this.saveDiagnosticsCache(
                                workspaceFolder,
                                "logic",
                                {
                                    version: CACHE_VERSION,
                                    generatedAt: new Date().toISOString(),
                                    diagnostics: [
                                        ...cachedLogicEntries,
                                        ...freshDiagnostics.filter(
                                            (entry) =>
                                                entry.source !== undefined &&
                                                !entry.source.startsWith("LLM:")
                                        ),
                                    ],
                                    elementKeys: [...currentKeys],
                                }
                            );
                        }
                        if (runLlm) {
                            await this.saveDiagnosticsCache(
                                workspaceFolder,
                                "llm",
                                {
                                    version: CACHE_VERSION,
                                    generatedAt: new Date().toISOString(),
                                    diagnostics: [
                                        ...cachedLlmEntries,
                                        ...freshDiagnostics.filter((entry) =>
                                            entry.source?.startsWith("LLM:")
                                        ),
                                    ],
                                    elementKeys: [...currentSentenceKeys],
                                }
                            );
                        }
                    }
                    const message =
                        mode === "logic"
                            ? "Thesis Checker finished logic analysis."
                            : mode === "llm"
                            ? "Thesis Checker finished LLM analysis."
                            : "Thesis Checker analyzed elements.";
                    const summary =
                        mode === "logic"
                            ? this.formatAnalyzedSummary(logicAnalyzedCount)
                            : mode === "llm"
                            ? this.formatAnalyzedSummary(llmAnalyzedCount)
                            : incrementalSummary;
                    const suffix = summary ? ` ${summary}.` : "";
                    vscode.window.showInformationMessage(`${message}${suffix}`);
                }
            );
        } catch (error) {
            vscode.window.showErrorMessage(
                `Thesis Checker failed: ${String(error)}`
            );
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
            this.elementKeyCache = this.buildElementKeyCache(
                this.latestElements
            );
            const elementCache = this.buildElementCache(
                this.latestElements,
                undefined
            );
            await this.saveParseCache(workspaceFolder, {
                version: CACHE_VERSION,
                generatedAt: new Date().toISOString(),
                elements: elementCache.entries,
            });
            vscode.window.showInformationMessage(
                "Thesis Checker exported the parsed JSON."
            );
        } catch (error) {
            vscode.window.showErrorMessage(
                `Failed to export thesis structure: ${String(error)}`
            );
        }
    }

    private publishDiagnostics(results: AnalyzerDiagnostic[]): void {
        this.diagnosticCollection.clear();
        const grouped = new Map<
            string,
            { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }
        >();

        for (const result of results) {
            const key = result.uri.toString();
            const entry = grouped.get(key) ?? {
                uri: result.uri,
                diagnostics: [],
            };
            entry.diagnostics.push(result.diagnostic);
            grouped.set(key, entry);
        }

        for (const entry of grouped.values()) {
            this.diagnosticCollection.set(entry.uri, entry.diagnostics);
        }
    }

    private formatIncrementalSummary(cache: ElementCacheResult): string {
        const added = cache.newKeys.size;
        const deleted = cache.removedKeys.size;
        return `${added} added, ${deleted} deleted`;
    }

    private formatAnalyzedSummary(count: number): string {
        const label = count === 1 ? "item" : "items";
        return `${count} ${label} analyzed`;
    }

    private buildElementCache(
        elements: DocumentElement[],
        cache?: ParseCache
    ): ElementCacheResult {
        const entries: Record<string, CachedElement> = {};
        const unchangedKeys = new Set<string>();
        const newKeys = new Set<string>();
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
                metadata: element.metadata ?? {},
            };

            if (!previous[key]) {
                newKeys.add(key);
            } else if (previous[key]?.hash === hash) {
                unchangedKeys.add(key);
            }
        }

        const removedKeys = new Set<string>();
        let removedSentence = false;
        for (const [key, entry] of Object.entries(previous)) {
            if (entries[key]) {
                continue;
            }
            removedKeys.add(key);
            if (entry.type === "sentence") {
                removedSentence = true;
            }
        }

        return {
            entries,
            unchangedKeys,
            newKeys,
            removedKeys,
            removedSentence,
        };
    }

    private collectChangedSentenceKeys(
        sentences: DocumentElement[],
        baselineKeys: Set<string>
    ): Set<string> {
        const keys = new Set<string>();
        for (const element of sentences) {
            const key = this.buildElementKey(element);
            if (!baselineKeys.has(key)) {
                keys.add(key);
            }
        }
        return keys;
    }

    private collectChangedCaptionKeys(
        elements: DocumentElement[],
        baselineKeys: Set<string>
    ): Set<string> {
        const keys = new Set<string>();
        for (const element of elements) {
            if (element.type !== "figure" && element.type !== "table") {
                continue;
            }
            const key = this.buildElementKey(element);
            if (!baselineKeys.has(key)) {
                keys.add(key);
            }
        }
        return keys;
    }

    private collectSectionFilesForLogic(
        elements: DocumentElement[],
        baselineKeys: Set<string>,
        changedSentenceKeys: Set<string>,
        hasRemovals: boolean
    ): Set<string> {
        const files = new Set<string>();
        if (hasRemovals) {
            for (const element of elements) {
                if (this.isSectionType(element.type)) {
                    files.add(element.filePath);
                }
            }
            return files;
        }
        for (const element of elements) {
            if (element.type === "sentence") {
                const key = this.buildElementKey(element);
                if (changedSentenceKeys.has(key)) {
                    files.add(element.filePath);
                }
                continue;
            }
            if (this.isSectionType(element.type)) {
                const key = this.buildElementKey(element);
                if (!baselineKeys.has(key)) {
                    files.add(element.filePath);
                }
            }
        }
        return files;
    }

    private hasRemovedKeys(
        currentKeys: Set<string>,
        baselineKeys: Set<string>
    ): boolean {
        for (const key of baselineKeys) {
            if (!currentKeys.has(key)) {
                return true;
            }
        }
        return false;
    }

    private collectSectionKeysForFiles(
        elements: DocumentElement[],
        files: Set<string>
    ): Set<string> {
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

    private collectSentenceKeysFromIndex(
        sentences: DocumentElement[],
        startIndex?: number
    ): Set<string> {
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

    private isSectionType(type: DocumentElement["type"]): boolean {
        return (
            type === "chapter" ||
            type === "section" ||
            type === "subsection" ||
            type === "subsubsection"
        );
    }

    private buildElementKey(element: DocumentElement): string {
        const cached = this.elementKeyCache?.get(element);
        if (cached) {
            return cached;
        }
        const hash = this.hashContent(element.content);
        return `${element.filePath}:${element.type}:${hash}:0`;
    }

    private buildElementKeyCache(
        elements: DocumentElement[]
    ): Map<DocumentElement, string> {
        const counts = new Map<string, number>();
        const map = new Map<DocumentElement, string>();
        for (const element of elements) {
            const hash = this.hashContent(element.content);
            const base = `${element.filePath}:${element.type}:${hash}`;
            const index = counts.get(base) ?? 0;
            counts.set(base, index + 1);
            map.set(element, `${base}:${index}`);
        }
        return map;
    }

    private buildElementKeyMap(
        elements: DocumentElement[]
    ): Map<string, string> {
        const map = new Map<string, string>();
        for (const element of elements) {
            map.set(
                this.buildLocationKey(element.filePath, element.range),
                this.buildElementKey(element)
            );
        }
        return map;
    }

    private buildLocationKey(filePath: string, range: vscode.Range): string {
        return `${filePath}:${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
    }

    private hashContent(value: string): string {
        let hash = 5381;
        for (let i = 0; i < value.length; i += 1) {
            hash = (hash << 5) + hash + value.charCodeAt(i);
            hash |= 0;
        }
        return String(hash >>> 0);
    }

    private filterCachedLlmEntries(
        cache: DiagnosticsCache | undefined,
        recheckKeys: Set<string>,
        currentKeys: Set<string>
    ): CachedDiagnostic[] {
        if (!cache?.diagnostics?.length) {
            return [];
        }
        return cache.diagnostics.filter((entry) => {
            if (!entry.elementKey || !entry.source?.startsWith("LLM:")) {
                return false;
            }
            if (!currentKeys.has(entry.elementKey)) {
                return false;
            }
            return !recheckKeys.has(entry.elementKey);
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
            if (entry.source?.startsWith("LLM:")) {
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
            const locationKey = this.buildLocationKey(
                result.uri.fsPath,
                result.diagnostic.range
            );
            const elementKey = elementKeyByLocation.get(locationKey);
            const code = this.normalizeDiagnosticCode(result.diagnostic.code);
            return {
                filePath: result.uri.fsPath,
                range: this.serializeRange(result.diagnostic.range),
                message: result.diagnostic.message,
                severity: result.diagnostic.severity,
                source: result.diagnostic.source,
                code,
                elementKey,
            };
        });
    }

    private collectBaselineKeys(
        cache: DiagnosticsCache | undefined
    ): Set<string> {
        const keys = new Set<string>();
        if (!cache) {
            return keys;
        }
        if (Array.isArray(cache.elementKeys)) {
            for (const key of cache.elementKeys) {
                keys.add(key);
            }
            return keys;
        }
        for (const entry of cache.diagnostics ?? []) {
            if (entry.elementKey) {
                keys.add(entry.elementKey);
            }
        }
        return keys;
    }

    private collectRecheckKeys(
        currentKeys: Set<string>,
        baselineKeys: Set<string>
    ): Set<string> {
        const recheck = new Set<string>();
        for (const key of currentKeys) {
            if (!baselineKeys.has(key)) {
                recheck.add(key);
            }
        }
        return recheck;
    }

    private deserializeDiagnostics(
        entries: CachedDiagnostic[],
        elementCache?: Record<string, CachedElement>
    ): AnalyzerDiagnostic[] {
        return entries.map((entry) => {
            const cachedElement = entry.elementKey
                ? elementCache?.[entry.elementKey]
                : undefined;
            const rangeSource = cachedElement?.range ?? entry.range;
            const range = new vscode.Range(
                new vscode.Position(
                    rangeSource.start.line,
                    rangeSource.start.character
                ),
                new vscode.Position(
                    rangeSource.end.line,
                    rangeSource.end.character
                )
            );
            const diagnostic = new vscode.Diagnostic(
                range,
                entry.message,
                entry.severity
            );
            if (entry.source) {
                diagnostic.source = entry.source;
            }
            if (entry.code !== undefined) {
                diagnostic.code = entry.code;
            }
            return {
                uri: vscode.Uri.file(entry.filePath),
                diagnostic,
            };
        });
    }

    private serializeRange(range: vscode.Range): CachedRange {
        return {
            start: { line: range.start.line, character: range.start.character },
            end: { line: range.end.line, character: range.end.character },
        };
    }

    private normalizeDiagnosticCode(
        code: vscode.Diagnostic["code"]
    ): string | number | undefined {
        if (code === undefined) {
            return undefined;
        }
        if (typeof code === "string" || typeof code === "number") {
            return code;
        }
        return code.value;
    }

    private getCacheFolder(workspaceFolder: vscode.WorkspaceFolder): string {
        return path.join(
            workspaceFolder.uri.fsPath,
            ".vscode",
            "thesis-checker"
        );
    }

    private getCachePath(
        workspaceFolder: vscode.WorkspaceFolder,
        name: "parse" | "logic" | "llm",
        kind: "current" | "prev"
    ): string {
        const folderPath = this.getCacheFolder(workspaceFolder);
        return path.join(folderPath, `${name}.${kind}.json`);
    }

    private getLlmDebugPath(workspaceFolder: vscode.WorkspaceFolder): string {
        return path.join(this.getCacheFolder(workspaceFolder), "llm.debug.jsonl");
    }

    private async clearAllCaches(
        workspaceFolder: vscode.WorkspaceFolder
    ): Promise<void> {
        const targets: Array<
            [cache: "parse" | "logic" | "llm", kind: "current" | "prev"]
        > = [
            ["parse", "current"],
            ["parse", "prev"],
            ["logic", "current"],
            ["logic", "prev"],
            ["llm", "current"],
            ["llm", "prev"],
        ];
        await Promise.all(
            targets.map(([name, kind]) =>
                fs.rm(this.getCachePath(workspaceFolder, name, kind), {
                    force: true,
                })
            )
        );
        await fs.rm(this.getLlmDebugPath(workspaceFolder), { force: true });
    }

    private async loadParseCache(
        workspaceFolder: vscode.WorkspaceFolder,
        kind: "current" | "prev"
    ): Promise<ParseCache | undefined> {
        const cachePath = this.getCachePath(workspaceFolder, "parse", kind);
        try {
            const content = await fs.readFile(cachePath, "utf8");
            const parsed = JSON.parse(content) as ParseCache;
            if (parsed.version !== CACHE_VERSION) {
                return undefined;
            }
            return parsed;
        } catch {
            return undefined;
        }
    }

    private async saveParseCache(
        workspaceFolder: vscode.WorkspaceFolder,
        cache: ParseCache
    ): Promise<void> {
        const folderPath = this.getCacheFolder(workspaceFolder);
        await fs.mkdir(folderPath, { recursive: true });

        const cachePath = this.getCachePath(
            workspaceFolder,
            "parse",
            "current"
        );
        const prevPath = this.getCachePath(workspaceFolder, "parse", "prev");
        try {
            await fs.copyFile(cachePath, prevPath);
        } catch {
            // Ignore when cache does not exist yet.
        }
        await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), "utf8");
    }

    private async loadDiagnosticsCache(
        workspaceFolder: vscode.WorkspaceFolder,
        name: "logic" | "llm",
        kind: "current" | "prev"
    ): Promise<DiagnosticsCache | undefined> {
        const cachePath = this.getCachePath(workspaceFolder, name, kind);
        try {
            const content = await fs.readFile(cachePath, "utf8");
            const parsed = JSON.parse(content) as DiagnosticsCache;
            if (parsed.version !== CACHE_VERSION) {
                return undefined;
            }
            return parsed;
        } catch {
            return undefined;
        }
    }

    private async saveDiagnosticsCache(
        workspaceFolder: vscode.WorkspaceFolder,
        name: "logic" | "llm",
        cache: DiagnosticsCache
    ): Promise<void> {
        const folderPath = this.getCacheFolder(workspaceFolder);
        await fs.mkdir(folderPath, { recursive: true });

        const cachePath = this.getCachePath(workspaceFolder, name, "current");
        const prevPath = this.getCachePath(workspaceFolder, name, "prev");
        try {
            await fs.copyFile(cachePath, prevPath);
        } catch {
            // Ignore when cache does not exist yet.
        }
        await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), "utf8");
    }

    private async promoteDiagnosticsCache(
        workspaceFolder: vscode.WorkspaceFolder,
        name: "logic" | "llm"
    ): Promise<void> {
        const currentPath = this.getCachePath(workspaceFolder, name, "current");
        const prevPath = this.getCachePath(workspaceFolder, name, "prev");
        try {
            await fs.copyFile(currentPath, prevPath);
        } catch {
            // Ignore when cache does not exist yet.
        }
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
    unchangedKeys: Set<string>;
    newKeys: Set<string>;
    removedKeys: Set<string>;
    removedSentence: boolean;
}

interface CachedElement {
    hash: string;
    filePath: string;
    type: DocumentElement["type"];
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
    elementKeys?: string[];
}

type AnalysisMode = "full" | "parse" | "logic" | "llm";
