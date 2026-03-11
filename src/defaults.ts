/**
 * defaults.ts — Utility functions for inferring default CLI parameters.
 *
 * These helpers are used by the CLI to reduce the number of required flags
 * a user must supply when sensible defaults can be derived from context.
 */

import { extname } from "node:path";
import type { BankTransaction } from "./parsers/index.ts";

// ---------------------------------------------------------------------------
// CSV-based inference
// ---------------------------------------------------------------------------

/**
 * Values that can be inferred from a parsed CSV file.
 */
export interface CsvInferredDefaults {
	/** Most common currency found in transactions (e.g. "EUR") */
	currency: string | undefined;
	/** Account holder name inferred from CSV fields, if available */
	holderName: string | undefined;
	/**
	 * Opening balance inferred from a running balance column (e.g. Qonto FR
	 * "Solde"). Computed as: balance_after_earliest_tx - amount_of_earliest_tx.
	 * Undefined when no balance data is present.
	 */
	openingBalance: number | undefined;
}

/**
 * Infer sensible account defaults from a list of parsed transactions.
 *
 * - `currency`: the most frequently occurring currency across all transactions.
 *   Falls back to the first transaction's currency if all are equal.
 * - `holderName`: extracted from the `counterpartyName` field of "Account Name"
 *   style sources (currently N26 which includes an "Account Name" column).
 *   Returns undefined when no holder name is detectable.
 */
export function inferCsvDefaults(transactions: BankTransaction[]): CsvInferredDefaults {
	if (transactions.length === 0) {
		return { currency: undefined, holderName: undefined, openingBalance: undefined };
	}

	// --- Currency: pick the most common one ---
	const currencyCounts = new Map<string, number>();
	for (const tx of transactions) {
		if (tx.currency) {
			currencyCounts.set(tx.currency, (currencyCounts.get(tx.currency) ?? 0) + 1);
		}
	}

	let currency: string | undefined;
	if (currencyCounts.size > 0) {
		let maxCount = 0;
		for (const [code, count] of currencyCounts) {
			if (count > maxCount) {
				maxCount = count;
				currency = code;
			}
		}
	}

	// --- Holder name ---
	// N26 exposes an "Account Name" column; we surface it via the description
	// of non-counterparty transactions when all descriptions share the same value.
	// For other formats there is no reliable holder-name field, so we leave it
	// undefined rather than guess.
	let holderName: string | undefined;
	const source = transactions[0]?.source;
	if (source === "n26") {
		// N26 rows with rawType "Incoming Payment" or "Income" often carry the
		// account holder name in the description when partner name is absent.
		// More reliably: look for a consistent non-empty description that appears
		// across self-transfer rows — but this is fragile. We simply return
		// undefined for N26 for now to avoid false positives.
		holderName = undefined;
	}

	// --- Opening balance: infer from running balance column ---
	// When transactions carry a post-transaction balance (e.g. Qonto FR "Solde"),
	// derive the opening balance as:
	//   balance_after_earliest - amount_of_earliest
	let openingBalance: number | undefined;
	const withBalance = transactions.filter((tx) => tx.balance !== undefined);
	if (withBalance.length > 0) {
		const first = withBalance[0]!;
		const earliest = withBalance.reduce((min, tx) => (tx.date < min.date ? tx : min), first);
		if (earliest.balance !== undefined) {
			openingBalance = earliest.balance - earliest.amount;
		}
	}

	return { currency, holderName, openingBalance };
}

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
		transactions[0]!.date,
	);

	const result = new Date(earliest);
	result.setUTCDate(result.getUTCDate() - 1);
	return result;
}
