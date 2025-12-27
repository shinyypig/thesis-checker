#!/usr/bin/env node
require('./register-vscode-stub');

const path = require('node:path');
const fs = require('node:fs/promises');
const { DocumentParser } = require('../out/parser/documentParser');
const { LogicAnalyzer } = require('../out/analyzers/logicAnalyzer');

async function main() {
	const workspaceRoot = path.resolve(__dirname, '..', 'test_thesis');
	const workspace = createWorkspace(workspaceRoot);

	const parser = new DocumentParser(workspace);
	const elements = await parser.parseWorkspace();
	console.log(`Parsed ${elements.length} elements from ${workspaceRoot}`);

	const logicAnalyzer = new LogicAnalyzer();
	const diagnostics = logicAnalyzer.analyze(elements);

	console.log(`Logic analyzer produced ${diagnostics.length} diagnostics.`);
	const grouped = summarizeDiagnostics(diagnostics, workspaceRoot);
	printDiagnosticSummary(grouped);
}

function createWorkspace(rootDir) {
	return {
		async findFiles() {
			const files = await collectTexFiles(rootDir);
			return files.map((filePath) => ({ fsPath: filePath }));
		},
		async openTextDocument(uri) {
			const text = await fs.readFile(uri.fsPath, 'utf8');
			return new TextDocument(uri, text);
		},
	};
}

class TextDocument {
	constructor(uri, text) {
		this.uri = uri;
		this._text = text;
	}

	getText() {
		return this._text;
	}
}

async function collectTexFiles(dir) {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const files = [];

	for (const entry of entries) {
		if (entry.name === 'node_modules' || entry.name === '.git') {
			continue;
		}
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			const nested = await collectTexFiles(fullPath);
			files.push(...nested);
		} else if (entry.isFile() && entry.name.endsWith('.tex')) {
			files.push(fullPath);
		}
	}

	return files;
}

function summarizeDiagnostics(diagnostics, workspaceRoot) {
	const grouped = new Map();
	for (const item of diagnostics) {
		const key = item.diagnostic.code ?? item.diagnostic.message;
		const entry = grouped.get(key) ?? {
			key,
			count: 0,
			samples: [],
		};
		entry.count += 1;
		if (entry.samples.length < 5) {
			entry.samples.push({
				message: item.diagnostic.message,
				code: item.diagnostic.code,
				file: path.relative(workspaceRoot, item.uri.fsPath),
				line: item.diagnostic.range?.start?.line ?? 0,
			});
		}
		grouped.set(key, entry);
	}
	return [...grouped.values()].sort((a, b) => b.count - a.count);
}

function printDiagnosticSummary(groups) {
	for (const group of groups) {
		console.log(`\n${group.count} × ${group.key}`);
		for (const sample of group.samples) {
			console.log(
				`  - ${sample.file}:${sample.line + 1} ${sample.message}`
			);
		}
	}
}

main().catch((error) => {
	console.error('Failed to run logic analyzer:', error);
	process.exitCode = 1;
});
