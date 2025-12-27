#!/usr/bin/env node
require('./register-vscode-stub');

const path = require('node:path');
const fs = require('node:fs/promises');
const { DocumentParser } = require('../out/parser/documentParser');

async function main() {
	const workspaceRoot = path.resolve(__dirname, '..', 'test_thesis');
	const workspace = createWorkspace(workspaceRoot);

	const parser = new DocumentParser(workspace);
	const elements = await parser.parseWorkspace();

	const counts = summarizeElements(elements);

	console.log(`Parsed ${elements.length} total elements from ${workspaceRoot}`);
	console.log('Element counts by type:', counts);

	const sentences = elements.filter((element) => element.type === 'sentence');
	const suspicious = findSuspiciousSentences(sentences);

	console.log(`Identified ${suspicious.length} suspicious sentence fragments.`);
	for (const item of suspicious.slice(0, 20)) {
		console.log(
			`[${path.relative(workspaceRoot, item.filePath)}:${item.range.start.line + 1}] ${item.content}`
		);
	}
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

function summarizeElements(elements) {
	return elements.reduce((acc, element) => {
		acc[element.type] = (acc[element.type] ?? 0) + 1;
		return acc;
	}, {});
}

function findSuspiciousSentences(sentences) {
	return sentences.filter((sentence) => {
		const content = sentence.content;
		if (!content.trim()) {
			return true;
		}
		if (/[\\{}]/.test(content)) {
			return true;
		}
		if (content.length < 5) {
			return true;
		}
		return false;
	});
}

main().catch((error) => {
	console.error('Failed to run parser:', error);
	process.exitCode = 1;
});
