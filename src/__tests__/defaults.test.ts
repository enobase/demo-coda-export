/**
 * defaults.ts — unit tests
 *
 * Tests for:
 *   - inferOutputPath: extension replacement / appending
 *   - inferOpeningDate: day-before-earliest logic and empty-array guard
 */

import { describe, expect, it } from "bun:test";
import { inferOpeningDate, inferOutputPath, inferCsvDefaults } from "../defaults.ts";
import type { BankTransaction } from "../parsers/index.ts";

// ---------------------------------------------------------------------------
// inferOutputPath
// ---------------------------------------------------------------------------

describe("inferOutputPath()", () => {
	it('replaces .csv extension with .cod — "foo.csv" -> "foo.cod"', () => {
		expect(inferOutputPath("foo.csv")).toBe("foo.cod");
	});

	it('appends .cod when there is no extension — "foo" -> "foo.cod"', () => {
		expect(inferOutputPath("foo")).toBe("foo.cod");
	});

	it('handles nested paths — "path/to/file.csv" -> "path/to/file.cod"', () => {
		expect(inferOutputPath("path/to/file.csv")).toBe("path/to/file.cod");
	});

	it('replaces non-csv extensions too — "export.txt" -> "export.cod"', () => {
		expect(inferOutputPath("export.txt")).toBe("export.cod");
	});

	it('handles paths with no extension in a subdirectory — "path/to/file" -> "path/to/file.cod"', () => {
		expect(inferOutputPath("path/to/file")).toBe("path/to/file.cod");
	});
});

// ---------------------------------------------------------------------------
// inferOpeningDate
// ---------------------------------------------------------------------------

describe("inferOpeningDate()", () => {
	it("returns null for an empty transactions array", () => {
		expect(inferOpeningDate([])).toBeNull();
	});

	it("returns the day before the single transaction date", () => {
		const result = inferOpeningDate([{ date: new Date("2026-01-15") }]);
		expect(result).not.toBeNull();
		// Day before 2026-01-15 is 2026-01-14
		expect(result?.toISOString().slice(0, 10)).toBe("2026-01-14");
	});

	it("returns the day before the earliest date when multiple transactions", () => {
		const transactions = [
			{ date: new Date("2026-03-10") },
			{ date: new Date("2026-01-05") },
			{ date: new Date("2026-02-20") },
		];
		const result = inferOpeningDate(transactions);
		expect(result).not.toBeNull();
		// Day before 2026-01-05 is 2026-01-04
		expect(result?.toISOString().slice(0, 10)).toBe("2026-01-04");
	});

	it("handles a month boundary correctly (day 1 -> previous month last day)", () => {
		const result = inferOpeningDate([{ date: new Date("2026-03-01") }]);
		expect(result).not.toBeNull();
		// Day before 2026-03-01 is 2026-02-28
		expect(result?.toISOString().slice(0, 10)).toBe("2026-02-28");
	});

	it("handles a year boundary correctly (Jan 1 -> Dec 31 previous year)", () => {
		const result = inferOpeningDate([{ date: new Date("2026-01-01") }]);
		expect(result).not.toBeNull();
		// Day before 2026-01-01 is 2025-12-31
		expect(result?.toISOString().slice(0, 10)).toBe("2025-12-31");
	});

	it("uses UTC arithmetic — not affected by local timezone offset", () => {
		// Create a date at UTC midnight. With local-time setDate/getDate in a
		// positive-offset timezone (e.g. UTC+13), the local date is already
		// "tomorrow" relative to the UTC date, so subtracting 1 day in local
		// time could yield a different UTC date than expected.
		// Using setUTCDate/getUTCDate avoids this.
		const txDate = new Date("2026-03-29T00:00:00Z");
		const result = inferOpeningDate([{ date: txDate }]);
		expect(result).not.toBeNull();
		// Should always be 2026-03-28 regardless of local timezone
		expect(result!.getUTCFullYear()).toBe(2026);
		expect(result!.getUTCMonth()).toBe(2); // March = 2
		expect(result!.getUTCDate()).toBe(28);
	});
});

// ---------------------------------------------------------------------------
// inferCsvDefaults
// ---------------------------------------------------------------------------

function makeTx(overrides: Partial<BankTransaction>): BankTransaction {
	return {
		date: new Date("2026-01-10"),
		amount: 100,
		currency: "EUR",
		description: "Test",
		source: "revolut-personal",
		...overrides,
	};
}

describe("inferCsvDefaults()", () => {
	it("returns undefined values for an empty transactions array", () => {
		const result = inferCsvDefaults([]);
		expect(result.currency).toBeUndefined();
		expect(result.holderName).toBeUndefined();
	});

	it("returns the currency when all transactions share one currency", () => {
		const txs = [
			makeTx({ currency: "EUR" }),
			makeTx({ currency: "EUR" }),
			makeTx({ currency: "EUR" }),
		];
		const result = inferCsvDefaults(txs);
		expect(result.currency).toBe("EUR");
	});

	it("returns the most common currency when multiple currencies are present", () => {
		const txs = [
			makeTx({ currency: "EUR" }),
			makeTx({ currency: "EUR" }),
			makeTx({ currency: "USD" }),
		];
		const result = inferCsvDefaults(txs);
		expect(result.currency).toBe("EUR");
	});

	it("returns a currency even for a single transaction", () => {
		const result = inferCsvDefaults([makeTx({ currency: "GBP" })]);
		expect(result.currency).toBe("GBP");
	});

	it("handles transactions from revolut-personal source", () => {
		const txs = [
			makeTx({ currency: "EUR", source: "revolut-personal" }),
			makeTx({ currency: "EUR", source: "revolut-personal" }),
		];
		const result = inferCsvDefaults(txs);
		expect(result.currency).toBe("EUR");
		expect(result.holderName).toBeUndefined();
	});

	it("handles transactions from qonto source", () => {
		const txs = [
			makeTx({ currency: "EUR", source: "qonto" }),
			makeTx({ currency: "EUR", source: "qonto" }),
		];
		const result = inferCsvDefaults(txs);
		expect(result.currency).toBe("EUR");
		expect(result.holderName).toBeUndefined();
	});

	it("handles transactions from n26 source", () => {
		const txs = [
			makeTx({ currency: "EUR", source: "n26" }),
		];
		const result = inferCsvDefaults(txs);
		expect(result.currency).toBe("EUR");
		// N26 does not expose a reliable holder name
		expect(result.holderName).toBeUndefined();
	});

	it("handles transactions from wise source", () => {
		const txs = [
			makeTx({ currency: "GBP", source: "wise" }),
			makeTx({ currency: "GBP", source: "wise" }),
		];
		const result = inferCsvDefaults(txs);
		expect(result.currency).toBe("GBP");
	});

	it("handles transactions from revolut-business source", () => {
		const txs = [
			makeTx({ currency: "USD", source: "revolut-business" }),
			makeTx({ currency: "EUR", source: "revolut-business" }),
			makeTx({ currency: "USD", source: "revolut-business" }),
		];
		const result = inferCsvDefaults(txs);
		// USD appears twice, EUR once
		expect(result.currency).toBe("USD");
	});
});
