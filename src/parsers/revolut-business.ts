/**
 * Parser for Revolut Business account CSV exports.
 *
 * Expected columns:
 *   Date started (UTC), Date completed (UTC), ID, Type, Description,
 *   Reference, Payer, Card number, Orig currency, Orig amount,
 *   Payment currency, Amount, Fee, Balance, Account,
 *   Beneficiary account number, Beneficiary sort code or routing number,
 *   Beneficiary IBAN, Beneficiary BIC
 *
 * Auto-detection key: presence of "Beneficiary IBAN" in the header.
 */

import { parseCsv } from "./csv.ts";
import type { BankTransaction, InputFormat, InputParser } from "./types.ts";

/**
 * Parse a date string from Revolut Business CSVs.
 * Format: "YYYY-MM-DD HH:MM:SS" (UTC)
 */
function parseDate(raw: string): Date {
	const trimmed = raw.trim();

	const match = /^(\d{4})-(\d{2})-(\d{2})(?:\s+\d{2}:\d{2}:\d{2})?$/.exec(trimmed);
	if (match) {
		const [, year, month, day] = match;
		return new Date(`${year}-${month}-${day}T00:00:00Z`);
	}

	throw new Error(`Unrecognised Revolut Business date format: "${raw}"`);
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

/** Normalise a BIC: strip spaces, uppercase */
function normaliseBic(raw: string): string | undefined {
	const cleaned = raw.replace(/\s+/g, "").toUpperCase();
	return cleaned.length > 0 ? cleaned : undefined;
}

export const revolutBusinessParser: InputParser = {
	name: "Revolut Business",
	format: "revolut-business" as InputFormat,

	detect(headerLine: string): boolean {
		return headerLine.includes("Beneficiary IBAN");
	},

	parse(content: string): BankTransaction[] {
		const rows = parseCsv(content);
		const transactions: BankTransaction[] = [];

		for (const row of rows) {
			const completedDateRaw = row["Date completed (UTC)"] ?? "";
			if (completedDateRaw.trim() === "") {
				// Skip rows with no completion date (e.g. pending transactions)
				continue;
			}

			const amountRaw = row.Amount ?? "";
			const feeRaw = row.Fee ?? "0";
			const balanceRaw = row.Balance ?? "";

			const fee = parseAmount(feeRaw);
			const balance = balanceRaw.trim() !== "" ? parseAmount(balanceRaw) : undefined;

			const counterpartyIban = normaliseIban(row["Beneficiary IBAN"] ?? "");
			const counterpartyBic = normaliseBic(row["Beneficiary BIC"] ?? "");
			const reference = (row.Reference ?? "").trim() || undefined;
			const counterpartyName = (row.Description ?? "").trim() || undefined;

			const tx: BankTransaction = {
				date: parseDate(completedDateRaw),
				amount: parseAmount(amountRaw),
				currency: (row["Payment currency"] ?? "").trim(),
				description: (row.Description ?? "").trim(),
				rawType: (row.Type ?? "").trim(),
				source: "revolut-business",
			};

			if (fee !== 0) tx.fee = fee;
			if (balance !== undefined) tx.balance = balance;
			if (counterpartyIban) tx.counterpartyIban = counterpartyIban;
			if (counterpartyBic) tx.counterpartyBic = counterpartyBic;
			if (reference) tx.reference = reference;
			if (counterpartyName) tx.counterpartyName = counterpartyName;

			transactions.push(tx);
		}

		return transactions;
	},
};
