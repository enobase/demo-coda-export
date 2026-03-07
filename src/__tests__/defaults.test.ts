/**
 * defaults.ts — unit tests
 *
 * Tests for:
 *   - inferOutputPath: extension replacement / appending
 *   - inferOpeningDate: day-before-earliest logic and empty-array guard
 */

import { describe, expect, it } from "bun:test";
import { inferOpeningDate, inferOutputPath } from "../defaults.ts";

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
});
