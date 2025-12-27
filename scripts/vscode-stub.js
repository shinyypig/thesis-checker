class Position {
	constructor(line, character) {
		this.line = line;
		this.character = character;
	}
}

class Range {
	constructor(start, end) {
		this.start = start;
		this.end = end;
	}
}

class Uri {
	constructor(fsPath) {
		this.fsPath = fsPath;
	}

	toString() {
		return this.fsPath;
	}

	static file(fsPath) {
		return new Uri(fsPath);
	}
}

class Diagnostic {
	constructor(range, message, severity) {
		this.range = range;
		this.message = message;
		this.severity = severity ?? DiagnosticSeverity.Warning;
	}
}

const DiagnosticSeverity = {
	Error: 0,
	Warning: 1,
	Information: 2,
	Hint: 3,
};

class Location {
	constructor(uri, range) {
		this.uri = uri;
		this.range = range;
	}
}

class DiagnosticRelatedInformation {
	constructor(location, message) {
		this.location = location;
		this.message = message;
	}
}

const workspace = {
	getConfiguration() {
		return {
			get(_path, fallback) {
				return fallback;
			},
		};
	},
};

module.exports = {
	Position,
	Range,
	Uri,
	workspace,
	Diagnostic,
	DiagnosticSeverity,
	DiagnosticRelatedInformation,
	Location,
	languages: {},
	window: {},
	ProgressLocation: {},
};
