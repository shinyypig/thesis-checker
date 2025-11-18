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

					await this.writeStructure(elements);

					progress.report({ message: 'Running logic checks...' });
					const logicDiagnostics = this.logicAnalyzer.analyze(elements);

					progress.report({ message: 'Running LLM analysis (if enabled)...' });
					const llmDiagnostics = await this.llmAnalyzer.analyze(elements);

					this.publishDiagnostics([...logicDiagnostics, ...llmDiagnostics]);
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
			await this.writeStructure(this.latestElements);
			vscode.window.showInformationMessage('Thesis Checker exported the structured JSON.');
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

	private async writeStructure(elements: DocumentElement[]): Promise<void> {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			return;
		}

		const folderPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'thesis-checker');
		await fs.mkdir(folderPath, { recursive: true });

		const payload = elements.map((element) => ({
			type: element.type,
			content: element.content,
			file: path.relative(workspaceFolder.uri.fsPath, element.filePath) || path.basename(element.filePath),
			range: {
				start: { line: element.range.start.line, character: element.range.start.character },
				end: { line: element.range.end.line, character: element.range.end.character }
			},
			metadata: element.metadata ?? {}
		}));

		const targetFile = path.join(folderPath, 'cache.json');
		await fs.writeFile(targetFile, JSON.stringify(payload, null, 2), 'utf8');
	}
	public dispose(): void {
		this.statusBarItem.dispose();
	}
}
