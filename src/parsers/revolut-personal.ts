/**
 * Parser for Revolut Personal account CSV exports.
 *
 * Expected columns:
 *   Type, Product, Started Date, Completed Date, Description,
 *   Amount, Fee, Currency, State, Balance
 *
 * Only COMPLETED rows are imported.
 */

import { parseCsv, parseAmount, validateColumns } from "./csv.ts";
import type { BankTransaction, InputFormat, InputParser } from "./types.ts";

/** Signature columns that identify this format */
const SIGNATURE_COLUMNS = ["Started Date", "Completed Date", "State", "Balance"];

/** Columns that must be present for the parser to operate correctly */
const REQUIRED_COLUMNS = ["Completed Date", "Amount", "Currency", "State", "Description"];

/** Map three-letter English month abbreviations to zero-based month index */
const MONTH_ABBR: Readonly<Record<string, number>> = {
	Jan: 0,
	Feb: 1,
	Mar: 2,
	Apr: 3,
	May: 4,
	Jun: 5,
	Jul: 6,
	Aug: 7,
	Sep: 8,
	Oct: 9,
	Nov: 10,
	Dec: 11,
};

/**
 * Parse a Revolut date string.
 *
 * Revolut uses at least two formats:
 *   - "2024-01-15 10:30:00"  (ISO-ish with space separator)
 *   - "15 Jan 2024"          (human-readable)
 */
function parseRevolutDate(raw: string): Date {
	const trimmed = raw.trim();

	// Format 1: "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DD"
	const isoMatch = /^(\d{4})-(\d{2})-(\d{2})(?:\s+\d{2}:\d{2}:\d{2})?$/.exec(trimmed);
	if (isoMatch) {
		const [, year, month, day] = isoMatch;
		// Use UTC midnight to avoid timezone shifting
		return new Date(`${year}-${month}-${day}T00:00:00Z`);
	}

	// Format 2: "DD Mon YYYY"  e.g. "15 Jan 2024"
	const humanMatch = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(trimmed);
	if (humanMatch) {
		const dayStr = humanMatch[1] ?? "";
		const monRaw = humanMatch[2] ?? "";
		const yearStr = humanMatch[3] ?? "";
		// Capitalise the month abbreviation to match the lookup table key
		const monKey = monRaw.charAt(0).toUpperCase() + monRaw.slice(1).toLowerCase();
		const monthIndex = MONTH_ABBR[monKey];
		if (monthIndex === undefined) {
			throw new Error(`Unknown month abbreviation: "${monRaw}" in date "${raw}"`);
		}
		const year = Number.parseInt(yearStr, 10);
		const day = Number.parseInt(dayStr, 10);
		return new Date(Date.UTC(year, monthIndex, day));
	}

	throw new Error(`Unrecognised Revolut date format: "${raw}"`);
}

export const revolutPersonalParser: InputParser = {
	name: "Revolut Personal",
	format: "revolut-personal" as InputFormat,

	detect(headerLine: string): boolean {
		// Must have all signature columns but must NOT have "Beneficiary IBAN"
		// (which would indicate the business format)
		if (headerLine.includes("Beneficiary IBAN")) return false;
		return SIGNATURE_COLUMNS.every((col) => headerLine.includes(col));
	},

	parse(content: string): BankTransaction[] {
		const rows = parseCsv(content);
		if (rows.length > 0) {
			validateColumns(
				Object.keys(rows[0] as Record<string, string>),
				REQUIRED_COLUMNS,
				"Revolut Personal",
			);
		}
		const transactions: BankTransaction[] = [];

		for (const row of rows) {
			// Only import completed transactions
			const state = (row.State ?? "").trim().toUpperCase();
			if (state !== "COMPLETED") continue;

			const completedDateRaw = row["Completed Date"] ?? "";
			if (completedDateRaw.trim() === "") {
				throw new Error('Row has empty "Completed Date"');
			}

			const amountRaw = row.Amount ?? "";
			const feeRaw = row.Fee ?? "0";
			const balanceRaw = row.Balance ?? "";

			const fee = parseAmount(feeRaw);
			const balance = balanceRaw.trim() !== "" ? parseAmount(balanceRaw) : undefined;

			const tx: BankTransaction = {
				date: parseRevolutDate(completedDateRaw),
				amount: parseAmount(amountRaw, { required: true }),
				currency: (row.Currency ?? "").trim(),
				description: (row.Description ?? "").trim(),
				rawType: (row.Type ?? "").trim(),
				source: "revolut-personal",
			};

			if (fee !== 0) tx.fee = fee;
			if (balance !== undefined) tx.balance = balance;

			transactions.push(tx);
		}

		return transactions;
	},
};
