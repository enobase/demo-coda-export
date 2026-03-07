/**
 * prompt.ts — Interactive prompt utilities for the CLI
 *
 * All output goes to stderr so it does not pollute stdout pipelines.
 * Designed to work with Bun (no external dependencies).
 */

import { readSync } from "node:fs";

// ---------------------------------------------------------------------------
// TTY detection
// ---------------------------------------------------------------------------

/**
 * Returns true if both stdin and stderr are connected to an interactive
 * terminal (i.e. the process is not piped or redirected).
 */
export function isTTY(): boolean {
	return Boolean(process.stdin.isTTY) && Boolean(process.stderr.isTTY);
}

// ---------------------------------------------------------------------------
// Low-level line reader (synchronous, char-by-char via readSync)
// ---------------------------------------------------------------------------

/**
 * Reads a single line from stdin synchronously.
 * Works in Bun and Node.js without external dependencies.
 */
async function readLine(): Promise<string> {
	const buf = Buffer.alloc(1);
	const fd = 0; // stdin
	let line = "";

	while (true) {
		let n: number;
		try {
			n = readSync(fd, buf, 0, 1, null);
		} catch {
			// EOF or closed stdin
			break;
		}
		if (n === 0) break;
		const ch = buf.toString("utf-8", 0, n);
		if (ch === "\n") break;
		line += ch;
	}

	// Strip trailing carriage return for Windows-style line endings
	return line.replace(/\r$/, "").trim();
}

// ---------------------------------------------------------------------------
// prompt()
// ---------------------------------------------------------------------------

/**
 * Asks a question on stderr and reads one line from stdin.
 *
 * If `defaultValue` is provided it is shown in brackets, e.g.:
 *   Account holder name [ACME BVBA]:
 * Pressing enter with empty input returns the default.
 */
export async function prompt(question: string, defaultValue?: string): Promise<string> {
	const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : "";
	process.stderr.write(`${question}${suffix}: `);

	const answer = await readLine();

	if (answer === "" && defaultValue !== undefined) {
		return defaultValue;
	}

	return answer;
}

// ---------------------------------------------------------------------------
// confirm()
// ---------------------------------------------------------------------------

/**
 * Yes/no prompt. Shows [Y/n] when defaultYes=true, [y/N] when false.
 * Returns true for yes, false for no.
 *
 * Accepts: y, yes, n, no (case-insensitive). Empty input uses the default.
 */
export async function confirm(question: string, defaultYes = false): Promise<boolean> {
	const hint = defaultYes ? "[Y/n]" : "[y/N]";
	process.stderr.write(`${question} ${hint}: `);

	const answer = await readLine();

	if (answer === "") {
		return defaultYes;
	}

	const lower = answer.toLowerCase();
	if (lower === "y" || lower === "yes") return true;
	if (lower === "n" || lower === "no") return false;

	// Unrecognised input — treat as "no"
	return false;
}

// ---------------------------------------------------------------------------
// Log helpers (write to stderr)
// ---------------------------------------------------------------------------

/**
 * Writes an informational message to stderr with a dim prefix.
 * Example output:  ℹ  Detecting format from CSV headers…
 */
export function logInfo(msg: string): void {
	process.stderr.write(`  \u2139  ${msg}\n`);
}

/**
 * Writes an auto-derived value to stderr so the user can see what was
 * inferred automatically.
 * Example output:  ✓ Bank ID: 539 (derived from IBAN)
 */
export function logDerived(label: string, value: string): void {
	process.stderr.write(`  \u2713 ${label}: ${value} (derived from IBAN)\n`);
}
