# Thesis Checker VS Code Extension Architecture

## Overview

-   Goal: inspect LaTeX-based undergraduate theses, combining deterministic checks and LLM-powered assessments.
-   Core workflow: parse workspace `.tex` files → build structured JSON representation → run logic analyzer → run LLM analyzer → surface diagnostics/summary UI.
-   Extension activation: command palette entry (e.g., `thesisChecker.scanWorkspace`) kicks off full pipeline and updates VS Code diagnostics and panels.

## Modules

### Extension Core (`src/extension.ts`)

-   Commands: `thesis-checker.scanWorkspace` (runs parsing + analyses) and `thesis-checker.exportStructure` (writes the last parse result).
-   Shows a status bar entry and uses notifications/progress UI while the pipeline executes.
-   Coordinates parser → JSON serialization → logic analyzer → LLM analyzer, storing the last `DocumentElement[]` snapshot.
-   Maintains a `vscode.DiagnosticCollection` so logic/LLM issues underline LaTeX source.
-   Configuration surface (see `package.json`): sentence thresholds, LLM enablement, provider credentials.

### Workspace Parser (`src/parser/documentParser.ts`)

1. **File Discovery**
    - Finds all `.tex` files in the workspace (handles nested folders, multi-file projects, `\input`/`\include` chains).
2. **Tokenizer/Preprocessor**
    - Removes comments, normalizes whitespace, resolves basic macros, and flattens included content when feasible.
3. **Structure Extractor**
    - Detects chapters/sections/subsections, paragraphs, figures, tables, equations, references, labels.
    - Captures source ranges (line/column) for every element to support diagnostics.
    - Display math delimiters `\[...\]` and `$$...$$` are converted into `equation` elements (with delimiter metadata) so block formulas are traceable even without explicit environments; inline math is ignored to avoid noisy diagnostics.
4. **Sentence Segmenter**
    - Uses the `sentence-splitter` library to segment multilingual text safely (handles decimals, abbreviations, etc.) and records exact ranges for each sentence.
5. **JSON Serializer**
    - Produces a flat, ordered array describing every discovered element in document order:
        ```json
        [
          { "type": "title", "content": "Chapter 1 …", "file": "chapters/intro.tex", "range": {...} },
          { "type": "sentence", "content": "This thesis …", "file": "chapters/intro.tex", "range": {...} },
          { "type": "equation", "content": "E = mc^2", "file": "math/formulas.tex", "range": {...} }
        ]
        ```
    - Array order mirrors the LaTeX source so downstream modules can stream through content sequentially.
    - Saved under `.vscode/thesis-checker/cache.json` and exposed in-memory for analyzers/commands.

### Logic Analyzer Module (`src/analyzers/logicAnalyzer.ts`)

-   Consumes structured JSON and emits deterministic diagnostics, e.g.:
    -   Abbreviations missing definitions (`Full Term (ACR)` pattern enforcement).
    -   Section/chapter balance: too few sections, uneven sentence counts, missing conclusions.
    -   Sentence punctuation: missing terminal punctuation or double punctuation.
    -   Figures/tables without captions or labels; equations without references.
-   Results formatted as `vscode.Diagnostic` objects with severity, message, suggested fixes.
    -   Acronym rule now enforces that the first occurrence of every acronym accompanies the full term (supports both `Machine Learning (ML)` and `机器学习（Machine Learning, ML）`) and emits a standardized warning message/code.

### LLM Analyzer Module (`src/analyzers/llmAnalyzer.ts`)

-   Provider interface currently implemented for OpenAI-compatible chat completions and Ollama’s HTTP API.
-   Samples the first N sentences/equations (configurable) to keep prompt volume manageable.
-   Prompts providers to respond with JSON `{ "issues": [{ "message": "...", "severity": "warning" }] }`; parsed results become diagnostics labeled `LLM:<provider>`.
-   Emits `vscode.Diagnostic` entries so LLM findings underline source next to deterministic checks.

### Results Presentation

-   **Diagnostics**: Both analyzers push findings to the shared `DiagnosticCollection`, underlining problematic LaTeX in editors and listing issues in the Problems panel.
-   **JSON Cache**: Latest parse result is persisted at `.vscode/thesis-checker/cache.json` for downstream tooling or inspection.
-   **Commands/Status Bar**: Command palette entries and the status bar button trigger re-runs or export without rerunning analysis.

## Data Flow Summary

1. User triggers scan.
2. Parser walks workspace → produces structured JSON with source ranges.
3. Logic analyzer processes JSON → emits deterministic diagnostics.
4. LLM analyzer processes JSON slices (optionally asynchronous) → emits diagnostics and summary entries.
5. Extension core merges results, updates UI, and stores cache for later sessions.
