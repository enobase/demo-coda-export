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
import { inferCsvDefaults } from "../defaults.ts";
import { parseTransactions } from "../parsers/index.ts";

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

	it("loads a valid JSON config file", async () => {
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
		const result = await loadConfigFile(path);
		expect(result.bankId).toBe("539");
		expect(result.accountIban).toBe("BE68539007547034");
		expect(result.openingBalance).toBe(1000.0);
	});

	it("throws on non-existent file", async () => {
		await expect(loadConfigFile("/nonexistent/path/config.json")).rejects.toThrow(
			/Cannot read config file/,
		);
	});

	it("throws on invalid JSON", async () => {
		mkdirSync(TMP, { recursive: true });
		const path = join(TMP, "bad-config.json");
		writeFileSync(path, "{ not valid json }");
		await expect(loadConfigFile(path)).rejects.toThrow(/not valid JSON/);
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
		expect(config.companyId).toBe("00123456789"); // BE prefix stripped, formatted as 0 + 10 digits
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

// ---------------------------------------------------------------------------
// init --input: CSV-based inference integration
// ---------------------------------------------------------------------------

describe("init --input: inferCsvDefaults() via parseTransactions()", () => {
	const REVOLUT_PERSONAL_CSV = [
		"Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance",
		"CARD_PAYMENT,Current,2026-01-15 10:00:00,2026-01-15 14:00:00,Supermarket,-42.50,0.00,EUR,COMPLETED,1957.50",
		"TRANSFER,Current,2026-01-16 09:00:00,2026-01-16 09:05:00,Rent,-500.00,0.00,EUR,COMPLETED,1457.50",
		"TOPUP,Current,2026-01-17 08:00:00,2026-01-17 08:01:00,Top-Up,2000.00,0.00,EUR,COMPLETED,3457.50",
	].join("\n");

	const QONTO_CSV = [
		"Status,Settlement date (UTC),Operation date (UTC),Total amount (incl. VAT),Currency,Counterparty name,Payment method,Transaction ID,IBAN,Reference,Category,Note,VAT amount,Initiator",
		"settled,2026-01-10 08:00:00,2026-01-10 08:00:00,-150.00,EUR,Proximus,direct_debit,qt_001,BE95001234567890,,,,,Admin",
		"settled,2026-01-12 10:00:00,2026-01-12 10:00:00,5000.00,EUR,Client Alpha,transfer,qt_002,,,,,0.00,Admin",
	].join("\n");

	const WISE_GBP_CSV = [
		"TransferWise ID,Date,Amount,Currency,Description,Payment Reference,Running Balance,Exchange From,Exchange To,Exchange Rate,Payer Name,Payee Name,Payee Account Number,Merchant,Card Last Four Digits,Card Holder Full Name,Attachment,Note,Total Fees",
		"W001,15-01-2026,500.00,GBP,Salary,,1500.00,,,,Employer Ltd,,,,,,,, 0.00",
		"W002,16-01-2026,-50.00,GBP,Groceries,,1450.00,,,,,Tesco,,,,,,, 0.00",
	].join("\n");

	it("parses --input flag correctly in parseArgs", () => {
		const { flags } = parseArgs(["init", "--input", "transactions.csv"]);
		expect(flags.input).toBe("transactions.csv");
	});

	it("infers EUR currency from Revolut Personal CSV", () => {
		const transactions = parseTransactions(REVOLUT_PERSONAL_CSV);
		const { currency } = inferCsvDefaults(transactions);
		expect(currency).toBe("EUR");
	});

	it("infers EUR currency from Qonto CSV", () => {
		const transactions = parseTransactions(QONTO_CSV);
		const { currency } = inferCsvDefaults(transactions);
		expect(currency).toBe("EUR");
	});

	it("infers GBP currency from Wise CSV", () => {
		const transactions = parseTransactions(WISE_GBP_CSV);
		const { currency } = inferCsvDefaults(transactions);
		expect(currency).toBe("GBP");
	});

	it("returns no holder name when source does not expose one", () => {
		const transactions = parseTransactions(REVOLUT_PERSONAL_CSV);
		const { holderName } = inferCsvDefaults(transactions);
		expect(holderName).toBeUndefined();
	});

	it("works end-to-end: write CSV to tmp file, parse it, infer defaults", () => {
		const TMP = join(tmpdir(), `coda-init-test-${process.pid}`);
		mkdirSync(TMP, { recursive: true });
		const csvPath = join(TMP, "transactions.csv");
		writeFileSync(csvPath, QONTO_CSV);

		const content = require("node:fs").readFileSync(csvPath, "utf-8");
		const transactions = parseTransactions(content);
		const { currency, holderName } = inferCsvDefaults(transactions);

		expect(currency).toBe("EUR");
		expect(holderName).toBeUndefined();
		expect(transactions.length).toBe(2);
	});
});
