/**
 * Phase 4: End-to-end integration tests
 *
 * Tests the full pipeline:
 *   CSV → parseTransactions() → mapToCoda() → serializeCoda() → validate()
 *
 * Also tests edge cases and golden file comparison.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodaConfig } from "../mapper.ts";
import { mapToCoda } from "../mapper.ts";
import type { BankTransaction } from "../parsers/index.ts";
import { parseTransactions } from "../parsers/index.ts";
import { serializeCoda } from "../serializer.ts";
import { validate } from "../validator.ts";

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const FIXTURES_CSV = join(import.meta.dir, "../parsers/__tests__/fixtures");
const FIXTURES_GOLDEN = join(import.meta.dir, "fixtures");

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function readCsv(filename: string): string {
	return readFileSync(join(FIXTURES_CSV, filename), "utf-8");
}

function makeConfig(overrides: Partial<CodaConfig> = {}): CodaConfig {
	return {
		bankId: "539",
		accountIban: "BE68539007547034",
		accountCurrency: "EUR",
		accountHolderName: "Test User",
		openingBalance: 2000.0,
		openingBalanceDate: new Date("2026-01-14"),
		...overrides,
	};
}

function makeTx(overrides: Partial<BankTransaction> = {}): BankTransaction {
	return {
		date: new Date("2026-01-15"),
		amount: 100.0,
		currency: "EUR",
		description: "Test transaction",
		source: "revolut-personal",
		...overrides,
	};
}

/**
 * Run the full pipeline: CSV → parse → map → serialize → validate
 * Returns the CODA content and validation result.
 */
function fullPipeline(
	csvContent: string,
	config: CodaConfig,
	format?: "revolut-personal" | "revolut-business" | "qonto",
) {
	const transactions = parseTransactions(csvContent, format);
	const statement = mapToCoda(transactions, config);
	const codaContent = serializeCoda(statement);
	const validationResult = validate(codaContent);
	return { transactions, statement, codaContent, validationResult };
}

// ---------------------------------------------------------------------------
// 1. Revolut Personal → CODA full pipeline
// ---------------------------------------------------------------------------

describe("Revolut Personal → CODA full pipeline", () => {
	const csv = readCsv("revolut-personal.csv");
	const config = makeConfig({
		bankId: "535",
		accountHolderName: "Test User",
		bic: "REVOLT21",
		openingBalance: 2000.0,
		openingBalanceDate: new Date("2026-01-14"),
	});

	it("parses and maps without throwing", () => {
		expect(() => fullPipeline(csv, config, "revolut-personal")).not.toThrow();
	});

	it("produces a valid CODA file", () => {
		const { validationResult } = fullPipeline(csv, config, "revolut-personal");
		expect(validationResult.valid).toBe(true);
		expect(validationResult.errors.filter((e) => e.severity === "error")).toHaveLength(0);
	});

	it("every line is exactly 128 characters", () => {
		const { codaContent } = fullPipeline(csv, config, "revolut-personal");
		const lines = codaContent.trimEnd().split("\n");
		for (const line of lines) {
			expect(line.length).toBe(128);
		}
	});

	it("has the correct number of lines (1 header + 1 old balance + N movements + 1 new balance + 1 trailer)", () => {
		const { codaContent, transactions } = fullPipeline(csv, config, "revolut-personal");
		const lines = codaContent.trimEnd().split("\n");
		// Revolut personal fixture: 8 COMPLETED transactions, each is a single Record21
		// So total = 1 + 1 + 8 + 1 + 1 = 12
		expect(lines[0][0]).toBe("0");
		expect(lines[1][0]).toBe("1");
		expect(lines[lines.length - 2][0]).toBe("8");
		expect(lines[lines.length - 1][0]).toBe("9");
		expect(lines.length).toBeGreaterThanOrEqual(4 + transactions.length);
	});

	it("trailer record count matches actual records (excluding 0 and 9)", () => {
		const { codaContent } = fullPipeline(csv, config, "revolut-personal");
		const lines = codaContent.trimEnd().split("\n");
		const trailer = lines[lines.length - 1];
		const claimedCount = Number(trailer.slice(16, 22));
		expect(claimedCount).toBe(lines.length - 2);
	});

	it("golden file comparison (excluding creation date in header)", () => {
		const { codaContent } = fullPipeline(csv, config, "revolut-personal");
		const goldenPath = join(FIXTURES_GOLDEN, "revolut-personal.coda");
		const golden = readFileSync(goldenPath, "utf-8");

		// Compare everything except the creation date at positions [1:11] of the first line
		const normalize = (content: string) => {
			const lines = content.trimEnd().split("\n");
			// Blank out creation date (positions 1-10) in header line
			lines[0] = `${lines[0][0]}          ${lines[0].slice(11)}`;
			return lines.join("\n");
		};

		expect(normalize(codaContent)).toBe(normalize(golden));
	});
});

// ---------------------------------------------------------------------------
// 2. Revolut Business → CODA full pipeline
// ---------------------------------------------------------------------------

describe("Revolut Business → CODA full pipeline", () => {
	const csv = readCsv("revolut-business.csv");
	const config = makeConfig({
		bankId: "535",
		accountIban: "BE68539007547034",
		accountHolderName: "ACME BVBA",
		openingBalance: 10000.0,
		openingBalanceDate: new Date("2026-01-31"),
	});

	it("parses and maps without throwing", () => {
		expect(() => fullPipeline(csv, config, "revolut-business")).not.toThrow();
	});

	it("produces a valid CODA file", () => {
		const { validationResult } = fullPipeline(csv, config, "revolut-business");
		expect(validationResult.valid).toBe(true);
	});

	it("every line is exactly 128 characters", () => {
		const { codaContent } = fullPipeline(csv, config, "revolut-business");
		for (const line of codaContent.trimEnd().split("\n")) {
			expect(line.length).toBe(128);
		}
	});

	it("contains Record 22 lines for transactions with BIC", () => {
		const { codaContent } = fullPipeline(csv, config, "revolut-business");
		const lines = codaContent.trimEnd().split("\n");
		const rec22Lines = lines.filter((l) => l.startsWith("22"));
		expect(rec22Lines.length).toBeGreaterThan(0);
	});

	it("contains Record 23 lines for transactions with IBAN", () => {
		const { codaContent } = fullPipeline(csv, config, "revolut-business");
		const lines = codaContent.trimEnd().split("\n");
		const rec23Lines = lines.filter((l) => l.startsWith("23"));
		expect(rec23Lines.length).toBeGreaterThan(0);
	});

	it("debit and credit totals match trailer", () => {
		const { codaContent } = fullPipeline(csv, config, "revolut-business");
		const lines = codaContent.trimEnd().split("\n");
		const trailer = lines[lines.length - 1];
		const claimedDebit = BigInt(trailer.slice(22, 37));
		const claimedCredit = BigInt(trailer.slice(37, 52));

		let totalDebit = 0n;
		let totalCredit = 0n;
		for (const line of lines) {
			if (!line.startsWith("21")) continue;
			const sign = line[31];
			const amount = BigInt(line.slice(32, 47));
			if (sign === "1") totalDebit += amount;
			else totalCredit += amount;
		}

		expect(claimedDebit).toBe(totalDebit);
		expect(claimedCredit).toBe(totalCredit);
	});
});

// ---------------------------------------------------------------------------
// 3. Qonto → CODA full pipeline
// ---------------------------------------------------------------------------

describe("Qonto → CODA full pipeline", () => {
	const csv = readCsv("qonto.csv");
	const config = makeConfig({
		bankId: "535",
		accountIban: "BE71096123456769",
		accountHolderName: "Client Alpha BVBA",
		openingBalance: 10000.0,
		openingBalanceDate: new Date("2026-01-09"),
		statementSequence: 2,
	});

	it("parses and maps without throwing", () => {
		expect(() => fullPipeline(csv, config, "qonto")).not.toThrow();
	});

	it("produces a valid CODA file", () => {
		const { validationResult } = fullPipeline(csv, config, "qonto");
		expect(validationResult.valid).toBe(true);
	});

	it("every line is exactly 128 characters", () => {
		const { codaContent } = fullPipeline(csv, config, "qonto");
		for (const line of codaContent.trimEnd().split("\n")) {
			expect(line.length).toBe(128);
		}
	});

	it("structured OGM references appear in Record 21 with type=1", () => {
		const { codaContent } = fullPipeline(csv, config, "qonto");
		const lines = codaContent.trimEnd().split("\n");
		// Find Record 21 lines where communication type is "1"
		const ogmLines = lines.filter((l) => l.startsWith("21") && l[61] === "1");
		expect(ogmLines.length).toBeGreaterThan(0);
	});

	it("golden file comparison (excluding creation date)", () => {
		const { codaContent } = fullPipeline(csv, config, "qonto");
		const goldenPath = join(FIXTURES_GOLDEN, "qonto.coda");
		const golden = readFileSync(goldenPath, "utf-8");

		const normalize = (content: string) => {
			const lines = content.trimEnd().split("\n");
			lines[0] = `${lines[0][0]}          ${lines[0].slice(11)}`;
			return lines.join("\n");
		};

		expect(normalize(codaContent)).toBe(normalize(golden));
	});
});

// ---------------------------------------------------------------------------
// 4. Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
	// ---
	it("single transaction produces a valid CODA file", () => {
		const transactions = [makeTx({ amount: 50.0, description: "Single payment" })];
		const config = makeConfig({ openingBalance: 100.0 });
		const statement = mapToCoda(transactions, config);
		const coda = serializeCoda(statement);
		const result = validate(coda);
		expect(result.valid).toBe(true);
	});

	it("zero amount transaction produces a valid CODA file", () => {
		const transactions = [makeTx({ amount: 0, description: "Zero amount" })];
		const config = makeConfig();
		const statement = mapToCoda(transactions, config);
		const coda = serializeCoda(statement);
		const result = validate(coda);
		expect(result.valid).toBe(true);
	});

	it("large file (50+ transactions) produces a valid CODA file", () => {
		const transactions: BankTransaction[] = Array.from({ length: 55 }, (_, i) =>
			makeTx({
				date: new Date(`2026-01-${String((i % 28) + 1).padStart(2, "0")}`),
				amount: i % 2 === 0 ? -(10 + i) : 10 + i,
				description: `Transaction ${i + 1}`,
			}),
		);
		const config = makeConfig({ openingBalance: 5000.0 });
		const statement = mapToCoda(transactions, config);
		const coda = serializeCoda(statement);
		const result = validate(coda);
		expect(result.valid).toBe(true);
		// 1 header + 1 old balance + 55 movements + 1 new balance + 1 trailer = 59
		const lines = coda.trimEnd().split("\n");
		expect(lines.length).toBe(59);
	});

	it("very long description splits into Record 22 continuation", () => {
		const longDesc = "A".repeat(120); // longer than 53 chars → spills into rec22
		const transactions = [makeTx({ description: longDesc })];
		const config = makeConfig();
		const statement = mapToCoda(transactions, config);
		const coda = serializeCoda(statement);

		const lines = coda.trimEnd().split("\n");
		// Record 21 should have continuation flag "1"
		const rec21 = lines.find((l) => l.startsWith("21"));
		expect(rec21).toBeDefined();
		expect(rec21?.[127]).toBe("1");

		// A Record 22 should follow
		const rec22 = lines.find((l) => l.startsWith("22"));
		expect(rec22).toBeDefined();

		const result = validate(coda);
		expect(result.valid).toBe(true);
	});

	it("Belgian OGM reference uses structured communication type", () => {
		const transactions = [
			makeTx({
				reference: "+++090/9337/55493+++",
				description: "Payment with OGM",
			}),
		];
		const config = makeConfig();
		const statement = mapToCoda(transactions, config);
		const coda = serializeCoda(statement);

		const lines = coda.trimEnd().split("\n");
		const rec21 = lines.find((l) => l.startsWith("21"));
		expect(rec21).toBeDefined();
		// Communication type at position 61 should be "1"
		expect(rec21?.[61]).toBe("1");
		// Communication should contain the OGM reference
		const comm = rec21?.slice(62, 115).trimEnd();
		expect(comm).toContain("+++090/9337/55493+++");

		const result = validate(coda);
		expect(result.valid).toBe(true);
	});

	it("mixed credit/debit transactions compute correct totals", () => {
		const transactions: BankTransaction[] = [
			makeTx({ amount: 500.0, description: "Credit 1" }),
			makeTx({ amount: -200.0, description: "Debit 1" }),
			makeTx({ amount: 300.0, description: "Credit 2" }),
			makeTx({ amount: -100.0, description: "Debit 2" }),
		];
		const config = makeConfig({ openingBalance: 1000.0 });
		const statement = mapToCoda(transactions, config);
		const coda = serializeCoda(statement);

		const result = validate(coda);
		expect(result.valid).toBe(true);

		// Check trailer totals
		const lines = coda.trimEnd().split("\n");
		const trailer = lines[lines.length - 1];
		const claimedDebit = BigInt(trailer.slice(22, 37));
		const claimedCredit = BigInt(trailer.slice(37, 52));
		// 200 + 100 = 300 debits → 300000 milli-cents
		expect(claimedDebit).toBe(300000n);
		// 500 + 300 = 800 credits → 800000 milli-cents
		expect(claimedCredit).toBe(800000n);
	});

	it("negative opening balance produces a valid CODA file", () => {
		const transactions = [makeTx({ amount: 100.0 })];
		const config = makeConfig({ openingBalance: -500.0 });
		const statement = mapToCoda(transactions, config);
		const coda = serializeCoda(statement);
		const result = validate(coda);
		expect(result.valid).toBe(true);

		// Check old balance sign in Record 1
		const lines = coda.trimEnd().split("\n");
		const rec1 = lines.find((l) => l[0] === "1");
		expect(rec1).toBeDefined();
		expect(rec1?.[42]).toBe("1"); // sign "1" = debit/negative
	});

	it("transaction with counterparty IBAN emits Record 23", () => {
		const transactions = [
			makeTx({
				amount: -250.0,
				counterpartyIban: "BE71096123456769",
				counterpartyName: "Supplier NV",
			}),
		];
		const config = makeConfig();
		const statement = mapToCoda(transactions, config);
		const coda = serializeCoda(statement);

		const lines = coda.trimEnd().split("\n");
		const rec23Lines = lines.filter((l) => l.startsWith("23"));
		expect(rec23Lines.length).toBe(1);

		const result = validate(coda);
		expect(result.valid).toBe(true);
	});

	it("transaction with foreign IBAN uses account structure 3", () => {
		const transactions = [
			makeTx({
				amount: -1000.0,
				counterpartyIban: "DE89370400440532013000",
				counterpartyName: "German Supplier GmbH",
			}),
		];
		const config = makeConfig();
		const statement = mapToCoda(transactions, config);
		const coda = serializeCoda(statement);
		const result = validate(coda);
		expect(result.valid).toBe(true);
	});

	it("empty transactions list produces a valid CODA file with no movements", () => {
		const config = makeConfig();
		const statement = mapToCoda([], config);
		const coda = serializeCoda(statement);
		const result = validate(coda);
		expect(result.valid).toBe(true);

		const lines = coda.trimEnd().split("\n");
		// Should have exactly: header, old balance, new balance, trailer = 4 lines
		expect(lines.length).toBe(4);
		// Trailer record count should be 2 (record 1 + record 8)
		const trailer = lines[lines.length - 1];
		expect(Number(trailer.slice(16, 22))).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// 5. Auto-detection
// ---------------------------------------------------------------------------

describe("Format auto-detection", () => {
	it("auto-detects revolut personal without explicit format", () => {
		const csv = readCsv("revolut-personal.csv");
		expect(() => {
			const txns = parseTransactions(csv);
			expect(txns.length).toBeGreaterThan(0);
			expect(txns[0].source).toBe("revolut-personal");
		}).not.toThrow();
	});

	it("auto-detects revolut business without explicit format", () => {
		const csv = readCsv("revolut-business.csv");
		expect(() => {
			const txns = parseTransactions(csv);
			expect(txns.length).toBeGreaterThan(0);
			expect(txns[0].source).toBe("revolut-business");
		}).not.toThrow();
	});

	it("auto-detects qonto without explicit format", () => {
		const csv = readCsv("qonto.csv");
		expect(() => {
			const txns = parseTransactions(csv);
			expect(txns.length).toBeGreaterThan(0);
			expect(txns[0].source).toBe("qonto");
		}).not.toThrow();
	});
});
