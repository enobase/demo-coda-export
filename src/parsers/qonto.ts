/**
 * Parser for Qonto CSV exports.
 *
 * Supports two export locales:
 *
 * English (comma-delimited):
 *   Status, Settlement date (UTC), Operation date (UTC),
 *   Total amount (incl. VAT), Currency, Counterparty name,
 *   Payment method, Transaction ID, IBAN, Reference, Category
 *
 * French (semicolon-delimited):
 *   Statut, Date de la valeur (UTC), Date de l'opération (UTC),
 *   Montant total (TTC), Débit, Crédit, Solde, Devise,
 *   Nom de la contrepartie, IBAN de la contrepartie,
 *   Méthode de paiement, Identifiant de transaction, Référence,
 *   Catégorie de trésorerie
 *
 * Auto-detection: presence of "Settlement date (UTC)" (EN) or
 * "Date de la valeur (UTC)" (FR) in the header.
 */

import { normaliseIban, parseAmount, parseCsv, validateColumns } from "./csv.ts";
import type { BankTransaction, InputFormat, InputParser } from "./types.ts";

const ACCEPTED_STATUSES_EN = new Set(["settled", "executed"]);
const ACCEPTED_STATUSES_FR = new Set(["exécuté", "réglé", "settled", "executed"]);

/** Required columns for the English export */
const REQUIRED_COLUMNS_EN = [
	"Status",
	"Settlement date (UTC)",
	"Total amount (incl. VAT)",
	"Currency",
];

/** Required columns for the French export */
const REQUIRED_COLUMNS_FR = ["Statut", "Date de la valeur (UTC)", "Montant total (TTC)", "Devise"];

/**
 * Parse an English Qonto date string.
 * Format: "YYYY-MM-DD HH:MM:SS" (UTC)
 */
function parseDateEn(raw: string): Date {
	const trimmed = raw.trim();
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:\s+\d{2}:\d{2}:\d{2})?$/.exec(trimmed);
	if (match) {
		const [, year, month, day] = match;
		return new Date(`${year}-${month}-${day}T00:00:00Z`);
	}
	throw new Error(`Unrecognised Qonto date format: "${raw}"`);
}

/**
 * Parse a French Qonto date string.
 * Format: "DD-MM-YYYY HH:MM:SS" (UTC)
 */
function parseDateFr(raw: string): Date {
	const trimmed = raw.trim();
	const match = /^(\d{2})-(\d{2})-(\d{4})(?:\s+\d{2}:\d{2}:\d{2})?$/.exec(trimmed);
	if (match) {
		const [, day, month, year] = match;
		return new Date(`${year}-${month}-${day}T00:00:00Z`);
	}
	throw new Error(`Unrecognised Qonto FR date format: "${raw}"`);
}

/**
 * Parse a French-locale amount string where comma is the decimal separator.
 * e.g. "-1,82" -> -1.82, "2 999,00" -> 2999.00
 */
function parseFrAmount(raw: string, options?: { required?: boolean }): number {
	// Replace non-breaking and regular spaces (thousands separator) then swap comma for dot
	const normalised = raw
		.trim()
		.replace(/[\s\u00a0]/g, "")
		.replace(",", ".");
	return parseAmount(normalised, options);
}

function parseEnglish(content: string): BankTransaction[] {
	const rows = parseCsv(content);
	if (rows.length > 0) {
		validateColumns(Object.keys(rows[0] as Record<string, string>), REQUIRED_COLUMNS_EN, "Qonto");
	}
	const transactions: BankTransaction[] = [];

	for (const row of rows) {
		const status = (row.Status ?? "").trim().toLowerCase();
		if (!ACCEPTED_STATUSES_EN.has(status)) continue;

		const settlementDateRaw = row["Settlement date (UTC)"] ?? "";
		if (settlementDateRaw.trim() === "") {
			throw new Error('Settled row has empty "Settlement date (UTC)"');
		}

		const operationDateRaw = row["Operation date (UTC)"] ?? "";
		let valueDate: Date | undefined;
		if (operationDateRaw.trim() !== "" && operationDateRaw !== settlementDateRaw) {
			valueDate = parseDateEn(operationDateRaw);
		}

		const amountRaw = row["Total amount (incl. VAT)"] ?? "";
		const counterpartyName = (row["Counterparty name"] ?? "").trim() || undefined;
		const counterpartyIban = normaliseIban(row.IBAN ?? "");
		const reference = (row.Reference ?? "").trim() || undefined;
		const category = (row.Category ?? "").trim() || undefined;
		const rawType = (row["Payment method"] ?? "").trim() || undefined;

		const tx: BankTransaction = {
			date: parseDateEn(settlementDateRaw),
			amount: parseAmount(amountRaw, { required: true }),
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
}

function parseFrench(content: string): BankTransaction[] {
	const rows = parseCsv(content);
	if (rows.length > 0) {
		validateColumns(
			Object.keys(rows[0] as Record<string, string>),
			REQUIRED_COLUMNS_FR,
			"Qonto FR",
		);
	}
	const transactions: BankTransaction[] = [];

	for (const row of rows) {
		const status = (row.Statut ?? "").trim().toLowerCase();
		if (!ACCEPTED_STATUSES_FR.has(status)) continue;

		const settlementDateRaw = row["Date de la valeur (UTC)"] ?? "";
		if (settlementDateRaw.trim() === "") {
			throw new Error('Settled row has empty "Date de la valeur (UTC)"');
		}

		const operationDateRaw = row["Date de l'opération (UTC)"] ?? "";
		let valueDate: Date | undefined;
		if (operationDateRaw.trim() !== "" && operationDateRaw !== settlementDateRaw) {
			valueDate = parseDateFr(operationDateRaw);
		}

		const amountRaw = row["Montant total (TTC)"] ?? "";
		const counterpartyName = (row["Nom de la contrepartie"] ?? "").trim() || undefined;
		const counterpartyIban = normaliseIban(row["IBAN de la contrepartie"] ?? "");
		const reference = (row["Référence"] ?? "").trim() || undefined;
		const category = (row["Catégorie de trésorerie"] ?? "").trim() || undefined;
		const rawType = (row["Méthode de paiement"] ?? "").trim() || undefined;
		const txId = (row["Identifiant de transaction"] ?? "").trim();

		// Running balance after this transaction (for opening balance inference)
		const balanceRaw = (row["Solde"] ?? "").trim();
		const balance = balanceRaw !== "" ? parseFrAmount(balanceRaw) : undefined;

		const tx: BankTransaction = {
			date: parseDateFr(settlementDateRaw),
			amount: parseFrAmount(amountRaw, { required: true }),
			currency: (row.Devise ?? "").trim(),
			description: counterpartyName ?? txId,
			source: "qonto",
		};

		if (rawType) tx.rawType = rawType;
		if (valueDate) tx.valueDate = valueDate;
		if (counterpartyName) tx.counterpartyName = counterpartyName;
		if (counterpartyIban) tx.counterpartyIban = counterpartyIban;
		if (reference) tx.reference = reference;
		if (category) tx.category = category;
		if (balance !== undefined) tx.balance = balance;

		transactions.push(tx);
	}

	return transactions;
}

export const qontoParser: InputParser = {
	name: "Qonto",
	format: "qonto" as InputFormat,

	detect(headerLine: string): boolean {
		// English export
		if (
			headerLine.includes("Settlement date (UTC)") &&
			headerLine.includes("Total amount (incl. VAT)")
		) {
			return true;
		}
		// French export
		if (
			headerLine.includes("Date de la valeur (UTC)") &&
			headerLine.includes("Montant total (TTC)")
		) {
			return true;
		}
		return false;
	},

	parse(content: string): BankTransaction[] {
		const firstLine =
			content
				.replace(/\r\n/g, "\n")
				.replace(/\r/g, "\n")
				.split("\n")
				.find((line) => line.trim() !== "") ?? "";

		if (firstLine.includes("Date de la valeur (UTC)")) {
			return parseFrench(content);
		}
		return parseEnglish(content);
	},
};
