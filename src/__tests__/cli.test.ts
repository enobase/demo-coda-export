/**
 * Phase 4: CLI tests
 *
 * Tests arg parsing, config file loading, flag overrides, and error cases.
 * At least 10 test cases.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodaConfig, loadConfigFile, parseArgs } from "../cli.ts";

// ---------------------------------------------------------------------------
// parseArgs()
// ---------------------------------------------------------------------------

describe("parseArgs()", () => {
	it("parses a command with no flags", () => {
		const { command, flags } = parseArgs(["convert"]);
		expect(command).toBe("convert");
		expect(Object.keys(flags)).toHaveLength(0);
	});

	it("parses --key value pairs", () => {
		const { flags } = parseArgs([
			"convert",
			"--input",
			"transactions.csv",
			"--output",
			"statement.cod",
		]);
		expect(flags.input).toBe("transactions.csv");
		expect(flags.output).toBe("statement.cod");
	});

	it("parses boolean flags (no value token)", () => {
		const { flags } = parseArgs(["convert", "--dry-run"]);
		expect(flags["dry-run"]).toBe("true");
	});

	it("parses --help flag", () => {
		const { flags } = parseArgs(["--help"]);
		expect(flags.help).toBe("true");
	});

	it("parses multiple flags in any order", () => {
		const { command, flags } = parseArgs(["validate", "--input", "file.cod", "--help"]);
		expect(command).toBe("validate");
		expect(flags.input).toBe("file.cod");
		expect(flags.help).toBe("true");
	});

	it("returns null command when only flags provided", () => {
		const { command } = parseArgs(["--help"]);
		expect(command).toBeNull();
	});

	it("handles flag value that starts with non-dash character", () => {
		const { flags } = parseArgs(["convert", "--account-holder", "ACME BVBA"]);
		expect(flags["account-holder"]).toBe("ACME BVBA");
	});

	it("handles empty argv", () => {
		const { command, flags } = parseArgs([]);
		expect(command).toBeNull();
		expect(Object.keys(flags)).toHaveLength(0);
	});

	it("positional command comes after flags are consumed", () => {
		const { command, flags } = parseArgs(["convert", "--input", "f.csv", "--dry-run"]);
		// convert is the positional command, flags are parsed separately
		expect(command).toBe("convert");
		expect(flags.input).toBe("f.csv");
		expect(flags["dry-run"]).toBe("true");
	});
});

// ---------------------------------------------------------------------------
// loadConfigFile()
// ---------------------------------------------------------------------------

describe("loadConfigFile()", () => {
	const TMP = join(tmpdir(), `coda-cli-test-${process.pid}`);

	it("loads a valid JSON config file", () => {
		mkdirSync(TMP, { recursive: true });
		const path = join(TMP, "config.json");
		const configObj = {
			bankId: "539",
			accountIban: "BE68539007547034",
			accountCurrency: "EUR",
			accountHolderName: "Test User",
			openingBalance: 1000.0,
			openingBalanceDate: "2026-01-01",
		};
		writeFileSync(path, JSON.stringify(configObj));
		const result = loadConfigFile(path);
		expect(result.bankId).toBe("539");
		expect(result.accountIban).toBe("BE68539007547034");
		expect(result.openingBalance).toBe(1000.0);
	});

	it("throws on non-existent file", () => {
		expect(() => loadConfigFile("/nonexistent/path/config.json")).toThrow(
			/Cannot read config file/,
		);
	});

	it("throws on invalid JSON", () => {
		mkdirSync(TMP, { recursive: true });
		const path = join(TMP, "bad-config.json");
		writeFileSync(path, "{ not valid json }");
		expect(() => loadConfigFile(path)).toThrow(/not valid JSON/);
	});
});

// ---------------------------------------------------------------------------
// buildCodaConfig()
// ---------------------------------------------------------------------------

describe("buildCodaConfig()", () => {
	const BASE_FLAGS: Record<string, string> = {
		"bank-id": "539",
		"account-iban": "BE68539007547034",
		"account-holder": "Test User",
		"opening-balance": "1000.00",
		"opening-date": "2026-01-01",
	};

	it("builds a valid config from CLI flags alone", () => {
		const config = buildCodaConfig(BASE_FLAGS);
		expect(config.bankId).toBe("539");
		expect(config.accountIban).toBe("BE68539007547034");
		expect(config.accountHolderName).toBe("Test User");
		expect(config.openingBalance).toBe(1000.0);
		expect(config.openingBalanceDate).toEqual(new Date("2026-01-01"));
	});

	it("CLI flags override config file values", () => {
		const configFile = {
			bankId: "999",
			accountIban: "BE00000000000000",
			accountHolderName: "Config File Name",
			openingBalance: 500.0,
			openingBalanceDate: "2025-06-01",
		};
		// CLI flag for account-holder should override config file
		const flags = { ...BASE_FLAGS, "account-holder": "CLI Override Name" };
		const config = buildCodaConfig(flags, configFile);
		expect(config.accountHolderName).toBe("CLI Override Name");
		// bank-id from CLI takes precedence
		expect(config.bankId).toBe("539");
	});

	it("uses config file values when CLI flags are absent", () => {
		const configFile = {
			bankId: "539",
			accountIban: "BE68539007547034",
			accountHolderName: "From Config",
			openingBalance: 2000.0,
			openingBalanceDate: "2026-01-01",
			bic: "BBRUBEBB",
		};
		const config = buildCodaConfig({}, configFile);
		expect(config.accountHolderName).toBe("From Config");
		expect(config.openingBalance).toBe(2000.0);
		expect(config.bic).toBe("BBRUBEBB");
	});

	it("throws when opening-balance is missing", () => {
		const flags = { ...BASE_FLAGS };
		delete flags["opening-balance"];
		expect(() => buildCodaConfig(flags)).toThrow(/opening-balance/);
	});

	it("throws when opening-date is missing", () => {
		const flags = { ...BASE_FLAGS };
		delete flags["opening-date"];
		expect(() => buildCodaConfig(flags)).toThrow(/opening-date/);
	});

	it("throws when opening-balance is not a number", () => {
		const flags = { ...BASE_FLAGS, "opening-balance": "not-a-number" };
		expect(() => buildCodaConfig(flags)).toThrow(/Invalid opening balance/);
	});

	it("throws when opening-date is invalid", () => {
		const flags = { ...BASE_FLAGS, "opening-date": "not-a-date" };
		expect(() => buildCodaConfig(flags)).toThrow(/Invalid opening date/);
	});

	it("defaults account-currency to EUR", () => {
		const config = buildCodaConfig(BASE_FLAGS);
		expect(config.accountCurrency).toBe("EUR");
	});

	it("accepts optional fields: bic, company-id, account-description", () => {
		const flags = {
			...BASE_FLAGS,
			bic: "BBRUBEBB   ",
			"company-id": "BE0123456789",
			"account-description": "Current account",
		};
		const config = buildCodaConfig(flags);
		expect(config.bic).toBe("BBRUBEBB   ");
		expect(config.companyId).toBe("BE0123456789");
		expect(config.accountDescription).toBe("Current account");
	});

	it("parses statement-sequence as a number", () => {
		const flags = { ...BASE_FLAGS, "statement-sequence": "5" };
		const config = buildCodaConfig(flags);
		expect(config.statementSequence).toBe(5);
	});

	it("handles negative opening balance", () => {
		const flags = { ...BASE_FLAGS, "opening-balance": "-250.75" };
		const config = buildCodaConfig(flags);
		expect(config.openingBalance).toBe(-250.75);
	});
});
