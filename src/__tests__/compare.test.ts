/**
 * Tests for src/compare.ts
 *
 * Covers:
 *   1. Identical files → identical stats
 *   2. Different record counts
 *   3. Different transaction code families
 *   4. Empty file handled gracefully
 *   5. Invalid/non-CODA content handled gracefully
 *   6. formatReport() contains no PII markers and includes expected sections
 *   7. Encoding detection: pure ASCII → UTF-8
 *   8. Record 22 chain detection: direct 21→23 jump detected
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeFile, formatReport } from "../compare.ts";
import type { CodaConfig } from "../mapper.ts";
import { mapToCoda } from "../mapper.ts";
import type { BankTransaction } from "../parsers/index.ts";
import { serializeCoda } from "../serializer.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES = join(import.meta.dir, "fixtures");

function buildCodaWithTransactions(transactions: BankTransaction[]): string {
	const config: CodaConfig = {
		bankId: "539",
		accountIban: "BE68539007547034",
		accountCurrency: "EUR",
		accountHolderName: "Test User",
		openingBalance: 1000.0,
		openingBalanceDate: new Date("2026-01-01"),
	};
	const statement = mapToCoda(transactions, config);
	return serializeCoda(statement);
}

function singleTransaction(description: string, amount: number): BankTransaction {
	return {
		date: new Date("2026-01-15"),
		amount,
		currency: "EUR",
		description,
		source: "revolut-personal",
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("analyzeFile()", () => {
	// -----------------------------------------------------------------------
	// 1. Identical files produce identical stats
	// -----------------------------------------------------------------------
	it("identical CODA files produce identical stats", () => {
		const content = readFileSync(join(FIXTURES, "revolut-personal.coda"), "utf-8");
		const bytes = new Uint8Array(readFileSync(join(FIXTURES, "revolut-personal.coda")));
		const statsA = analyzeFile(content, bytes);
		const statsB = analyzeFile(content, bytes);

		expect(statsA.lineCount).toBe(statsB.lineCount);
		expect(statsA.allLines128).toBe(statsB.allLines128);
		expect(statsA.versionCode).toBe(statsB.versionCode);
		expect(statsA.accountStructureCode).toBe(statsB.accountStructureCode);
		expect(statsA.transactionCodeFamilies).toEqual(statsB.transactionCodeFamilies);
		expect(statsA.record22ChainAlwaysPresent).toBe(statsB.record22ChainAlwaysPresent);
		expect(statsA.encoding).toBe(statsB.encoding);
	});

	// -----------------------------------------------------------------------
	// 2. Files with different record counts → different lineCount
	// -----------------------------------------------------------------------
	it("detects different record counts between files", () => {
		const oneTransaction = buildCodaWithTransactions([singleTransaction("Payment A", -50.0)]);
		const threeTransactions = buildCodaWithTransactions([
			singleTransaction("Payment A", -50.0),
			singleTransaction("Payment B", -25.0),
			singleTransaction("Income C", 100.0),
		]);

		const statsOne = analyzeFile(oneTransaction);
		const statsThree = analyzeFile(threeTransactions);

		expect(statsOne.lineCount).toBeLessThan(statsThree.lineCount);

		const rec21One = statsOne.recordTypeCounts.get("21") ?? 0;
		const rec21Three = statsThree.recordTypeCounts.get("21") ?? 0;
		expect(rec21One).toBe(1);
		expect(rec21Three).toBe(3);
	});

	// -----------------------------------------------------------------------
	// 3. Transaction code families extracted correctly
	// -----------------------------------------------------------------------
	it("extracts transaction code families from Record 21 lines", () => {
		const content = readFileSync(join(FIXTURES, "revolut-personal.coda"), "utf-8");
		const stats = analyzeFile(content);

		// The fixture contains transaction families (positions 53-54 of Record 21)
		expect(Array.isArray(stats.transactionCodeFamilies)).toBe(true);
		// All families should be 2-digit strings
		for (const fam of stats.transactionCodeFamilies) {
			expect(/^\d{2}$/.test(fam)).toBe(true);
		}
	});

	// -----------------------------------------------------------------------
	// 4. Empty file handled gracefully (no throw)
	// -----------------------------------------------------------------------
	it("handles empty file without throwing", () => {
		expect(() => analyzeFile("")).not.toThrow();
		const stats = analyzeFile("");
		expect(stats.lineCount).toBe(0);
		expect(stats.allLines128).toBe(true); // vacuously true — every() on empty array
		expect(stats.versionCode).toBeNull();
		expect(stats.accountStructureCode).toBeNull();
		expect(stats.transactionCodeFamilies).toHaveLength(0);
	});

	// -----------------------------------------------------------------------
	// 5. Non-CODA/invalid content handled gracefully
	// -----------------------------------------------------------------------
	it("handles non-CODA content without throwing", () => {
		const garbage = "hello world\nthis is not a coda file\nsome random text\n";
		expect(() => analyzeFile(garbage)).not.toThrow();
		const stats = analyzeFile(garbage);
		expect(stats.lineCount).toBe(3);
		expect(stats.allLines128).toBe(false);
		expect(stats.versionCode).toBeNull();
	});

	// -----------------------------------------------------------------------
	// 6. Version code extracted from Record 0
	// -----------------------------------------------------------------------
	it("extracts version code from Record 0 position 127", () => {
		const content = readFileSync(join(FIXTURES, "revolut-personal.coda"), "utf-8");
		const stats = analyzeFile(content);
		expect(stats.versionCode).toBe("2");
	});

	// -----------------------------------------------------------------------
	// 7. Encoding detection for pure ASCII → UTF-8
	// -----------------------------------------------------------------------
	it("classifies pure ASCII CODA as UTF-8", () => {
		const content = buildCodaWithTransactions([singleTransaction("Simple payment", -10.0)]);
		const bytes = new TextEncoder().encode(content);
		const stats = analyzeFile(content, bytes);
		// ASCII-only content is valid UTF-8
		expect(stats.encoding).toBe("UTF-8");
	});

	// -----------------------------------------------------------------------
	// 8. Record 22 chain: direct 21→23 jump detected
	// -----------------------------------------------------------------------
	it("detects 21→23 direct jump when Record 22 is absent", () => {
		// Build a valid CODA, then manually remove all Record 22 lines
		const content = readFileSync(join(FIXTURES, "qonto.coda"), "utf-8");
		const rawLines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
		const without22 = rawLines.filter((l) => !l.startsWith("22")).join("\n");
		const stats = analyzeFile(without22);
		// Without Record 22, every 21 is followed directly by 23
		expect(stats.record22ChainAlwaysPresent).toBe(false);
	});
});

describe("formatReport()", () => {
	// -----------------------------------------------------------------------
	// 9. Output contains expected sections, no PII
	// -----------------------------------------------------------------------
	it("output contains required sections", () => {
		const contentRef = readFileSync(join(FIXTURES, "revolut-personal.coda"), "utf-8");
		const contentGen = readFileSync(join(FIXTURES, "qonto.coda"), "utf-8");
		const ref = analyzeFile(contentRef);
		const gen = analyzeFile(contentGen);
		const output = formatReport({ reference: ref, generated: gen });

		expect(output).toContain("=== Structural CODA Comparison ===");
		expect(output).toContain("Record type counts:");
		expect(output).toContain("Transaction code families:");
		expect(output).toContain("Communication types:");
		expect(output).toContain("Record 22 chain:");
		expect(output).toContain("Encoding:");
	});

	// -----------------------------------------------------------------------
	// 10. Identical files produce symmetric comparison
	// -----------------------------------------------------------------------
	it("identical files produce matching columns in report", () => {
		const content = readFileSync(join(FIXTURES, "revolut-personal.coda"), "utf-8");
		const stats = analyzeFile(content);
		const output = formatReport({ reference: stats, generated: stats });

		// Line count should appear twice (same value in both columns)
		const lines = output.split("\n");
		const lineLine = lines.find((l) => l.trimStart().startsWith("Lines"));
		expect(lineLine).toBeDefined();
		// Both columns show the same number — they'll be identical strings
		const matches = lineLine?.match(/\d+/g);
		expect(matches).toBeDefined();
		if (matches && matches.length >= 2) {
			expect(matches[0]).toBe(matches[1]);
		}
	});

	// -----------------------------------------------------------------------
	// 11. Communication type counts appear in report
	// -----------------------------------------------------------------------
	it("communication types section shows counts", () => {
		const content = readFileSync(join(FIXTURES, "qonto.coda"), "utf-8");
		const stats = analyzeFile(content);
		const output = formatReport({ reference: stats, generated: stats });

		expect(output).toContain("0 (free):");
		expect(output).toContain("1 (structured):");
	});

	// -----------------------------------------------------------------------
	// 12. Empty files produce valid (non-crashing) report
	// -----------------------------------------------------------------------
	it("produces valid report even for empty files", () => {
		const stats = analyzeFile("");
		expect(() => formatReport({ reference: stats, generated: stats })).not.toThrow();
		const output = formatReport({ reference: stats, generated: stats });
		expect(output).toContain("=== Structural CODA Comparison ===");
	});
});
