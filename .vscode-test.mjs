import { defineConfig } from '@vscode/test-cli';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
	files: 'out/test/**/*.test.js',
	extensionDevelopmentPath: __dirname,
	workspaceFolder: __dirname,
	mocha: {
		timeout: 60000
	}
});
