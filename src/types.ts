import * as vscode from 'vscode';

export type ElementType =
	| 'chapter'
	| 'title'
	| 'section'
	| 'subsection'
	| 'subsubsection'
	| 'sentence'
	| 'equation'
	| 'figure'
	| 'table'
	| 'environment';

export interface DocumentElement {
	type: ElementType;
	content: string;
	filePath: string;
	range: vscode.Range;
	metadata?: Record<string, unknown>;
}

export interface AnalyzerDiagnostic {
	uri: vscode.Uri;
	diagnostic: vscode.Diagnostic;
}
