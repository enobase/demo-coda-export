/**
 * defaults.ts — Utility functions for inferring default CLI parameters.
 *
 * These helpers are used by the CLI to reduce the number of required flags
 * a user must supply when sensible defaults can be derived from context.
 */

import { extname } from "node:path";

/**
 * Given an input file path, returns the suggested output path by replacing
 * the file extension with `.cod`. If the file has no extension, `.cod` is
 * appended directly.
 *
 * Examples:
 *   "transactions.csv"       -> "transactions.cod"
 *   "transactions"           -> "transactions.cod"
 *   "path/to/export.csv"     -> "path/to/export.cod"
 */
export function inferOutputPath(inputPath: string): string {
	const ext = extname(inputPath);
	if (ext === "") {
		return `${inputPath}.cod`;
	}
	return inputPath.slice(0, inputPath.length - ext.length) + ".cod";
}

/**
 * Given a list of parsed transactions, returns the day immediately before
 * the earliest transaction date. This is used as the opening balance date
 * (the balance is the state of the account at the end of the preceding day).
 *
 * Returns null if the transactions array is empty.
 */
export function inferOpeningDate(transactions: { date: Date }[]): Date | null {
	if (transactions.length === 0) {
		return null;
	}

	const earliest = transactions.reduce(
		(min, tx) => (tx.date < min ? tx.date : min),
		transactions[0].date,
	);

	const result = new Date(earliest);
	result.setDate(result.getDate() - 1);
	return result;
}
