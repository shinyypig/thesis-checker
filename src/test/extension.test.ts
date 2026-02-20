import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { LogicAnalyzer } from '../analyzers/logicAnalyzer';
import { DocumentElement } from '../types';

suite('Thesis Checker Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Logic analyzer flags missing punctuation', () => {
		const analyzer = new LogicAnalyzer();
		const element: DocumentElement = {
			type: 'sentence',
			content: 'This sentence misses punctuation',
			filePath: '/tmp/sample.tex',
			range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 10))
		};

		const diagnostics = analyzer.analyze([element]);
		assert.ok(
			diagnostics.some((entry) => entry.diagnostic.message.includes('句末标点')),
			'Expected punctuation diagnostic to be emitted.'
		);
	});

	test('Acronym without definition is flagged with guidance message', () => {
		const analyzer = new LogicAnalyzer();
		const element: DocumentElement = {
			type: 'sentence',
			content: 'CNN 模型广泛应用。',
			filePath: '/tmp/acronym.tex',
			range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 8))
		};

		const diagnostics = analyzer.analyze([element]);
		assert.ok(
			diagnostics.some(
				(entry) =>
					entry.diagnostic.code === 'ACRONYM_FIRST_USE' &&
					/缩写.*首次出现.*应当给出全称/.test(entry.diagnostic.message)
			),
			'Expected missing acronym definition diagnostic.'
		);
	});

	test('Inline acronym definition is accepted', () => {
		const analyzer = new LogicAnalyzer();
		const element: DocumentElement = {
			type: 'sentence',
			content: 'Machine Learning (ML) techniques are evaluated.',
			filePath: '/tmp/acronym-defined.tex',
			range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 20))
		};

		const diagnostics = analyzer.analyze([element]);
		const acronymDiagnostics = diagnostics.filter((entry) => entry.diagnostic.code === 'ACRONYM_FIRST_USE');
		assert.strictEqual(acronymDiagnostics.length, 0, 'Inline acronym definition should not trigger warnings.');
	});

	test('Workspace parse command produces structured cache output', async () => {
		let workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			const repoRoot = path.resolve(__dirname, '..', '..');
			vscode.workspace.updateWorkspaceFolders(0, 0, { uri: vscode.Uri.file(repoRoot) });
			await delay(1000);
			workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		}
		assert.ok(workspaceFolder, 'Workspace folder should be defined for integration test.');
		const outputDir = path.join(workspaceFolder.uri.fsPath, '.vscode', 'thesis-checker');
		const cacheFile = path.join(outputDir, 'parse.current.json');
		await fs.rm(cacheFile, { force: true });

		await vscode.commands.executeCommand('thesis-checker.parseWorkspaceRescan');

		const raw = await fs.readFile(cacheFile, 'utf8');
		const parsed = JSON.parse(raw) as {
			elements?: Record<string, { type: string; content: string; filePath: string }>;
		};
		const data = Object.values(parsed.elements ?? {});
		assert.ok(data.length > 0, 'Expected structured data from parser.');

		// Log a quick preview to help manual inspection when running the test suite.
		const preview = data
			.slice(0, 5)
			.map((entry) => {
				const file = path.relative(workspaceFolder.uri.fsPath, entry.filePath);
				return `${entry.type.padEnd(10)} | ${file} | ${entry.content.slice(0, 40)}`;
			});
		console.log('Thesis Checker sample output:\n' + preview.join('\n'));

		const hasTestThesisContent = data.some((entry) => {
			const relative = path.relative(workspaceFolder.uri.fsPath, entry.filePath);
			return relative.split(path.sep)[0] === 'test_thesis';
		});
		assert.ok(hasTestThesisContent, 'Structured output should include entries from test_thesis.');
	});
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
