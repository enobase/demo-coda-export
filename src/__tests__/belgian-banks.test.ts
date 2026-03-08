/**
 * Belgian Banks — Unit tests
 *
 * Covers IBAN bank code extraction, BIC lookup, and fuzzy name matching.
 */

import { describe, expect, it } from "bun:test";
import {
	BELGIAN_BANKS,
	extractBankIdFromIban,
	findBankByName,
	lookupBic,
	validateIban,
} from "../belgian-banks.ts";

// ---------------------------------------------------------------------------
// extractBankIdFromIban
// ---------------------------------------------------------------------------

describe("extractBankIdFromIban", () => {
	it("extracts bank code from a standard Belgian IBAN", () => {
		// BE68 539 0075470 34  — KBC
		expect(extractBankIdFromIban("BE68539007547034")).toBe("539");
	});

	it("extracts bank code from a Belfius IBAN", () => {
		// BE68068 — fictional but structurally valid
		expect(extractBankIdFromIban("BE23068000000000")).toBe("068");
	});

	it("extracts bank code from an ING IBAN (310)", () => {
		expect(extractBankIdFromIban("BE45310123456789")).toBe("310");
	});

	it("extracts bank code from a BNP Paribas Fortis IBAN (001)", () => {
		expect(extractBankIdFromIban("BE71001234567891")).toBe("001");
	});

	it("handles IBANs with spaces by stripping them", () => {
		expect(extractBankIdFromIban("BE68 5390 0754 7034")).toBe("539");
	});

	it("is case-insensitive — lowercase 'be' prefix is accepted", () => {
		expect(extractBankIdFromIban("be68539007547034")).toBe("539");
	});

	it("returns null for a non-Belgian IBAN (NL)", () => {
		expect(extractBankIdFromIban("NL91ABNA0417164300")).toBeNull();
	});

	it("returns null for a non-Belgian IBAN (DE)", () => {
		expect(extractBankIdFromIban("DE89370400440532013000")).toBeNull();
	});

	it("returns null for a non-Belgian IBAN (FR)", () => {
		expect(extractBankIdFromIban("FR7630006000011234567890189")).toBeNull();
	});

	it("returns null for an empty string", () => {
		expect(extractBankIdFromIban("")).toBeNull();
	});

	it("returns null for a string shorter than 7 characters starting with BE", () => {
		expect(extractBankIdFromIban("BE123")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// lookupBic
// ---------------------------------------------------------------------------

describe("lookupBic", () => {
	it("returns KREDBEBB for bank code 539 (KBC)", () => {
		expect(lookupBic("539")).toBe("KREDBEBB");
	});

	it("returns BBRUBEBB for bank code 310 (ING)", () => {
		expect(lookupBic("310")).toBe("BBRUBEBB");
	});

	it("returns GEBABEBB for bank code 001 (BNP Paribas Fortis)", () => {
		expect(lookupBic("001")).toBe("GEBABEBB");
	});

	it("returns GKCCBEBB for bank code 068 (Belfius)", () => {
		expect(lookupBic("068")).toBe("GKCCBEBB");
	});

	it("returns NICABEBB for bank code 683 (Keytrade)", () => {
		expect(lookupBic("683")).toBe("NICABEBB");
	});

	it("returns ARSPBE22 for bank code 034 (Argenta)", () => {
		expect(lookupBic("034")).toBe("ARSPBE22");
	});

	it("returns BMPBBEBB for bank code 860 (bpost bank)", () => {
		expect(lookupBic("860")).toBe("BMPBBEBB");
	});

	it("returns BBRUBEBB for bank code 103 (ING alt)", () => {
		expect(lookupBic("103")).toBe("BBRUBEBB");
	});

	it("returns TRWIBEB1 for bank code 690 (Wise)", () => {
		expect(lookupBic("690")).toBe("TRWIBEB1");
	});

	it("returns CREGBEBB for bank code 097 (CBC)", () => {
		expect(lookupBic("097")).toBe("CREGBEBB");
	});

	it("returns ABORBE22 for bank code 143 (AXA Bank / Crelan)", () => {
		expect(lookupBic("143")).toBe("ABORBE22");
	});

	it("returns null for an unknown bank code", () => {
		expect(lookupBic("999")).toBeNull();
	});

	it("returns null for an empty string", () => {
		expect(lookupBic("")).toBeNull();
	});

	it("returns null for a non-zero-padded code that does not exist", () => {
		// "68" is not the same as "068"
		expect(lookupBic("68")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// findBankByName
// ---------------------------------------------------------------------------

describe("findBankByName", () => {
	it("finds KBC by exact lowercase alias 'kbc'", () => {
		const result = findBankByName("kbc");
		expect(result).not.toBeNull();
		expect(result?.bankId).toBe("539");
		expect(result?.bic).toBe("KREDBEBB");
		expect(result?.name).toBe("KBC");
	});

	it("finds KBC with mixed case 'KBC'", () => {
		const result = findBankByName("KBC");
		expect(result?.bankId).toBe("539");
	});

	it("finds ING by alias", () => {
		const result = findBankByName("ing");
		expect(result).not.toBeNull();
		expect(result?.bic).toBe("BBRUBEBB");
	});

	it("finds Belfius by canonical name", () => {
		const result = findBankByName("belfius");
		expect(result).not.toBeNull();
		expect(result?.bankId).toBe("068");
		expect(result?.bic).toBe("GKCCBEBB");
	});

	it("finds BNP Paribas Fortis by partial alias 'fortis'", () => {
		const result = findBankByName("fortis");
		expect(result).not.toBeNull();
		expect(result?.bankId).toBe("001");
		expect(result?.bic).toBe("GEBABEBB");
	});

	it("finds BNP Paribas Fortis by partial alias 'bnp'", () => {
		const result = findBankByName("bnp");
		expect(result).not.toBeNull();
		expect(result?.bankId).toBe("001");
	});

	it("finds Argenta by name", () => {
		const result = findBankByName("argenta");
		expect(result).not.toBeNull();
		expect(result?.bankId).toBe("034");
		expect(result?.bic).toBe("ARSPBE22");
	});

	it("finds bpost bank by alias 'bpost'", () => {
		const result = findBankByName("bpost");
		expect(result).not.toBeNull();
		expect(result?.bankId).toBe("860");
		expect(result?.bic).toBe("BMPBBEBB");
	});

	it("finds Wise by canonical name", () => {
		const result = findBankByName("wise");
		expect(result).not.toBeNull();
		expect(result?.bankId).toBe("690");
		expect(result?.bic).toBe("TRWIBEB1");
	});

	it("finds Wise by former alias 'transferwise'", () => {
		const result = findBankByName("transferwise");
		expect(result).not.toBeNull();
		expect(result?.bankId).toBe("690");
	});

	it("finds CBC by canonical name", () => {
		const result = findBankByName("cbc");
		expect(result).not.toBeNull();
		expect(result?.bankId).toBe("097");
		expect(result?.bic).toBe("CREGBEBB");
	});

	it("finds AXA Bank by alias 'axa'", () => {
		const result = findBankByName("axa");
		expect(result).not.toBeNull();
		expect(result?.bankId).toBe("143");
		expect(result?.bic).toBe("ABORBE22");
	});

	it("finds Crelan by alias", () => {
		const result = findBankByName("crelan");
		expect(result).not.toBeNull();
		expect(result?.bankId).toBe("143");
	});

	it("finds Keytrade by name", () => {
		const result = findBankByName("keytrade");
		expect(result).not.toBeNull();
		expect(result?.bankId).toBe("683");
		expect(result?.bic).toBe("NICABEBB");
	});

	it("returns null for an unknown bank name", () => {
		expect(findBankByName("nonexistent bank xyz")).toBeNull();
	});

	it("returns null for an empty query", () => {
		expect(findBankByName("")).toBeNull();
	});

	it("returns null for a whitespace-only query", () => {
		expect(findBankByName("   ")).toBeNull();
	});

	it("is case-insensitive — uppercase BELFIUS matches", () => {
		const result = findBankByName("BELFIUS");
		expect(result?.bankId).toBe("068");
	});
});

// ---------------------------------------------------------------------------
// BELGIAN_BANKS map — structural integrity
// ---------------------------------------------------------------------------

describe("BELGIAN_BANKS map", () => {
	it("contains all 11 expected entries", () => {
		expect(BELGIAN_BANKS.size).toBe(11);
	});

	it("every key is a 3-digit string", () => {
		for (const key of BELGIAN_BANKS.keys()) {
			expect(key).toMatch(/^\d{3}$/);
		}
	});

	it("every entry has a non-empty name, bic, and aliases array", () => {
		for (const [, entry] of BELGIAN_BANKS) {
			expect(entry.name.length).toBeGreaterThan(0);
			expect(entry.bic.length).toBeGreaterThan(0);
			expect(Array.isArray(entry.aliases)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// validateIban
// ---------------------------------------------------------------------------

describe("validateIban", () => {
	it("validates a correct Belgian IBAN", () => {
		expect(validateIban("BE68539007547034")).toBe(true);
	});

	it("validates a correct German IBAN", () => {
		expect(validateIban("DE89370400440532013000")).toBe(true);
	});

	it("validates a correct Dutch IBAN", () => {
		expect(validateIban("NL91ABNA0417164300")).toBe(true);
	});

	it("validates a correct French IBAN", () => {
		expect(validateIban("FR7630006000011234567890189")).toBe(true);
	});

	it("validates a correct Luxembourg IBAN", () => {
		expect(validateIban("LU280019400644750000")).toBe(true);
	});

	it("rejects an IBAN with invalid check digits", () => {
		expect(validateIban("BE99539007547034")).toBe(false);
	});

	it("rejects an IBAN with wrong length for country", () => {
		expect(validateIban("BE6853900754703")).toBe(false);  // 15 chars, should be 16
	});

	it("rejects an empty string", () => {
		expect(validateIban("")).toBe(false);
	});

	it("handles IBAN with spaces (strips them)", () => {
		expect(validateIban("BE68 5390 0754 7034")).toBe(true);
	});

	it("handles lowercase input", () => {
		expect(validateIban("be68539007547034")).toBe(true);
	});

	it("rejects garbage string", () => {
		expect(validateIban("XX99garbage")).toBe(false);
	});

	it("rejects non-string input", () => {
		// @ts-expect-error -- testing runtime guard
		expect(validateIban(null)).toBe(false);
		// @ts-expect-error -- testing runtime guard
		expect(validateIban(undefined)).toBe(false);
	});
});
