/**
 * Parser for Qonto CSV exports.
 *
 * Expected columns (may vary slightly between export versions):
 *   Status, Settlement date (UTC), Operation date (UTC),
 *   Total amount (incl. VAT), Currency, Counterparty name,
 *   Payment method, Transaction ID, IBAN, Reference, Category,
 *   Note, VAT amount, Initiator, Label 1, Label 2, Label 3
 *
 * Only rows with Status = "settled" or "executed" are imported.
 * Auto-detection key: presence of "Settlement date (UTC)" in the header.
 */

import { parseCsv } from "./csv.ts";
import type { BankTransaction, InputFormat, InputParser } from "./types.ts";

const ACCEPTED_STATUSES = new Set(["settled", "executed"]);

/**
 * Parse a date string from Qonto CSVs.
 * Format: "YYYY-MM-DD HH:MM:SS" (UTC)
 */
function parseDate(raw: string): Date {
	const trimmed = raw.trim();

	const match = /^(\d{4})-(\d{2})-(\d{2})(?:\s+\d{2}:\d{2}:\d{2})?$/.exec(trimmed);
	if (match) {
		const [, year, month, day] = match;
		return new Date(`${year}-${month}-${day}T00:00:00Z`);
	}

	throw new Error(`Unrecognised Qonto date format: "${raw}"`);
}

function parseAmount(raw: string): number {
	const trimmed = raw.trim();
	if (trimmed === "" || trimmed === "-") return 0;
	const value = Number.parseFloat(trimmed);
	if (Number.isNaN(value)) {
		throw new Error(`Invalid amount value: "${raw}"`);
	}
	return value;
}

/** Normalise an IBAN: strip spaces, uppercase */
function normaliseIban(raw: string): string | undefined {
	const cleaned = raw.replace(/\s+/g, "").toUpperCase();
	return cleaned.length > 0 ? cleaned : undefined;
}

export const qontoParser: InputParser = {
	name: "Qonto",
	format: "qonto" as InputFormat,

	detect(headerLine: string): boolean {
		return (
			headerLine.includes("Settlement date (UTC)") &&
			headerLine.includes("Total amount (incl. VAT)")
		);
	},

	parse(content: string): BankTransaction[] {
		const rows = parseCsv(content);
		const transactions: BankTransaction[] = [];

		for (const row of rows) {
			// Filter by status
			const status = (row.Status ?? "").trim().toLowerCase();
			if (!ACCEPTED_STATUSES.has(status)) continue;

			const settlementDateRaw = row["Settlement date (UTC)"] ?? "";
			if (settlementDateRaw.trim() === "") {
				throw new Error('Settled row has empty "Settlement date (UTC)"');
			}

			const operationDateRaw = row["Operation date (UTC)"] ?? "";
			let valueDate: Date | undefined;
			if (operationDateRaw.trim() !== "" && operationDateRaw !== settlementDateRaw) {
				valueDate = parseDate(operationDateRaw);
			}

			const amountRaw = row["Total amount (incl. VAT)"] ?? "";
			const counterpartyName = (row["Counterparty name"] ?? "").trim() || undefined;
			const counterpartyIban = normaliseIban(row.IBAN ?? "");
			const reference = (row.Reference ?? "").trim() || undefined;
			const category = (row.Category ?? "").trim() || undefined;
			const rawType = (row["Payment method"] ?? "").trim() || undefined;

			const tx: BankTransaction = {
				date: parseDate(settlementDateRaw),
				amount: parseAmount(amountRaw),
				currency: (row.Currency ?? "").trim(),
				description: counterpartyName ?? (row["Transaction ID"] ?? "").trim(),
				source: "qonto",
			};

			if (rawType) tx.rawType = rawType;
			if (valueDate) tx.valueDate = valueDate;
			if (counterpartyName) tx.counterpartyName = counterpartyName;
			if (counterpartyIban) tx.counterpartyIban = counterpartyIban;
			if (reference) tx.reference = reference;
			if (category) tx.category = category;

			transactions.push(tx);
		}

		return transactions;
	},
};
