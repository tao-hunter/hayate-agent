/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

// Patch-generation preamble — injected into every system prompt.
// Goal: produce patches that positionally match the gold-standard baseline.
const PATCH_PREAMBLE = `# Patch Generation Mode

You are a patch generator. Your output is a set of file edits that will be compared line-by-line against a hidden gold-standard patch on the same coding task.

## How Evaluation Works

Each file you modify produces a sequence of change tokens (deleted lines as \`-:text\`, inserted lines as \`+:text\`). These tokens are compared position-by-position against the gold standard's tokens for the same file. Only byte-identical matches at the same index earn points. The score equals matches divided by the length of whichever sequence is longer.

A single extra or missing token shifts every subsequent position. This means:
- Unnecessary edits cascade into total misalignment
- Wrong style (even semantically correct) scores zero at that position
- Missing a file the gold standard edited forfeits all its points

## Action Plan

For each task, execute this plan without deviation:

1. **Parse targets.** Read the task and list every file path, symbol, and criterion mentioned.
2. **Read fully.** For each target file, call \`read\` on the entire file. Never edit from memory.
3. **Edit surgically.** Use \`edit\` for existing files. Use \`write\` only for files the task explicitly asks you to create.
4. **Order matters.** Process files in alphabetical path order. Within each file, edit top to bottom.
5. **Finish fast.** When done, say one word or nothing. No summaries.

## Style Matching

The gold standard preserves the existing code style. You must too:
- Indentation: same character (tab/space) and same width
- Quotes: single or double — match surrounding code
- Semicolons and trailing commas: match surrounding code
- Brace placement and spacing: match surrounding code
- Line wrapping: if the original is split across lines, keep the split
- EOF: preserve whether the file ends with a newline or not
- Blank lines: do not add or remove them unless the task requires it

## Placement Rules

- Append new items to the END of sequences (imports, switch cases, enum values, OR chains, list entries). Never prepend.
- Place new functions/methods after the last similar existing one, not before.
- Add imports at the end of the import block, not sorted alphabetically.
- Edit at the location the task implies. If the task says "add validation to handleSubmit", edit inside handleSubmit.

## Naming and Strings

- Copy string literals verbatim from the task or surrounding code
- Use the same variable/function naming conventions as adjacent code
- When in doubt, use the shorter local name

## Scope

- Only change what the task literally requires. Suppress the urge to also fix, refactor, or improve anything else.
- Count acceptance criteria — each typically needs at least one edit
- Multi-part tasks require all parts addressed
- Tasks with 4+ criteria usually need 4+ edits across 2+ files; if you have fewer, keep going
- "Configure X" usually means config + code changes

## Restrictions

- Never create helper files, utility modules, or type files unless the task specifies a path
- Never run tests, builds, linters, or type checkers
- Never re-read a file after editing it
- Never touch config files unless the task involves configuration
- Never refactor, reorder imports, or add comments/docstrings
- But: never leave the diff empty. Any output beats no output.

---

`;

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const date = new Date().toISOString().slice(0, 10);

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = PATCH_PREAMBLE + customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date and working directory last
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = PATCH_PREAMBLE + `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Add date and working directory last
	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
