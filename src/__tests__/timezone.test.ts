/**
 * Timezone correctness tests
 *
 * All parsers create dates as UTC midnight (new Date("YYYY-MM-DDT00:00:00Z")).
 * formatDate() must use UTC methods (getUTCDate, getUTCMonth, getUTCFullYear)
 * so that the DDMMYY output matches the original calendar date regardless of
 * the runtime's local timezone — particularly in UTC-negative zones where a
 * UTC-midnight timestamp falls on the previous local calendar day.
 */

import { describe, expect, it } from "bun:test";
import type { CodaConfig } from "../mapper.ts";
import { mapToCoda } from "../mapper.ts";
import { parseTransactions } from "../parsers/index.ts";
import { formatDate, serializeCoda } from "../serializer.ts";

// ---------------------------------------------------------------------------
// 1. formatDate() unit tests — UTC dates
// ---------------------------------------------------------------------------

describe("formatDate() uses UTC methods", () => {
	it("returns 150126 for 2026-01-15T00:00:00Z", () => {
		expect(formatDate(new Date("2026-01-15T00:00:00Z"))).toBe("150126");
	});

	it("returns 010126 for 2026-01-01T00:00:00Z (NOT 311225)", () => {
		// In UTC-N timezones, local midnight on 2026-01-01 UTC is 2025-12-31
		// locally. Using getDate() would yield 311225; getUTCDate() gives 010126.
		expect(formatDate(new Date("2026-01-01T00:00:00Z"))).toBe("010126");
	});

	it("returns 311226 for 2026-12-31T00:00:00Z", () => {
		expect(formatDate(new Date("2026-12-31T00:00:00Z"))).toBe("311226");
	});

	it("handles year-boundary: 2025-12-31T00:00:00Z → 311225", () => {
		expect(formatDate(new Date("2025-12-31T00:00:00Z"))).toBe("311225");
	});

	it("handles year-boundary: 2026-01-01T00:00:00Z → 010126 (not 311225)", () => {
		expect(formatDate(new Date("2026-01-01T00:00:00Z"))).toBe("010126");
	});

	it("handles leap day 2024-02-29T00:00:00Z → 290224", () => {
		expect(formatDate(new Date("2024-02-29T00:00:00Z"))).toBe("290224");
	});

	it("handles end-of-February non-leap year 2023-02-28T00:00:00Z → 280223", () => {
		expect(formatDate(new Date("2023-02-28T00:00:00Z"))).toBe("280223");
	});
});

// ---------------------------------------------------------------------------
// 2. Full pipeline: CSV → parse → map → serialize → date fields preserved
// ---------------------------------------------------------------------------

describe("Full pipeline: dates in CODA output match CSV input dates", () => {
	it("single transaction on 2026-01-15 appears as 150126 in CODA output", () => {
		// Revolut Personal CSV with a single transaction on 2026-01-15
		const csv = [
			"Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance",
			"CARD_PAYMENT,Current,2026-01-15 10:30:00,2026-01-15 14:00:00,Supermarket,-42.50,0.00,EUR,COMPLETED,1957.50",
		].join("\n");

		const config: CodaConfig = {
			bankId: "539",
			accountIban: "BE68539007547034",
			accountCurrency: "EUR",
			accountHolderName: "Test User",
			openingBalance: 2000.0,
			openingBalanceDate: new Date("2026-01-14T00:00:00Z"),
		};

		const transactions = parseTransactions(csv, "revolut-personal");
		expect(transactions).toHaveLength(1);

		// Verify the parser produced a UTC-midnight date for 2026-01-15
		const txDate = transactions[0].date;
		expect(txDate).toBeInstanceOf(Date);
		expect((txDate as Date).toISOString()).toMatch(/^2026-01-15T00:00:00/);

		const statement = mapToCoda(transactions, config);
		const codaContent = serializeCoda(statement);

		// Record 21 starts with "21" at position 0.
		// Entry date is at positions 47-52 (DDMMYY) — find the movement line.
		const lines = codaContent.split("\n").filter((l) => l.startsWith("21"));
		expect(lines.length).toBeGreaterThanOrEqual(1);

		const entryDate = lines[0].slice(47, 53); // DDMMYY
		expect(entryDate).toBe("150126");

		const valueDate = lines[0].slice(115, 121); // DDMMYY
		expect(valueDate).toBe("150126");
	});

	it("transaction on year-boundary 2026-01-01 appears as 010126 (not 311225)", () => {
		const csv = [
			"Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance",
			"TRANSFER,Current,2026-01-01 00:00:00,2026-01-01 00:00:01,New Year Transfer,100.00,0.00,EUR,COMPLETED,1100.00",
		].join("\n");

		const config: CodaConfig = {
			bankId: "539",
			accountIban: "BE68539007547034",
			accountCurrency: "EUR",
			accountHolderName: "Test User",
			openingBalance: 1000.0,
			openingBalanceDate: new Date("2025-12-31T00:00:00Z"),
		};

		const transactions = parseTransactions(csv, "revolut-personal");
		expect(transactions).toHaveLength(1);

		const txDate = transactions[0].date as Date;
		expect(txDate.toISOString()).toMatch(/^2026-01-01T00:00:00/);

		const statement = mapToCoda(transactions, config);
		const codaContent = serializeCoda(statement);

		const lines = codaContent.split("\n").filter((l) => l.startsWith("21"));
		expect(lines.length).toBeGreaterThanOrEqual(1);

		const entryDate = lines[0].slice(47, 53);
		expect(entryDate).toBe("010126"); // must not be "311225"
	});
});
