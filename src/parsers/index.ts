/**
 * Parser registry and auto-detection entry points.
 *
 * Usage:
 *   import { detectFormat, parseTransactions } from "./parsers/index.ts";
 *
 *   const format = detectFormat(csvContent);           // auto-detect
 *   const txns   = parseTransactions(csvContent);      // detect + parse
 *   const txns2  = parseTransactions(csvContent, "qonto"); // explicit format
 */

import { n26Parser } from "./n26.ts";
import { qontoParser } from "./qonto.ts";
import { revolutBusinessParser } from "./revolut-business.ts";
import { revolutPersonalParser } from "./revolut-personal.ts";
import type { BankTransaction, InputFormat, InputParser } from "./types.ts";
import { wiseParser } from "./wise.ts";

export type { BankTransaction, InputFormat, InputParser };

/**
 * All registered parsers, in priority order.
 * Revolut Business is checked before Revolut Personal because its header is a
 * superset (it also contains "Completed Date"-like columns).
 * Wise is checked first among new parsers because "TransferWise ID" is very
 * distinctive. N26 is checked before the Revolut parsers to avoid false matches.
 */
const PARSERS: InputParser[] = [
	wiseParser,
	n26Parser,
	revolutBusinessParser,
	revolutPersonalParser,
	qontoParser,
];

/**
 * Read the first non-empty line of the CSV content and try each parser's
 * `detect()` method in registration order.
 *
 * @returns The matched format identifier, or `null` if none matched.
 */
export function detectFormat(content: string): InputFormat | null {
	const firstLine = content
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.split("\n")
		.find((line) => line.trim() !== "");

	if (!firstLine) return null;

	for (const parser of PARSERS) {
		if (parser.detect(firstLine)) {
			return parser.format;
		}
	}

	return null;
}

/**
 * Parse CSV content into normalised `BankTransaction` objects.
 *
 * @param content - Raw CSV text (UTF-8)
 * @param format  - Optional explicit format; auto-detected when omitted
 * @throws {Error} if `format` is omitted and detection fails
 * @throws {Error} if an explicit `format` is specified but not registered
 */
export function parseTransactions(content: string, format?: InputFormat): BankTransaction[] {
	const resolvedFormat = format ?? detectFormat(content);

	if (!resolvedFormat) {
		throw new Error(
			"Unable to detect CSV format. " +
				"Supported formats: revolut-personal, revolut-business, qonto, n26, wise. " +
				"Pass an explicit format parameter if auto-detection is insufficient.",
		);
	}

	const parser = PARSERS.find((p) => p.format === resolvedFormat);
	if (!parser) {
		throw new Error(
			`No parser registered for format "${resolvedFormat}". ` +
				`Registered formats: ${PARSERS.map((p) => p.format).join(", ")}`,
		);
	}

	return parser.parse(content);
}

/** Expose individual parsers for callers that want direct access */
export { n26Parser, qontoParser, revolutBusinessParser, revolutPersonalParser, wiseParser };
