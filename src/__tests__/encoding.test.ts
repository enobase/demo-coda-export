/**
 * Encoding utilities — Unit tests
 *
 * Tests for toLatin1Safe() and encodeLatin1(), plus full-pipeline
 * integration tests verifying that accented and non-Latin-1 characters
 * in CODA field values do not break the 128-char-per-line constraint.
 */

import { describe, expect, it } from "bun:test";
import { encodeLatin1, toLatin1Safe } from "../encoding.ts";
import type { CodaConfig } from "../mapper.ts";
import { mapToCoda } from "../mapper.ts";
import type { BankTransaction } from "../parsers/types.ts";
import { LINE_LENGTH, serializeCoda } from "../serializer.ts";
import { validate } from "../validator.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertAllLines128(output: string): void {
	const lines = output.split("\n").filter((l) => l.length > 0);
	for (const [i, line] of lines.entries()) {
		expect(line.length, `Line ${i} length`).toBe(LINE_LENGTH);
	}
}

function makeConfig(overrides: Partial<CodaConfig> = {}): CodaConfig {
	return {
		bankId: "539",
		accountIban: "BE68539007547034",
		accountCurrency: "EUR",
		accountHolderName: "Test User",
		openingBalance: 1000.0,
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

// ---------------------------------------------------------------------------
// 1. toLatin1Safe — character replacement
// ---------------------------------------------------------------------------

describe("toLatin1Safe", () => {
	it("passes through Latin-1 accented chars unchanged — Société Générale", () => {
		// All chars in "Société Générale" are in the Latin-1 range (U+00E9 = é, U+00E9)
		expect(toLatin1Safe("Société Générale")).toBe("Société Générale");
	});

	it("passes through umlauts unchanged — Müller Gärten", () => {
		// ü = U+00FC, ä = U+00E4, all within Latin-1
		expect(toLatin1Safe("Müller Gärten")).toBe("Müller Gärten");
	});

	it("replaces emoji with '?' — John 🏦 Doe", () => {
		// 🏦 is U+1F3E6, a supplementary character encoded as two UTF-16 code units
		// (a surrogate pair). Each code unit is above U+00FF so each becomes '?'.
		expect(toLatin1Safe("John 🏦 Doe")).toBe("John ?? Doe");
	});

	it("replaces CJK characters with '?' — 日本語テスト", () => {
		// Each CJK character is one BMP code unit (>U+00FF) → one '?'
		expect(toLatin1Safe("日本語テスト")).toBe("??????");
	});

	it("returns empty string unchanged", () => {
		expect(toLatin1Safe("")).toBe("");
	});

	it("passes through ASCII-only strings unchanged", () => {
		expect(toLatin1Safe("ASCII only")).toBe("ASCII only");
	});

	it("preserves string .length (1:1 code-unit replacement)", () => {
		const input = "John 🏦 Doe";
		const output = toLatin1Safe(input);
		// 🏦 is a surrogate pair (2 code units); each becomes '?',
		// so the output JS string .length equals the input .length exactly.
		expect(output.length).toBe(input.length);
	});

	it("handles the maximum Latin-1 codepoint U+00FF unchanged", () => {
		// U+00FF = ÿ (Latin small letter y with diaeresis)
		expect(toLatin1Safe("\u00FF")).toBe("\u00FF");
	});

	it("replaces the first codepoint above Latin-1 (U+0100)", () => {
		// U+0100 = Ā (Latin extended-A)
		expect(toLatin1Safe("\u0100")).toBe("?");
	});

	it("handles mixed Latin-1 and non-Latin-1 in one string", () => {
		// é (U+00E9) stays, 中 (U+4E2D) is replaced
		expect(toLatin1Safe("é中é")).toBe("é?é");
	});

	it("handles null-like replacement for codePointAt returning undefined (coverage)", () => {
		// Normal string of spaces — no undefined codepoints expected
		expect(toLatin1Safe("   ")).toBe("   ");
	});
});

// ---------------------------------------------------------------------------
// 2. encodeLatin1 — Buffer output
// ---------------------------------------------------------------------------

describe("encodeLatin1", () => {
	it("encodes 'é' as a 1-byte Buffer with value 0xE9", () => {
		const buf = encodeLatin1("é");
		expect(buf.length).toBe(1);
		expect(buf[0]).toBe(0xe9);
	});

	it("buffer length equals string length for pure Latin-1 text", () => {
		const str = "Société";
		const buf = encodeLatin1(str);
		// Every char is Latin-1 → each encodes to exactly 1 byte
		expect(buf.length).toBe(str.length);
	});

	it("replaces non-Latin-1 chars before encoding — emoji becomes '??' (two 0x3F bytes)", () => {
		// 🏦 is a surrogate pair — 2 code units, each replaced with '?', so 2 bytes in output
		const buf = encodeLatin1("🏦");
		expect(buf.length).toBe(2);
		expect(buf[0]).toBe(0x3f); // ASCII '?'
		expect(buf[1]).toBe(0x3f); // ASCII '?'
	});

	it("encodes 'ü' as 0xFC", () => {
		const buf = encodeLatin1("ü");
		expect(buf.length).toBe(1);
		expect(buf[0]).toBe(0xfc);
	});

	it("encodes empty string as zero-length Buffer", () => {
		const buf = encodeLatin1("");
		expect(buf.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 3. Full pipeline — accented names in CODA fields
// ---------------------------------------------------------------------------

describe("Full pipeline with accented name — Société Générale", () => {
	const config = makeConfig({ accountHolderName: "Société Générale" });
	const transactions = [makeTx({ amount: 50.0, description: "Virement" })];

	it("serializes without throwing", () => {
		const statement = mapToCoda(transactions, config);
		expect(() => serializeCoda(statement)).not.toThrow();
	});

	it("every line is exactly 128 characters (Latin-1 default)", () => {
		const statement = mapToCoda(transactions, config);
		const coda = serializeCoda(statement);
		assertAllLines128(coda);
	});

	it("produces a valid CODA file", () => {
		const statement = mapToCoda(transactions, config);
		const coda = serializeCoda(statement);
		const result = validate(coda);
		expect(result.valid).toBe(true);
	});

	it("accented chars survive in the output string (all Latin-1)", () => {
		const statement = mapToCoda(transactions, config);
		const coda = serializeCoda(statement);
		// "Société Générale" is all Latin-1 — should appear verbatim in some line
		expect(coda).toContain("Société Générale");
	});

	it("encodeLatin1 of the output has byte-length equal to char count (all Latin-1)", () => {
		const statement = mapToCoda(transactions, config);
		const coda = serializeCoda(statement);
		const buf = encodeLatin1(coda);
		// Every char is Latin-1 → 1 byte each, so byte length equals JS string length
		expect(buf.length).toBe(coda.length);
	});
});

describe("Full pipeline with emoji in counterparty name — replaced with '?'", () => {
	const config = makeConfig();
	const transactions = [
		makeTx({
			amount: -200.0,
			counterpartyName: "Bank 🏦 NV",
			counterpartyIban: "BE71096123456769",
		}),
	];

	it("serializes without throwing", () => {
		const statement = mapToCoda(transactions, config);
		expect(() => serializeCoda(statement)).not.toThrow();
	});

	it("every line is exactly 128 characters after emoji replacement", () => {
		const statement = mapToCoda(transactions, config);
		const coda = serializeCoda(statement);
		assertAllLines128(coda);
	});

	it("produces a valid CODA file", () => {
		const statement = mapToCoda(transactions, config);
		const coda = serializeCoda(statement);
		const result = validate(coda);
		expect(result.valid).toBe(true);
	});

	it("emoji is replaced with '??' in the output (surrogate pair → two '?')", () => {
		const statement = mapToCoda(transactions, config);
		const coda = serializeCoda(statement);
		// 🏦 is a surrogate pair (2 code units), each becomes '?'
		expect(coda).toContain("Bank ?? NV");
		expect(coda).not.toContain("🏦");
	});
});

// ---------------------------------------------------------------------------
// 4. SerializeOptions — explicit encoding selection
// ---------------------------------------------------------------------------

describe("serializeCoda with explicit encoding option", () => {
	const config = makeConfig({ accountHolderName: "Société" });
	const transactions = [makeTx()];

	it("latin-1 encoding (explicit) sanitizes non-Latin-1 chars", () => {
		// 🚀 is a surrogate pair → becomes '??'
		const statement = mapToCoda(
			[makeTx({ counterpartyName: "🚀 Corp", counterpartyIban: "BE71096123456769" })],
			config,
		);
		const coda = serializeCoda(statement, { encoding: "latin-1" });
		assertAllLines128(coda);
		expect(coda).toContain("?? Corp");
	});

	it("utf-8 encoding skips Latin-1 sanitization but still produces 128-char lines for Latin-1 content", () => {
		const statement = mapToCoda(transactions, config);
		const coda = serializeCoda(statement, { encoding: "utf-8" });
		// "Société" is all Latin-1 so lines should still be 128 chars
		assertAllLines128(coda);
	});

	it("default encoding (no options) behaves identically to explicit latin-1", () => {
		const statement = mapToCoda(
			[makeTx({ counterpartyName: "Party NV", counterpartyIban: "BE71096123456769" })],
			config,
		);
		const codaDefault = serializeCoda(statement);
		const codaLatin1 = serializeCoda(statement, { encoding: "latin-1" });
		expect(codaDefault).toBe(codaLatin1);
	});
});
