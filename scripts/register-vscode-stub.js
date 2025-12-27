const Module = require('module');
const path = require('node:path');

const vscodeStubPath = path.join(__dirname, 'vscode-stub.js');
const vscodeExports = require(vscodeStubPath);

const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
	if (request === 'vscode') {
		return vscodeExports;
	}
	return originalLoad.call(this, request, parent, isMain);
};
