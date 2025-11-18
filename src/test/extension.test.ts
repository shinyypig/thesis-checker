import * as assert from 'assert';
import * as vscode from 'vscode';
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
			diagnostics.some((entry) => entry.diagnostic.message.includes('punctuation')),
			'Expected punctuation diagnostic to be emitted.'
		);
	});

	test('Acronym without definition is flagged with guidance message', () => {
		const analyzer = new LogicAnalyzer();
		const element: DocumentElement = {
			type: 'sentence',
			content: 'ML 模型广泛应用。',
			filePath: '/tmp/acronym.tex',
			range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 8))
		};

		const diagnostics = analyzer.analyze([element]);
		assert.ok(
			diagnostics.some(
				(entry) =>
					entry.diagnostic.code === 'ACRONYM_FIRST_USE' &&
					entry.diagnostic.message.includes('缩写首次出现，应当给出全称')
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
});
