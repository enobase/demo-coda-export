/**
 * Parser for N26 bank account CSV exports.
 *
 * Expected columns:
 *   Booking Date, Value Date, Partner Name, Partner Iban, Type,
 *   Payment Reference, Account Name, Amount (EUR), Original Amount,
 *   Original Currency, Exchange Rate
 *
 * Detection: header contains "Partner Iban" AND "Account Name" AND "Amount (EUR)"
 */

import { normaliseIban, parseAmount, parseCsv, validateColumns } from "./csv.ts";
import type { BankTransaction, InputFormat, InputParser } from "./types.ts";

/** Signature columns that identify this format */
const SIGNATURE_COLUMNS = ["Partner Iban", "Account Name", "Amount (EUR)"];

/** Columns that must be present for the parser to operate correctly */
const REQUIRED_COLUMNS = ["Booking Date", "Amount (EUR)", "Partner Name", "Type"];

/**
 * Parse an N26 date string.
 * Format: "YYYY-MM-DD"
 */
function parseDate(raw: string): Date {
	const trimmed = raw.trim();
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
	if (match) {
		const [, year, month, day] = match;
		return new Date(`${year}-${month}-${day}T00:00:00Z`);
	}
	throw new Error(`Unrecognised N26 date format: "${raw}"`);
}

export const n26Parser: InputParser = {
	name: "N26",
	format: "n26" as InputFormat,

	detect(headerLine: string): boolean {
		return SIGNATURE_COLUMNS.every((col) => headerLine.includes(col));
	},

	parse(content: string): BankTransaction[] {
		const rows = parseCsv(content);
		if (rows.length > 0) {
			validateColumns(Object.keys(rows[0] as Record<string, string>), REQUIRED_COLUMNS, "N26");
		}
		const transactions: BankTransaction[] = [];

		for (const row of rows) {
			const bookingDateRaw = row["Booking Date"] ?? "";
			if (bookingDateRaw.trim() === "") {
				throw new Error('Row has empty "Booking Date"');
			}

			const valueDateRaw = row["Value Date"] ?? "";
			let valueDate: Date | undefined;
			if (valueDateRaw.trim() !== "" && valueDateRaw.trim() !== bookingDateRaw.trim()) {
				valueDate = parseDate(valueDateRaw);
			}

			const amountRaw = row["Amount (EUR)"] ?? "";
			const partnerName = (row["Partner Name"] ?? "").trim() || undefined;
			const partnerIban = normaliseIban(row["Partner Iban"] ?? "");
			const reference = (row["Payment Reference"] ?? "").trim() || undefined;
			const rawType = (row.Type ?? "").trim() || undefined;

			const tx: BankTransaction = {
				date: parseDate(bookingDateRaw),
				amount: parseAmount(amountRaw, { required: true }),
				currency: "EUR",
				description: partnerName ?? rawType ?? "",
				source: "n26",
			};

			if (valueDate) tx.valueDate = valueDate;
			if (partnerName) tx.counterpartyName = partnerName;
			if (partnerIban) tx.counterpartyIban = partnerIban;
			if (reference) tx.reference = reference;
			if (rawType) tx.rawType = rawType;

			transactions.push(tx);
		}

		return transactions;
	},
};
