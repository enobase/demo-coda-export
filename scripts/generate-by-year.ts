#!/usr/bin/env bun
/**
 * Generate CODA files from a Qonto CSV export, split by year.
 *
 * Usage:
 *   bun scripts/generate-by-year.ts <input.csv> <output-prefix> [--iban IBAN] [--holder NAME] [--bic BIC]
 *
 * Example:
 *   bun scripts/generate-by-year.ts ~/Desktop/export.csv ~/Desktop/subscale_fr \
 *     --iban FR7616958000019194362258897 --holder "Subscale FR" --bic QNTOFRP1
 */

import { writeFileSync } from "node:fs";
import { encodeLatin1 } from "../src/encoding.ts";
import type { CodaConfig } from "../src/mapper.ts";
import { mapToCoda } from "../src/mapper.ts";
import { parseTransactions } from "../src/parsers/index.ts";
import { serializeCoda } from "../src/serializer.ts";
import { validate } from "../src/validator.ts";

// Parse args
const args = process.argv.slice(2);
const inputPath = args[0];
const outputPrefix = args[1];

if (!inputPath || !outputPrefix) {
	console.error("Usage: bun scripts/generate-by-year.ts <input.csv> <output-prefix> [--iban IBAN] [--holder NAME] [--bic BIC] [--company-id ID]");
	process.exit(1);
}

function getFlag(name: string): string | undefined {
	const idx = args.indexOf(`--${name}`);
	if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
	return undefined;
}

const iban = getFlag("iban") ?? "FR7616958000019194362258897";
const holder = getFlag("holder") ?? "Subscale FR";
const bic = getFlag("bic") ?? "QNTOFRP1";
const companyId = getFlag("company-id");

// Read and parse CSV
const csvContent = await Bun.file(inputPath).text();
const allTransactions = parseTransactions(csvContent);

console.log(`Parsed ${allTransactions.length} transactions total`);

// Group by year (based on transaction date)
const byYear = new Map<number, typeof allTransactions>();
for (const tx of allTransactions) {
	const year = tx.date.getUTCFullYear();
	if (!byYear.has(year)) byYear.set(year, []);
	byYear.get(year)!.push(tx);
}

// Sort years
const years = [...byYear.keys()].sort();
console.log(`Years: ${years.join(", ")}`);

// Generate CODA file per year
// For the first year, opening balance = 0 (or we can infer it)
// For subsequent years, opening balance = closing balance of previous year
let runningBalance = 0;

// We need to figure out the opening balance. For the very first year,
// we can try to infer it from the CSV's "Solde" column.
// The Qonto FR CSV has a "Solde" (balance) column. The opening balance
// is: balance_after_earliest_tx - amount_of_earliest_tx
const firstYearTxs = byYear.get(years[0])!;
// Sort by date ascending
const sorted = [...firstYearTxs].sort((a, b) => a.date.getTime() - b.date.getTime());
if (sorted[0]?.balance !== undefined) {
	runningBalance = sorted[0].balance - sorted[0].amount;
	console.log(`Inferred opening balance for ${years[0]}: ${runningBalance}`);
} else {
	console.log(`No balance column found, starting with opening balance = 0`);
}

// Derive bank ID from IBAN (first 3 chars of BBAN for non-Belgian)
const normalizedIban = iban.replace(/\s/g, "").toUpperCase();
const bankId = normalizedIban.startsWith("BE")
	? normalizedIban.slice(4, 7)
	: normalizedIban.slice(4, 7);

// Also generate one combined file
let allCodaContent = "";

for (const year of years) {
	const txs = byYear.get(year)!;
	// Sort transactions by date ascending within each year
	const sortedTxs = [...txs].sort((a, b) => a.date.getTime() - b.date.getTime());

	// Opening balance date = day before first transaction
	const firstDate = sortedTxs[0].date;
	const openingDate = new Date(firstDate);
	openingDate.setUTCDate(openingDate.getUTCDate() - 1);

	const config: CodaConfig = {
		bankId,
		accountIban: normalizedIban,
		accountCurrency: "EUR",
		accountHolderName: holder,
		bic,
		openingBalance: runningBalance,
		openingBalanceDate: openingDate,
	};
	if (companyId) config.companyId = companyId;

	const statement = mapToCoda(sortedTxs, config);
	const codaContent = serializeCoda(statement);

	// Validate
	const result = validate(codaContent);
	if (!result.valid) {
		console.error(`Validation errors for ${year}:`);
		for (const e of result.errors) {
			console.error(`  ${e.severity}: ${e.message} (line ${e.line})`);
		}
		process.exit(1);
	}

	// Write per-year file
	const outPath = `${outputPrefix}_${year}.cod`;
	writeFileSync(outPath, encodeLatin1(codaContent));
	console.log(`  ${year}: ${sortedTxs.length} transactions → ${outPath}`);

	// Accumulate for combined file
	allCodaContent += codaContent;

	// Update running balance for next year
	// Sum all amounts in this year
	let yearNet = 0;
	for (const tx of sortedTxs) {
		yearNet += tx.amount;
		if (tx.fee) yearNet -= Math.abs(tx.fee);
	}
	runningBalance += yearNet;
}

// Write combined file
const combinedPath = `${outputPrefix}.cod`;
writeFileSync(combinedPath, encodeLatin1(allCodaContent));
console.log(`\nCombined file: ${combinedPath}`);
console.log("Done!");
