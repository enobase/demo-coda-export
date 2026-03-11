/**
 * Phase 3: mapper.ts — comprehensive tests
 *
 * Covers:
 *   1. Config validation (8+ tests)
 *   2. Amount conversion (8+ tests)
 *   3. Transaction code mapping (10+ tests)
 *   4. Communication splitting (6+ tests)
 *   5. IBAN handling (5+ tests)
 *   6. Full mapping (5+ tests)
 *   7. Balance computation (3+ tests)
 *   8. Integration: parse → map → serialize → golden file
 *
 * Total: well over 60 test cases.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodaConfig } from "../mapper.ts";
import {
	buildCounterpartyAccountRaw,
	buildTransactionCode,
	detectOgm,
	formatOgm,
	ibanToAccountStructure,
	mapToCoda,
	splitCommunication,
	toMilliCents,
	toSignCode,
	validateConfig,
	validateOgmCheckDigit,
} from "../mapper.ts";
import { parseTransactions } from "../parsers/index.ts";
import type { BankTransaction } from "../parsers/types.ts";
import { serializeCoda } from "../serializer.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const BASE_CONFIG: CodaConfig = {
	bankId: "535",
	accountIban: "BE68539007547034",
	accountCurrency: "EUR",
	accountHolderName: "ACME BVBA",
	openingBalance: 1000.0,
	openingBalanceDate: new Date("2026-01-01"),
};

function makeTx(overrides: Partial<BankTransaction> = {}): BankTransaction {
	return {
		date: new Date("2026-01-15"),
		amount: -42.5,
		currency: "EUR",
		description: "Test transaction",
		source: "revolut-personal",
		rawType: "CARD_PAYMENT",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// 1. Config validation
// ---------------------------------------------------------------------------

describe("validateConfig", () => {
	it("accepts a valid config", () => {
		expect(() => validateConfig(BASE_CONFIG)).not.toThrow();
	});

	it("throws when accountIban is missing", () => {
		expect(() => validateConfig({ ...BASE_CONFIG, accountIban: "" })).toThrow(
			"accountIban is required",
		);
	});

	it("throws when accountIban contains spaces", () => {
		expect(() => validateConfig({ ...BASE_CONFIG, accountIban: "BE68 5390 0754 7034" })).toThrow(
			"must not contain spaces",
		);
	});

	it("throws when accountIban does not start with 2 letters + 2 digits", () => {
		expect(() => validateConfig({ ...BASE_CONFIG, accountIban: "1234567890" })).toThrow(
			"must start with 2 letters + 2 digits",
		);
	});

	it("throws when bankId is empty", () => {
		expect(() => validateConfig({ ...BASE_CONFIG, bankId: "" })).toThrow("bankId must be 1");
	});

	it("throws when bankId is longer than 3 chars", () => {
		expect(() => validateConfig({ ...BASE_CONFIG, bankId: "12345" })).toThrow("bankId must be 1");
	});

	it("throws when accountHolderName is empty", () => {
		expect(() => validateConfig({ ...BASE_CONFIG, accountHolderName: "" })).toThrow(
			"accountHolderName is required",
		);
	});

	it("throws when accountHolderName is only whitespace", () => {
		expect(() => validateConfig({ ...BASE_CONFIG, accountHolderName: "   " })).toThrow(
			"accountHolderName is required",
		);
	});

	it("throws when accountHolderName exceeds 26 chars", () => {
		expect(() => validateConfig({ ...BASE_CONFIG, accountHolderName: "A".repeat(27) })).toThrow(
			"at most 26 characters",
		);
	});

	it("accepts accountHolderName of exactly 26 chars", () => {
		expect(() =>
			validateConfig({ ...BASE_CONFIG, accountHolderName: "A".repeat(26) }),
		).not.toThrow();
	});

	it("throws when openingBalance is NaN", () => {
		expect(() => validateConfig({ ...BASE_CONFIG, openingBalance: Number.NaN })).toThrow(
			"finite number",
		);
	});

	it("throws when openingBalance is Infinity", () => {
		expect(() =>
			validateConfig({ ...BASE_CONFIG, openingBalance: Number.POSITIVE_INFINITY }),
		).toThrow("finite number");
	});

	it("throws when openingBalanceDate is invalid", () => {
		expect(() =>
			validateConfig({ ...BASE_CONFIG, openingBalanceDate: new Date("not-a-date") }),
		).toThrow("valid Date");
	});

	it("throws when openingBalanceDate is not a Date object", () => {
		expect(() =>
			// biome-ignore lint/suspicious/noExplicitAny: intentional wrong type for test
			validateConfig({ ...BASE_CONFIG, openingBalanceDate: "2026-01-01" as any }),
		).toThrow("valid Date");
	});
});

// ---------------------------------------------------------------------------
// 2. Amount conversion
// ---------------------------------------------------------------------------

describe("toMilliCents", () => {
	it("converts a positive amount correctly", () => {
		expect(toMilliCents(42.5)).toBe(42500n);
	});

	it("converts a negative amount using absolute value", () => {
		expect(toMilliCents(-42.5)).toBe(42500n);
	});

	it("converts zero", () => {
		expect(toMilliCents(0)).toBe(0n);
	});

	it("converts an integer amount", () => {
		expect(toMilliCents(100)).toBe(100000n);
	});

	it("converts an amount with 1 decimal place", () => {
		expect(toMilliCents(1.5)).toBe(1500n);
	});

	it("converts an amount with 2 decimal places", () => {
		expect(toMilliCents(1.23)).toBe(1230n);
	});

	it("converts an amount with 3 decimal places", () => {
		expect(toMilliCents(1.234)).toBe(1234n);
	});

	it("handles 0.1 + 0.2 floating-point rounding correctly", () => {
		// 0.1 + 0.2 = 0.30000000000000004 in IEEE 754
		const amount = 0.1 + 0.2;
		expect(toMilliCents(amount)).toBe(300n);
	});

	it("handles large amounts", () => {
		expect(toMilliCents(999999.99)).toBe(999999990n);
	});

	it("rounds correctly at the 4th decimal", () => {
		// 1.2345 * 1000 = 1234.5 → rounds to 1235
		expect(toMilliCents(1.2345)).toBe(1235n);
	});

	it("throws for Infinity", () => {
		expect(() => toMilliCents(Infinity)).toThrow("Amount must be a finite number");
	});

	it("throws for -Infinity", () => {
		expect(() => toMilliCents(-Infinity)).toThrow("Amount must be a finite number");
	});

	it("throws for NaN", () => {
		expect(() => toMilliCents(NaN)).toThrow("Amount must be a finite number");
	});
});

describe("toSignCode", () => {
	it("returns '0' for positive amounts (credit)", () => {
		expect(toSignCode(42.5)).toBe("0");
	});

	it("returns '0' for zero (treated as credit)", () => {
		expect(toSignCode(0)).toBe("0");
	});

	it("returns '1' for negative amounts (debit)", () => {
		expect(toSignCode(-42.5)).toBe("1");
	});
});

// ---------------------------------------------------------------------------
// 3. Transaction code mapping
// ---------------------------------------------------------------------------

describe("buildTransactionCode — Revolut Personal", () => {
	it("maps CARD_PAYMENT to family 43, operation 01", () => {
		const tc = buildTransactionCode(makeTx({ rawType: "CARD_PAYMENT", amount: -42.5 }));
		expect(tc.family).toBe("43");
		expect(tc.operation).toBe("01");
		expect(tc.type).toBe("1");
		expect(tc.category).toBe("000");
	});

	it("maps TRANSFER credit to family 01, operation 01", () => {
		const tc = buildTransactionCode(makeTx({ rawType: "TRANSFER", amount: 500 }));
		expect(tc.family).toBe("01");
		expect(tc.operation).toBe("01");
	});

	it("maps TRANSFER debit to family 01, operation 37", () => {
		const tc = buildTransactionCode(makeTx({ rawType: "TRANSFER", amount: -500 }));
		expect(tc.family).toBe("01");
		expect(tc.operation).toBe("37");
	});

	it("maps TOPUP to family 01, operation 01", () => {
		const tc = buildTransactionCode(makeTx({ rawType: "TOPUP", amount: 2000 }));
		expect(tc.family).toBe("01");
		expect(tc.operation).toBe("01");
	});

	it("maps EXCHANGE to family 41, operation 01", () => {
		const tc = buildTransactionCode(makeTx({ rawType: "EXCHANGE", amount: -200 }));
		expect(tc.family).toBe("41");
		expect(tc.operation).toBe("01");
	});

	it("maps FEE to family 35, operation 01", () => {
		const tc = buildTransactionCode(makeTx({ rawType: "FEE", amount: -5 }));
		expect(tc.family).toBe("35");
		expect(tc.operation).toBe("01");
	});

	it("maps unknown rawType to default family 01, operation 01", () => {
		const tc = buildTransactionCode(makeTx({ rawType: "UNKNOWN_TYPE", amount: -10 }));
		expect(tc.family).toBe("01");
		expect(tc.operation).toBe("01");
	});

	it("maps undefined rawType to default family 01, operation 01", () => {
		const txNoType = { ...makeTx({ amount: -10 }) };
		delete txNoType.rawType;
		const tc = buildTransactionCode(txNoType);
		expect(tc.family).toBe("01");
		expect(tc.operation).toBe("01");
	});
});

describe("buildTransactionCode — Qonto", () => {
	function makeQontoTx(rawType: string, amount: number): BankTransaction {
		return makeTx({ source: "qonto", rawType, amount });
	}

	it("maps card to family 43, operation 01", () => {
		const tc = buildTransactionCode(makeQontoTx("card", -320));
		expect(tc.family).toBe("43");
		expect(tc.operation).toBe("01");
	});

	it("maps transfer credit to family 01, operation 01", () => {
		const tc = buildTransactionCode(makeQontoTx("transfer", 5000));
		expect(tc.family).toBe("01");
		expect(tc.operation).toBe("01");
	});

	it("maps transfer debit to family 01, operation 37", () => {
		const tc = buildTransactionCode(makeQontoTx("transfer", -890));
		expect(tc.family).toBe("01");
		expect(tc.operation).toBe("37");
	});

	it("maps direct_debit to family 05, operation 01", () => {
		const tc = buildTransactionCode(makeQontoTx("direct_debit", -150));
		expect(tc.family).toBe("05");
		expect(tc.operation).toBe("01");
	});

	it("maps unknown Qonto rawType to default", () => {
		const tc = buildTransactionCode(makeQontoTx("cheque", -50));
		expect(tc.family).toBe("01");
		expect(tc.operation).toBe("01");
	});
});

// ---------------------------------------------------------------------------
// 4. Communication splitting and OGM detection
// ---------------------------------------------------------------------------

describe("detectOgm", () => {
	it("detects formatted OGM +++NNN/NNNN/NNNNN+++", () => {
		expect(detectOgm("+++123/4567/89002+++")).toBe("+++123/4567/89002+++");
	});

	it("detects 12-digit string and formats as OGM", () => {
		expect(detectOgm("123456789002")).toBe("+++123/4567/89002+++");
	});

	it("returns null for empty string", () => {
		expect(detectOgm("")).toBeNull();
	});

	it("returns null for free text", () => {
		expect(detectOgm("Payment for invoice")).toBeNull();
	});

	it("returns null for partial OGM (wrong format)", () => {
		expect(detectOgm("+++123/456/789+++")).toBeNull();
	});

	it("trims whitespace before matching", () => {
		expect(detectOgm("  +++456/7890/12373+++  ")).toBe("+++456/7890/12373+++");
	});

	it("returns null for OGM with invalid check digit", () => {
		expect(detectOgm("+++123/4567/89099+++")).toBeNull();
	});

	it("returns null for bare digits with invalid check digit", () => {
		expect(detectOgm("123456789099")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// OGM check digit validation
// ---------------------------------------------------------------------------

describe("validateOgmCheckDigit", () => {
	it("validates 090933755493 (0909337554 mod 97 = 93)", () => {
		expect(validateOgmCheckDigit("090933755493")).toBe(true);
	});

	it("validates 000000000097 (0 mod 97 = 0 → check=97)", () => {
		expect(validateOgmCheckDigit("000000000097")).toBe(true);
	});

	it("validates 123456789002 (1234567890 mod 97 = 2)", () => {
		expect(validateOgmCheckDigit("123456789002")).toBe(true);
	});

	it("rejects 123456789099 (wrong check digit)", () => {
		expect(validateOgmCheckDigit("123456789099")).toBe(false);
	});

	it("validates 000000009797 (97 mod 97 = 0 → check=97)", () => {
		expect(validateOgmCheckDigit("000000009797")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// OGM formatting
// ---------------------------------------------------------------------------

describe("formatOgm", () => {
	it('formats "1234567890" → "+++123/4567/89002+++"', () => {
		expect(formatOgm("1234567890")).toBe("+++123/4567/89002+++");
	});

	it('formats "0000000000" → "+++000/0000/00097+++"', () => {
		expect(formatOgm("0000000000")).toBe("+++000/0000/00097+++");
	});
});

describe("splitCommunication", () => {
	it("uses OGM as structured communication (type '1') with raw digits", () => {
		const result = splitCommunication("+++123/4567/89002+++", "Some description");
		expect(result.type).toBe("1");
		expect(result.part1).toBe("101123456789002");
		expect(result.part1).not.toContain("+++");
		expect(result.part2).toBe("");
		expect(result.part3).toBe("");
	});

	it("uses free text when no OGM detected (type '0')", () => {
		const result = splitCommunication("Payment for invoice INV-001", "fallback");
		expect(result.type).toBe("0");
		expect(result.part1).toBe("Payment for invoice INV-001");
	});

	it("falls back to description when reference is undefined", () => {
		const result = splitCommunication(undefined, "Test description");
		expect(result.type).toBe("0");
		expect(result.part1).toBe("Test description");
	});

	it("splits text > 53 chars into part1 (53) and part2", () => {
		const text = "A".repeat(60);
		const result = splitCommunication(text, "");
		expect(result.part1).toBe("A".repeat(53));
		expect(result.part2).toBe("A".repeat(7));
		expect(result.part3).toBe("");
	});

	it("splits text > 106 chars into all three parts", () => {
		const text = "B".repeat(120);
		const result = splitCommunication(text, "");
		expect(result.part1).toBe("B".repeat(53));
		expect(result.part2).toBe("B".repeat(53));
		expect(result.part3).toBe("B".repeat(14));
	});

	it("truncates text longer than 149 chars", () => {
		const text = "C".repeat(200);
		const result = splitCommunication(text, "");
		expect(result.part1.length).toBe(53);
		expect(result.part2.length).toBe(53);
		expect(result.part3.length).toBe(43);
	});

	it("handles empty reference and description", () => {
		const result = splitCommunication(undefined, "");
		expect(result.type).toBe("0");
		expect(result.part1).toBe("");
		expect(result.part2).toBe("");
		expect(result.part3).toBe("");
	});
});

// ---------------------------------------------------------------------------
// 5. IBAN handling
// ---------------------------------------------------------------------------

describe("ibanToAccountStructure", () => {
	it("returns '2' for Belgian IBAN (BE prefix)", () => {
		expect(ibanToAccountStructure("BE68539007547034")).toBe("2");
	});

	it("returns '2' for Belgian IBAN with spaces", () => {
		expect(ibanToAccountStructure("BE68 5390 0754 7034")).toBe("2");
	});

	it("returns '3' for foreign IBAN (FR prefix)", () => {
		expect(ibanToAccountStructure("FR7630006000011234567890189")).toBe("3");
	});

	it("returns '3' for NL IBAN", () => {
		expect(ibanToAccountStructure("NL91ABNA0417164300")).toBe("3");
	});

	it("is case-insensitive", () => {
		expect(ibanToAccountStructure("be68539007547034")).toBe("2");
	});
});

describe("buildCounterpartyAccountRaw", () => {
	it("returns 37 spaces when no IBAN provided", () => {
		const result = buildCounterpartyAccountRaw(undefined, "EUR");
		expect(result).toBe(" ".repeat(37));
		expect(result.length).toBe(37);
	});

	it("returns 37-char block for Belgian IBAN", () => {
		const result = buildCounterpartyAccountRaw("BE68539007547034", "EUR");
		expect(result.length).toBe(37);
		// Structure "2": IBAN left-padded in 31 chars, 3 blanks, 3 currency
		expect(result.slice(0, 16)).toBe("BE68539007547034");
	});

	it("returns 37-char block for foreign IBAN", () => {
		const result = buildCounterpartyAccountRaw("NL91ABNA0417164300", "EUR");
		expect(result.length).toBe(37);
	});

	it("strips spaces from IBAN before building block", () => {
		const withSpaces = buildCounterpartyAccountRaw("BE68 5390 0754 7034", "EUR");
		const withoutSpaces = buildCounterpartyAccountRaw("BE68539007547034", "EUR");
		expect(withSpaces).toBe(withoutSpaces);
	});

	it("includes currency in the account block", () => {
		const result = buildCounterpartyAccountRaw("BE68539007547034", "EUR");
		// Currency occupies last 3 chars of the 37-char block for structure "2"
		expect(result.slice(34, 37)).toBe("EUR");
	});
});

// ---------------------------------------------------------------------------
// 6. Full mapping
// ---------------------------------------------------------------------------

describe("mapToCoda — single transaction", () => {
	it("produces a valid CodaStatement from one transaction", () => {
		const txns: BankTransaction[] = [
			makeTx({ amount: -42.5, description: "Delhaize", rawType: "CARD_PAYMENT" }),
		];
		const stmt = mapToCoda(txns, BASE_CONFIG);

		expect(stmt.header.recordType).toBe("0");
		expect(stmt.oldBalance.recordType).toBe("1");
		expect(stmt.newBalance.recordType).toBe("8");
		expect(stmt.trailer.recordType).toBe("9");
	});

	it("record 21 has correct amount and sign for debit", () => {
		const txns: BankTransaction[] = [makeTx({ amount: -42.5 })];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec21 = stmt.records.find((r) => r.recordType === "21");
		expect(rec21?.recordType).toBe("21");
		if (rec21?.recordType === "21") {
			expect(rec21.amount).toBe(42500n);
			expect(rec21.amountSign).toBe("1");
		}
	});

	it("record 21 has correct amount and sign for credit", () => {
		const txns: BankTransaction[] = [makeTx({ amount: 500 })];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec21 = stmt.records.find((r) => r.recordType === "21");
		if (rec21?.recordType === "21") {
			expect(rec21.amount).toBe(500000n);
			expect(rec21.amountSign).toBe("0");
		}
	});

	it("uses statementSequence from config when provided", () => {
		const txns: BankTransaction[] = [makeTx()];
		const stmt = mapToCoda(txns, { ...BASE_CONFIG, statementSequence: 5 });
		expect(stmt.oldBalance.statementSequenceNumber).toBe(5);
		expect(stmt.newBalance.statementSequenceNumber).toBe(5);
	});

	it("defaults statementSequence to 1 when not provided", () => {
		const txns: BankTransaction[] = [makeTx()];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		expect(stmt.oldBalance.statementSequenceNumber).toBe(1);
	});
});

describe("mapToCoda — multiple transactions", () => {
	it("assigns sequential sequence numbers starting at 1", () => {
		const txns: BankTransaction[] = [
			makeTx({ amount: -10 }),
			makeTx({ amount: -20 }),
			makeTx({ amount: 50 }),
		];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec21s = stmt.records.filter((r) => r.recordType === "21");
		expect(rec21s).toHaveLength(3);
		if (rec21s[0]!.recordType === "21") expect(rec21s[0]!.sequenceNumber).toBe(1);
		if (rec21s[1]!.recordType === "21") expect(rec21s[1]!.sequenceNumber).toBe(2);
		if (rec21s[2]!.recordType === "21") expect(rec21s[2]!.sequenceNumber).toBe(3);
	});

	it("emits Record 23 when counterparty IBAN is present", () => {
		const txns: BankTransaction[] = [
			makeTx({ counterpartyIban: "BE68539007547034", counterpartyName: "Jan Peeters" }),
		];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec23 = stmt.records.find((r) => r.recordType === "23");
		expect(rec23).toBeDefined();
	});

	it("emits Record 22 when counterparty BIC is present", () => {
		const txns: BankTransaction[] = [
			makeTx({ counterpartyBic: "BBRUBEBB", counterpartyIban: "BE68539007547034" }),
		];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec22 = stmt.records.find((r) => r.recordType === "22");
		expect(rec22).toBeDefined();
		if (rec22?.recordType === "22") {
			expect(rec22.counterpartyBic).toBe("BBRUBEBB");
		}
	});

	it("does not emit Record 22/23 when no counterparty data and short communication", () => {
		const txns: BankTransaction[] = [
			makeTx({ description: "Short description" }),
		];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec22 = stmt.records.find((r) => r.recordType === "22");
		const rec23 = stmt.records.find((r) => r.recordType === "23");
		expect(rec22).toBeUndefined();
		expect(rec23).toBeUndefined();
	});

	it("emits Record 22 when communication exceeds 53 chars", () => {
		const txns: BankTransaction[] = [makeTx({ description: "A".repeat(60) })];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec22 = stmt.records.find((r) => r.recordType === "22");
		expect(rec22).toBeDefined();
	});
});

describe("mapToCoda — Record 9 totals", () => {
	it("correctly separates debit and credit totals", () => {
		const txns: BankTransaction[] = [
			makeTx({ amount: -42.5 }), // debit
			makeTx({ amount: 100.0 }), // credit
			makeTx({ amount: -7.75 }), // debit
		];
		const stmt = mapToCoda(txns, BASE_CONFIG);

		expect(stmt.trailer.totalDebit).toBe(42500n + 7750n); // 50250n
		expect(stmt.trailer.totalCredit).toBe(100000n);
	});

	it("has zero totalDebit when all transactions are credits", () => {
		const txns: BankTransaction[] = [makeTx({ amount: 100 }), makeTx({ amount: 200 })];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		expect(stmt.trailer.totalDebit).toBe(0n);
		expect(stmt.trailer.totalCredit).toBe(300000n);
	});

	it("has zero totalCredit when all transactions are debits", () => {
		const txns: BankTransaction[] = [makeTx({ amount: -100 }), makeTx({ amount: -50 })];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		expect(stmt.trailer.totalCredit).toBe(0n);
		expect(stmt.trailer.totalDebit).toBe(150000n);
	});
});

// ---------------------------------------------------------------------------
// 7. Balance computation
// ---------------------------------------------------------------------------

describe("Balance computation", () => {
	it("new balance = opening + credits - debits (positive result)", () => {
		const txns: BankTransaction[] = [
			makeTx({ amount: -42.5 }), // -42.50
			makeTx({ amount: 100.0 }), // +100.00
		];
		// opening=1000, credit=100, debit=42.50 → new=1057.50
		const stmt = mapToCoda(txns, { ...BASE_CONFIG, openingBalance: 1000.0 });
		expect(stmt.newBalance.newBalanceSign).toBe("0");
		expect(stmt.newBalance.newBalanceAmount).toBe(1057500n);
	});

	it("new balance handles all debits (balance decreases)", () => {
		const txns: BankTransaction[] = [makeTx({ amount: -500 })];
		// opening=1000, debit=500 → new=500
		const stmt = mapToCoda(txns, { ...BASE_CONFIG, openingBalance: 1000.0 });
		expect(stmt.newBalance.newBalanceSign).toBe("0");
		expect(stmt.newBalance.newBalanceAmount).toBe(500000n);
	});

	it("new balance can go negative (overdraft)", () => {
		const txns: BankTransaction[] = [makeTx({ amount: -1500 })];
		// opening=1000, debit=1500 → new=-500
		const stmt = mapToCoda(txns, { ...BASE_CONFIG, openingBalance: 1000.0 });
		expect(stmt.newBalance.newBalanceSign).toBe("1");
		expect(stmt.newBalance.newBalanceAmount).toBe(500000n);
	});

	it("produces correct balance with empty transaction list", () => {
		const stmt = mapToCoda([], { ...BASE_CONFIG, openingBalance: 1234.56 });
		// No transactions → new balance = opening balance
		expect(stmt.newBalance.newBalanceAmount).toBe(1234560n);
		expect(stmt.newBalance.newBalanceSign).toBe("0");
	});

	it("handles negative opening balance correctly", () => {
		const txns: BankTransaction[] = [
			makeTx({ amount: 500 }), // credit
		];
		// opening=-200, credit=500 → new=300
		const stmt = mapToCoda(txns, { ...BASE_CONFIG, openingBalance: -200.0 });
		expect(stmt.newBalance.newBalanceSign).toBe("0");
		expect(stmt.newBalance.newBalanceAmount).toBe(300000n);
	});
});

// ---------------------------------------------------------------------------
// 8. Record count in trailer
// ---------------------------------------------------------------------------

describe("mapToCoda — Record 9 record count", () => {
	it("counts Record 1, all movement records, and Record 8 (excludes 0 and 9)", () => {
		// 1 transaction with no counterparty → 1 (rec1) + 1 (rec21) + 1 (rec8) = 3
		const txns: BankTransaction[] = [makeTx()];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		expect(stmt.trailer.recordCount).toBe(3);
	});

	it("counts rec22 and rec23 when present", () => {
		// 1 transaction with counterparty IBAN + BIC → rec1 + rec21 + rec22 + rec23 + rec8 = 5
		const txns: BankTransaction[] = [
			makeTx({
				counterpartyIban: "BE68539007547034",
				counterpartyName: "Jan Peeters",
				counterpartyBic: "BBRUBEBB",
			}),
		];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		expect(stmt.trailer.recordCount).toBe(5);
	});

	it("counts correctly for multiple transactions", () => {
		// 2 transactions, each with counterparty (rec21 + rec22 + rec23 per txn)
		// rec1 + (rec21 + rec22 + rec23) + (rec21 + rec22 + rec23) + rec8 = 8
		const txns: BankTransaction[] = [
			makeTx({ counterpartyIban: "BE68539007547034", counterpartyName: "Alice" }),
			makeTx({ counterpartyIban: "BE71096123456769", counterpartyName: "Bob" }),
		];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		expect(stmt.trailer.recordCount).toBe(8);
	});
});

// ---------------------------------------------------------------------------
// 9. Serialization integration (every line must be 128 chars)
// ---------------------------------------------------------------------------

describe("mapToCoda → serializeCoda (line length check)", () => {
	it("every line in a single-transaction CODA is exactly 128 chars", () => {
		const txns: BankTransaction[] = [makeTx({ amount: -42.5 })];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const output = serializeCoda(stmt);
		const lines = output.trimEnd().split("\n");
		for (const line of lines) {
			expect(line.length).toBe(128);
		}
	});

	it("every line in a multi-transaction CODA is exactly 128 chars", () => {
		const txns: BankTransaction[] = [
			makeTx({
				amount: -42.5,
				counterpartyIban: "BE68539007547034",
				counterpartyName: "Alice",
				counterpartyBic: "BBRUBEBB",
			}),
			makeTx({ amount: 100 }),
			makeTx({ amount: -7.75, description: "A".repeat(100) }),
		];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const output = serializeCoda(stmt);
		const lines = output.trimEnd().split("\n");
		for (const line of lines) {
			expect(line.length).toBe(128);
		}
	});

	it("CODA output starts with Record 0 and ends with Record 9", () => {
		const txns: BankTransaction[] = [makeTx()];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const output = serializeCoda(stmt);
		const lines = output.trimEnd().split("\n");
		expect(lines[0]![0]).toBe("0");
		expect(lines[lines.length - 1]![0]).toBe("9");
	});

	it("Record 9 trailer ends with '2' (version code)", () => {
		const txns: BankTransaction[] = [makeTx()];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const output = serializeCoda(stmt);
		const lines = output.trimEnd().split("\n");
		const trailerLine = lines[lines.length - 1]!;
		expect(trailerLine[127]).toBe("2");
	});
});

// ---------------------------------------------------------------------------
// 10. OGM communication in Record 21
// ---------------------------------------------------------------------------

describe("Structured OGM communication in records", () => {
	it("sets communicationType to '1' for OGM reference", () => {
		const txns: BankTransaction[] = [makeTx({ reference: "+++123/4567/89002+++" })];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec21 = stmt.records.find((r) => r.recordType === "21");
		if (rec21?.recordType === "21") {
			expect(rec21.communicationType).toBe("1");
			expect(rec21.communication).toBe("101123456789002");
		}
	});

	it("sets communicationType to '0' for free text reference", () => {
		const txns: BankTransaction[] = [makeTx({ reference: "INV-2026-001" })];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec21 = stmt.records.find((r) => r.recordType === "21");
		if (rec21?.recordType === "21") {
			expect(rec21.communicationType).toBe("0");
		}
	});
});

// ---------------------------------------------------------------------------
// 11. Header fields
// ---------------------------------------------------------------------------

describe("mapToCoda — header fields", () => {
	it("uses config bic in header", () => {
		const stmt = mapToCoda([], { ...BASE_CONFIG, bic: "BBRUBEBB   " });
		expect(stmt.header.bic).toBe("BBRUBEBB   ");
	});

	it("uses config applicationCode in header", () => {
		const stmt = mapToCoda([], { ...BASE_CONFIG, applicationCode: "07" });
		expect(stmt.header.applicationCode).toBe("07");
	});

	it("defaults applicationCode to '05'", () => {
		const stmt = mapToCoda([], BASE_CONFIG);
		expect(stmt.header.applicationCode).toBe("05");
	});

	it("uses config companyId in header", () => {
		const stmt = mapToCoda([], { ...BASE_CONFIG, companyId: "BE0123456789" });
		expect(stmt.header.companyIdentificationNumber).toBe("BE0123456789");
	});

	it("uses accountHolderName in header addresseeName", () => {
		const stmt = mapToCoda([], BASE_CONFIG);
		expect(stmt.header.addresseeName).toBe("ACME BVBA");
	});
});

// ---------------------------------------------------------------------------
// 12. Full pipeline integration: CSV → parse → map → serialize → golden file
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(import.meta.dir, "../../src/parsers/__tests__/fixtures");
const GOLDEN_DIR = join(import.meta.dir, "fixtures");

describe("Full pipeline integration — Revolut Personal", () => {
	const csvContent = readFileSync(join(FIXTURES_DIR, "revolut-personal.csv"), "utf-8");

	const config: CodaConfig = {
		bankId: "535",
		accountIban: "BE68539007547034",
		accountCurrency: "EUR",
		accountHolderName: "Test User",
		openingBalance: 2000.0,
		openingBalanceDate: new Date("2026-01-14"),
		bic: "REVOLT21   ",
		statementSequence: 1,
	};

	it("parses CSV, maps, and serializes without errors", () => {
		const txns = parseTransactions(csvContent, "revolut-personal");
		expect(txns.length).toBeGreaterThan(0);

		const stmt = mapToCoda(txns, config);
		const output = serializeCoda(stmt);

		expect(output.length).toBeGreaterThan(0);
	});

	it("every line in the output is exactly 128 chars", () => {
		const txns = parseTransactions(csvContent, "revolut-personal");
		const stmt = mapToCoda(txns, config);
		const output = serializeCoda(stmt);

		const lines = output.trimEnd().split("\n");
		for (const [idx, line] of lines.entries()) {
			expect(line.length).toBe(128);
			void idx; // suppress unused var warning
		}
	});

	it("Record 9 debit + credit totals match individual transaction amounts (including fees)", () => {
		const txns = parseTransactions(csvContent, "revolut-personal");
		const stmt = mapToCoda(txns, config);

		// Manually sum debits and credits — fees are always additional debits
		let expectedDebit = 0n;
		let expectedCredit = 0n;
		for (const tx of txns) {
			const mc = toMilliCents(tx.amount);
			if (tx.amount < 0) {
				expectedDebit += mc;
			} else {
				expectedCredit += mc;
			}
			if (tx.fee !== undefined && tx.fee !== 0) {
				expectedDebit += toMilliCents(tx.fee);
			}
		}

		expect(stmt.trailer.totalDebit).toBe(expectedDebit);
		expect(stmt.trailer.totalCredit).toBe(expectedCredit);
	});

	it("saves golden file and verifies structure", () => {
		const txns = parseTransactions(csvContent, "revolut-personal");
		const stmt = mapToCoda(txns, config);
		const output = serializeCoda(stmt);

		// Ensure golden fixtures dir exists
		mkdirSync(GOLDEN_DIR, { recursive: true });
		const goldenPath = join(GOLDEN_DIR, "revolut-personal.coda");
		writeFileSync(goldenPath, output, "utf-8");

		// Re-read and verify
		const reread = readFileSync(goldenPath, "utf-8");
		const lines = reread.trimEnd().split("\n");

		// First line = Record 0
		expect(lines[0]![0]).toBe("0");
		// Last line = Record 9, ends with '2' (version code)
		expect(lines[lines.length - 1]![127]).toBe("2");
		// All lines = 128 chars
		for (const line of lines) {
			expect(line.length).toBe(128);
		}
	});
});

describe("Full pipeline integration — Qonto", () => {
	const csvContent = readFileSync(join(FIXTURES_DIR, "qonto.csv"), "utf-8");

	const config: CodaConfig = {
		bankId: "535",
		accountIban: "BE71096123456769",
		accountCurrency: "EUR",
		accountHolderName: "Client Alpha BVBA",
		openingBalance: 10000.0,
		openingBalanceDate: new Date("2026-01-09"),
		statementSequence: 2,
	};

	it("parses Qonto CSV, maps, and serializes without errors", () => {
		const txns = parseTransactions(csvContent, "qonto");
		expect(txns.length).toBeGreaterThan(0);

		const stmt = mapToCoda(txns, config);
		const output = serializeCoda(stmt);
		expect(output.length).toBeGreaterThan(0);
	});

	it("every line in Qonto CODA output is exactly 128 chars", () => {
		const txns = parseTransactions(csvContent, "qonto");
		const stmt = mapToCoda(txns, config);
		const output = serializeCoda(stmt);

		const lines = output.trimEnd().split("\n");
		for (const line of lines) {
			expect(line.length).toBe(128);
		}
	});

	it("Qonto OGM references produce structured communication", () => {
		const txns = parseTransactions(csvContent, "qonto");
		const stmt = mapToCoda(txns, config);

		// qt_001 has reference +++123/4567/89002+++
		const firstRec21 = stmt.records.find((r) => r.recordType === "21");
		if (firstRec21?.recordType === "21") {
			expect(firstRec21.communicationType).toBe("1");
		}
	});

	it("saves golden file for Qonto and verifies all lines are 128 chars", () => {
		const txns = parseTransactions(csvContent, "qonto");
		const stmt = mapToCoda(txns, config);
		const output = serializeCoda(stmt);

		mkdirSync(GOLDEN_DIR, { recursive: true });
		const goldenPath = join(GOLDEN_DIR, "qonto.coda");
		writeFileSync(goldenPath, output, "utf-8");

		const lines = output.trimEnd().split("\n");
		for (const line of lines) {
			expect(line.length).toBe(128);
		}
	});
});

// ---------------------------------------------------------------------------
// 13. Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
	it("handles transaction with zero amount", () => {
		const txns: BankTransaction[] = [makeTx({ amount: 0 })];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec21 = stmt.records.find((r) => r.recordType === "21");
		if (rec21?.recordType === "21") {
			expect(rec21.amount).toBe(0n);
			expect(rec21.amountSign).toBe("0");
		}
	});

	it("handles empty transaction list", () => {
		const stmt = mapToCoda([], BASE_CONFIG);
		expect(stmt.records).toHaveLength(0);
		expect(stmt.trailer.recordCount).toBe(2); // just rec1 + rec8
		expect(stmt.trailer.totalDebit).toBe(0n);
		expect(stmt.trailer.totalCredit).toBe(0n);
	});

	it("counterparty name in Record 23", () => {
		const txns: BankTransaction[] = [
			makeTx({ counterpartyName: "Jan Peeters", counterpartyIban: "BE68539007547034" }),
		];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec23 = stmt.records.find((r) => r.recordType === "23");
		if (rec23?.recordType === "23") {
			expect(rec23.counterpartyName).toBe("Jan Peeters");
		}
	});

	it("hasContinuation on Record 21 is true when Record 22 follows", () => {
		const txns: BankTransaction[] = [
			makeTx({ counterpartyIban: "BE68539007547034", counterpartyName: "Test" }),
		];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec21 = stmt.records.find((r) => r.recordType === "21");
		if (rec21?.recordType === "21") {
			expect(rec21.hasContinuation).toBe(true);
		}
	});

	it("hasContinuation on Record 21 is false when no Record 22/23 follow", () => {
		const txns: BankTransaction[] = [
			makeTx({ description: "Short" }),
		];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec21 = stmt.records.find((r) => r.recordType === "21");
		if (rec21?.recordType === "21") {
			expect(rec21.hasContinuation).toBe(false);
		}
	});

	it("isLastRecord on Record 23 is always true (no further records per transaction)", () => {
		const txns: BankTransaction[] = [
			makeTx({ counterpartyIban: "BE68539007547034", counterpartyName: "Test" }),
		];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec23 = stmt.records.find((r) => r.recordType === "23");
		if (rec23?.recordType === "23") {
			expect(rec23.isLastRecord).toBe(true);
		}
	});

	it("accountDescription is included in Record 1", () => {
		const stmt = mapToCoda([], {
			...BASE_CONFIG,
			accountDescription: "Business checking account",
		});
		expect(stmt.oldBalance.accountDescription).toBe("Business checking account");
	});
});

// ---------------------------------------------------------------------------
// 14. Fee handling
// ---------------------------------------------------------------------------

describe("Fee handling — fee generates separate debit Record 21", () => {
	it("transaction with fee (-1.50) emits 2 Record 21s (main + fee)", () => {
		const txns: BankTransaction[] = [
			makeTx({ amount: -200, description: "Exchanged to USD", rawType: "EXCHANGE", fee: -1.5 }),
		];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec21s = stmt.records.filter((r) => r.recordType === "21");
		expect(rec21s).toHaveLength(2);
	});

	it("transaction without fee emits exactly 1 Record 21", () => {
		const txns: BankTransaction[] = [
			makeTx({ amount: -42.5, description: "Delhaize", rawType: "CARD_PAYMENT" }),
		];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec21s = stmt.records.filter((r) => r.recordType === "21");
		expect(rec21s).toHaveLength(1);
	});

	it("transaction with fee of exactly 0 emits no extra record", () => {
		const txns: BankTransaction[] = [makeTx({ amount: -42.5, fee: 0 })];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec21s = stmt.records.filter((r) => r.recordType === "21");
		expect(rec21s).toHaveLength(1);
	});

	it("transaction with fee of undefined emits no extra record", () => {
		const txns: BankTransaction[] = [makeTx({ amount: -42.5 })];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec21s = stmt.records.filter((r) => r.recordType === "21");
		expect(rec21s).toHaveLength(1);
	});

	it("fee Record 21 has transaction code family '35', operation '01'", () => {
		const txns: BankTransaction[] = [
			makeTx({ amount: -200, description: "Exchanged to USD", rawType: "EXCHANGE", fee: -1.5 }),
		];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec21s = stmt.records.filter((r) => r.recordType === "21");
		// Second record is the fee
		const feeRec = rec21s[1];
		expect(feeRec?.recordType).toBe("21");
		if (feeRec?.recordType === "21") {
			expect(feeRec.transactionCode.family).toBe("35");
			expect(feeRec.transactionCode.operation).toBe("01");
			expect(feeRec.transactionCode.type).toBe("1");
			expect(feeRec.transactionCode.category).toBe("000");
		}
	});

	it("fee Record 21 communication starts with 'Fee: '", () => {
		const txns: BankTransaction[] = [
			makeTx({ amount: -200, description: "Exchanged to USD", fee: -1.5 }),
		];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec21s = stmt.records.filter((r) => r.recordType === "21");
		const feeRec = rec21s[1];
		expect(feeRec?.recordType).toBe("21");
		if (feeRec?.recordType === "21") {
			expect(feeRec.communication.startsWith("Fee: ")).toBe(true);
			expect(feeRec.communication).toContain("Exchanged to USD");
		}
	});

	it("fee Record 21 communication is truncated to 53 chars for very long descriptions", () => {
		const longDesc = "A".repeat(60);
		const txns: BankTransaction[] = [makeTx({ amount: -200, description: longDesc, fee: -1.5 })];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec21s = stmt.records.filter((r) => r.recordType === "21");
		const feeRec = rec21s[1];
		if (feeRec?.recordType === "21") {
			expect(feeRec.communication.length).toBeLessThanOrEqual(53);
		}
	});

	it("fee Record 21 always has amountSign '1' (debit), even if tx.fee is negative", () => {
		const txns: BankTransaction[] = [makeTx({ amount: -200, fee: -1.5 })];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec21s = stmt.records.filter((r) => r.recordType === "21");
		const feeRec = rec21s[1];
		if (feeRec?.recordType === "21") {
			expect(feeRec.amountSign).toBe("1");
		}
	});

	it("fee amount in Record 21 is the absolute value in milli-cents", () => {
		const txns: BankTransaction[] = [makeTx({ amount: -200, fee: -1.5 })];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec21s = stmt.records.filter((r) => r.recordType === "21");
		const feeRec = rec21s[1];
		if (feeRec?.recordType === "21") {
			// -1.5 EUR → 1500 milli-cents (absolute value)
			expect(feeRec.amount).toBe(1500n);
		}
	});

	it("fee sequence number follows the main transaction sequence number", () => {
		const txns: BankTransaction[] = [makeTx({ amount: -200, fee: -1.5 })];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec21s = stmt.records.filter((r) => r.recordType === "21");
		const mainRec = rec21s[0];
		const feeRec = rec21s[1];
		if (mainRec?.recordType === "21" && feeRec?.recordType === "21") {
			expect(feeRec.sequenceNumber).toBe(mainRec.sequenceNumber + 1);
		}
	});

	it("Record 9 totalDebit includes fee amounts", () => {
		// Single debit of -200, fee of -1.50
		// Expected debit total: 200000n + 1500n = 201500n
		const txns: BankTransaction[] = [makeTx({ amount: -200, fee: -1.5 })];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		expect(stmt.trailer.totalDebit).toBe(200000n + 1500n);
		expect(stmt.trailer.totalCredit).toBe(0n);
	});

	it("new balance includes fee deductions", () => {
		// opening=1000, main debit=-200, fee=-1.50 → new=1000-200-1.50=798.50
		const txns: BankTransaction[] = [makeTx({ amount: -200, fee: -1.5 })];
		const stmt = mapToCoda(txns, { ...BASE_CONFIG, openingBalance: 1000.0 });
		expect(stmt.newBalance.newBalanceSign).toBe("0");
		// 1000.00 - 200.00 - 1.50 = 798.50 → 798500n milli-cents
		expect(stmt.newBalance.newBalanceAmount).toBe(798500n);
	});

	it("multiple transactions, some with fees: sequence numbers are contiguous and unique", () => {
		const txns: BankTransaction[] = [
			makeTx({ amount: -42.5, description: "Card payment" }), // no fee → seq 1
			makeTx({ amount: -200, description: "Exchange", fee: -1.5 }), // fee → seq 2 (main) + seq 3 (fee)
			makeTx({ amount: 500, description: "Top-up" }), // no fee → seq 4
		];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec21s = stmt.records.filter((r) => r.recordType === "21");
		expect(rec21s).toHaveLength(4); // 3 mains + 1 fee

		const seqNums = rec21s.map((r) => (r.recordType === "21" ? r.sequenceNumber : -1));
		// All sequence numbers must be unique and contiguous starting at 1
		expect(seqNums).toEqual([1, 2, 3, 4]);
	});

	it("multiple transactions, some with fees: totalDebit and totalCredit are correct", () => {
		const txns: BankTransaction[] = [
			makeTx({ amount: -42.5 }), // debit 42.5
			makeTx({ amount: -200, fee: -1.5 }), // debit 200 + fee 1.5
			makeTx({ amount: 500 }), // credit 500
		];
		const stmt = mapToCoda(txns, BASE_CONFIG);

		// totalDebit = 42500n + 200000n + 1500n = 244000n
		expect(stmt.trailer.totalDebit).toBe(42500n + 200000n + 1500n);
		// totalCredit = 500000n
		expect(stmt.trailer.totalCredit).toBe(500000n);
	});

	it("fee Record 21 hasContinuation is false (no rec22/23 for fee records)", () => {
		const txns: BankTransaction[] = [makeTx({ amount: -200, fee: -1.5 })];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const rec21s = stmt.records.filter((r) => r.recordType === "21");
		const feeRec = rec21s[1];
		if (feeRec?.recordType === "21") {
			expect(feeRec.hasContinuation).toBe(false);
		}
	});

	it("record count in trailer includes fee Record 21s", () => {
		// 1 transaction with fee → rec1 + rec21(main) + rec21(fee) + rec8 = 4
		const txns: BankTransaction[] = [makeTx({ amount: -200, fee: -1.5 })];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		expect(stmt.trailer.recordCount).toBe(4);
	});

	it("fee Record 21 output line is exactly 128 chars when serialized", () => {
		const txns: BankTransaction[] = [
			makeTx({ amount: -200, description: "Exchanged to USD", fee: -1.5 }),
		];
		const stmt = mapToCoda(txns, BASE_CONFIG);
		const output = serializeCoda(stmt);
		const lines = output.trimEnd().split("\n");
		for (const line of lines) {
			expect(line.length).toBe(128);
		}
	});
});

describe("Fee handling — Full pipeline with Revolut exchange fixture", () => {
	const FIXTURES_DIR = join(import.meta.dir, "../../src/parsers/__tests__/fixtures");
	const csvContent = readFileSync(join(FIXTURES_DIR, "revolut-personal.csv"), "utf-8");

	const config: CodaConfig = {
		bankId: "535",
		accountIban: "BE68539007547034",
		accountCurrency: "EUR",
		accountHolderName: "Test User",
		openingBalance: 2000.0,
		openingBalanceDate: new Date("2026-01-14"),
		bic: "REVOLT21   ",
		statementSequence: 1,
	};

	it("EXCHANGE transaction with fee=-1.50 produces 2 Record 21s in output", () => {
		const txns = parseTransactions(csvContent, "revolut-personal");
		// Find the EXCHANGE transaction
		const exchangeTx = txns.find((tx) => tx.rawType === "EXCHANGE");
		expect(exchangeTx).toBeDefined();
		expect(exchangeTx?.fee).toBe(-1.5);

		const stmt = mapToCoda(txns, config);
		const rec21s = stmt.records.filter((r) => r.recordType === "21");

		// 8 completed transactions in fixture (PENDING row is skipped), 1 has a fee → 9 rec21s
		expect(rec21s).toHaveLength(9);
	});

	it("new balance from full fixture accounts for fee of -1.50", () => {
		const txns = parseTransactions(csvContent, "revolut-personal");
		const stmt = mapToCoda(txns, config);

		// Manually compute: opening=2000.00
		// Transactions (COMPLETED only):
		//   CARD_PAYMENT   -42.50
		//   TRANSFER       -500.00
		//   TOPUP          +2000.00
		//   CARD_PAYMENT   -65.30
		//   TRANSFER       +1500.00
		//   EXCHANGE       -200.00, fee=-1.50
		//   CARD_PAYMENT   -89.99
		//   TRANSFER       -850.00
		//   CARD_PAYMENT   -30.00  (state=PENDING → skipped)
		// Sum of credits  = 2000 + 1500 = 3500
		// Sum of debits   = 42.50 + 500 + 65.30 + 200 + 1.50 + 89.99 + 850 = 1749.29
		// Note: PENDING is filtered out by the parser
		// new balance = 2000 + 3500 - 1749.29 = 3750.71

		// Verify totalDebit includes the fee
		// credits: TOPUP 2000 + TRANSFER_in 1500 = 3500 → 3500000n
		// debits: 42.5+500+65.30+200+89.99+850 = 1747.79 main + 1.50 fee = 1749.29 → 1749290n
		expect(stmt.trailer.totalDebit).toBe(1749290n);
		expect(stmt.trailer.totalCredit).toBe(3500000n);

		// new balance = 2000000n + 3500000n - 1749290n = 3750710n
		expect(stmt.newBalance.newBalanceSign).toBe("0");
		expect(stmt.newBalance.newBalanceAmount).toBe(3750710n);
	});

	it("all lines in fee-inclusive output are exactly 128 chars", () => {
		const txns = parseTransactions(csvContent, "revolut-personal");
		const stmt = mapToCoda(txns, config);
		const output = serializeCoda(stmt);
		const lines = output.trimEnd().split("\n");
		for (const line of lines) {
			expect(line.length).toBe(128);
		}
	});
});
