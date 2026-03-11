/**
 * Parser for Wise (TransferWise) account CSV exports.
 *
 * Expected columns:
 *   TransferWise ID, Date, Amount, Currency, Description, Payment Reference,
 *   Running Balance, Exchange From, Exchange To, Exchange Rate, Payer Name,
 *   Payee Name, Payee Account Number, Merchant, Card Last Four Digits,
 *   Card Holder Full Name, Attachment, Note, Total Fees
 *
 * Detection: header contains "TransferWise ID"
 */

import { normaliseIban, parseAmount, parseCsv, validateColumns } from "./csv.ts";
import type { BankTransaction, InputFormat, InputParser } from "./types.ts";

/** Columns that must be present for the parser to operate correctly */
const REQUIRED_COLUMNS = ["TransferWise ID", "Date", "Amount", "Currency", "Description"];

/**
 * Parse a Wise date string.
 * Format: "DD-MM-YYYY"
 */
function parseDate(raw: string): Date {
	const trimmed = raw.trim();
	const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(trimmed);
	if (match) {
		const [, day, month, year] = match;
		return new Date(`${year}-${month}-${day}T00:00:00Z`);
	}
	throw new Error(`Unrecognised Wise date format: "${raw}"`);
}

/**
 * Detect whether a string looks like an IBAN:
 * starts with 2 uppercase letters followed by 2 digits.
 */
function looksLikeIban(value: string): boolean {
	return /^[A-Za-z]{2}\d{2}/.test(value.trim());
}

export const wiseParser: InputParser = {
	name: "Wise",
	format: "wise" as InputFormat,

	detect(headerLine: string): boolean {
		return headerLine.includes("TransferWise ID");
	},

	parse(content: string): BankTransaction[] {
		const rows = parseCsv(content);
		if (rows.length > 0) {
			validateColumns(Object.keys(rows[0] as Record<string, string>), REQUIRED_COLUMNS, "Wise");
		}
		const transactions: BankTransaction[] = [];

		for (const row of rows) {
			const dateRaw = row.Date ?? "";
			if (dateRaw.trim() === "") {
				throw new Error('Row has empty "Date"');
			}

			const amountRaw = row.Amount ?? "";
			const amount = parseAmount(amountRaw, { required: true });

			// Counterparty logic: credits use Payer Name, debits use Payee Name or Merchant
			let counterpartyName: string | undefined;
			if (amount >= 0) {
				const payerName = (row["Payer Name"] ?? "").trim();
				counterpartyName = payerName || undefined;
			} else {
				const payeeName = (row["Payee Name"] ?? "").trim();
				const merchant = (row.Merchant ?? "").trim();
				counterpartyName = payeeName || merchant || undefined;
			}

			// IBAN: use Payee Account Number if it looks like an IBAN
			const payeeAccountRaw = (row["Payee Account Number"] ?? "").trim();
			const counterpartyIban =
				payeeAccountRaw && looksLikeIban(payeeAccountRaw)
					? normaliseIban(payeeAccountRaw)
					: undefined;

			const reference = (row["Payment Reference"] ?? "").trim() || undefined;
			const description = (row.Description ?? "").trim();
			const currency = (row.Currency ?? "").trim();

			const balanceRaw = (row["Running Balance"] ?? "").trim();
			const balance = balanceRaw !== "" ? parseAmount(balanceRaw) : undefined;

			const feesRaw = (row["Total Fees"] ?? "").trim();
			const feeValue = feesRaw !== "" ? parseAmount(feesRaw) : undefined;
			// Only store fee if it's non-zero (use absolute value for consistent debit representation)
			const fee = feeValue !== undefined && feeValue !== 0 ? Math.abs(feeValue) : undefined;

			const tx: BankTransaction = {
				date: parseDate(dateRaw),
				amount,
				currency,
				description: description || counterpartyName || "",
				source: "wise",
			};

			if (counterpartyName) tx.counterpartyName = counterpartyName;
			if (counterpartyIban) tx.counterpartyIban = counterpartyIban;
			if (reference) tx.reference = reference;
			if (balance !== undefined) tx.balance = balance;
			if (fee !== undefined) tx.fee = fee;

			transactions.push(tx);
		}

		return transactions;
	},
};
