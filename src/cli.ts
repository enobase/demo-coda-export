#!/usr/bin/env bun
/**
 * coda-export CLI
 *
 * Converts neobank CSV exports (Revolut Personal, Revolut Business, Qonto)
 * to Belgian CODA bank statement format.
 *
 * Usage:
 *   coda-export convert --input transactions.csv --output statement.cod \
 *     --account-iban BE68539007547034 \
 *     --account-holder "ACME BVBA" \
 *     --opening-balance 1234.56
 *
 *   coda-export convert --input transactions.csv --config account.json
 *   coda-export validate --input statement.cod
 *   coda-export init
 *   coda-export --help
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractBankIdFromIban, lookupBic, lookupNeobankBic } from "./belgian-banks.ts";
import { analyzeFile, formatReport } from "./compare.ts";
import { inferCsvDefaults, inferOpeningDate, inferOutputPath } from "./defaults.ts";
import { encodeLatin1 } from "./encoding.ts";
import type { CodaConfig } from "./mapper.ts";
import { mapToCoda, validateConfig } from "./mapper.ts";
import type { InputFormat } from "./parsers/index.ts";
import { detectFormat, parseTransactions } from "./parsers/index.ts";
import { isTTY, logDerived, prompt as promptUser } from "./prompt.ts";
import { serializeCoda } from "./serializer.ts";
import { validate } from "./validator.ts";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
	command: string | null;
	flags: Record<string, string>;
	positional: string[];
}

/**
 * Parse process.argv into a simple structure.
 * Supports --key value pairs and bare positional arguments.
 * Boolean flags (--dry-run, --help, --version) are stored as the string "true".
 */
export function parseArgs(argv: string[]): ParsedArgs {
	const flags: Record<string, string> = {};
	const positional: string[] = [];
	let i = 0;

	// Skip the interpreter and script path if present (bun /path/to/cli.ts ...)
	// We treat the first non-flag token as the command
	while (i < argv.length) {
		const arg = argv[i];

		if (arg === "--help" || arg === "-h") {
			flags.help = "true";
			i++;
			continue;
		}

		if (arg === "--version") {
			flags.version = "true";
			i++;
			continue;
		}

		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			// Peek: if next token exists and is not a flag, treat as value
			if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
				flags[key] = argv[i + 1];
				i += 2;
			} else {
				// Boolean flag
				flags[key] = "true";
				i++;
			}
			continue;
		}

		positional.push(arg);
		i++;
	}

	const command = positional[0] ?? null;

	return { command, flags, positional };
}

// ---------------------------------------------------------------------------
// Company ID formatting
// ---------------------------------------------------------------------------

/**
 * Format a company identification number for the CODA Record 0 [71:82] field.
 *
 * The CODA spec requires: '0' + 10-digit Belgian enterprise number = 11 chars.
 * Accepts various input formats:
 *   - "BE0123456789" (VAT number with BE prefix)
 *   - "0123.456.789" (enterprise number with dots)
 *   - "0123456789"   (raw 10 digits)
 *   - ""             (empty → returns empty string)
 *
 * Returns the 11-char formatted string, or empty string if input is empty.
 */
export function formatCompanyId(raw: string): string {
	if (!raw || raw.trim() === "") return "";

	// Strip "BE" prefix (case-insensitive), dots, spaces, dashes
	let digits = raw.trim().toUpperCase();
	if (digits.startsWith("BE")) digits = digits.slice(2);
	digits = digits.replace(/[\s.\-/]/g, "");

	// Should be 10 digits now
	if (!/^\d{10}$/.test(digits)) {
		// If 9 digits, prepend 0
		if (/^\d{9}$/.test(digits)) {
			digits = `0${digits}`;
		} else {
			process.stderr.write(
				`Warning: Company ID "${raw}" does not look like a Belgian enterprise number (expected 10 digits). Using as-is.\n`,
			);
			return digits.slice(0, 11).padStart(11, "0");
		}
	}

	// CODA format: '0' + 10-digit enterprise number
	return `0${digits}`;
}

// ---------------------------------------------------------------------------
// Config file loading
// ---------------------------------------------------------------------------

interface ConfigFileShape {
	bankId?: string;
	accountIban?: string;
	accountCurrency?: string;
	accountHolderName?: string;
	accountDescription?: string;
	applicationCode?: string;
	bic?: string;
	companyId?: string;
	statementSequence?: number;
	openingBalance?: number;
	openingBalanceDate?: string;
}

/**
 * Load a JSON config file and return the raw object.
 * Throws a descriptive error on parse failure.
 */
export function loadConfigFile(path: string): ConfigFileShape {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (e) {
		throw new Error(`Cannot read config file "${path}": ${(e as NodeJS.ErrnoException).message}`);
	}

	try {
		return JSON.parse(raw) as ConfigFileShape;
	} catch (e) {
		throw new Error(`Config file "${path}" is not valid JSON: ${(e as Error).message}`);
	}
}

// ---------------------------------------------------------------------------
// CodaConfig builder from flags + optional config file
// ---------------------------------------------------------------------------

/**
 * Build a CodaConfig by merging a config file (optional) with CLI flags.
 * CLI flags take precedence over config file values.
 */
export function buildCodaConfig(
	flags: Record<string, string>,
	configFile?: ConfigFileShape,
): CodaConfig {
	// Resolve IBAN first so we can auto-derive bankId and bic from it
	const accountIban = flags["account-iban"] ?? configFile?.accountIban ?? "";

	// Auto-derive bankId from IBAN if not explicitly provided
	let bankId = flags["bank-id"] ?? configFile?.bankId ?? "";
	if (!bankId && accountIban) {
		const derived = extractBankIdFromIban(accountIban);
		if (derived) {
			bankId = derived;
		} else if (accountIban.length >= 7) {
			// Non-Belgian IBAN: use first 3 chars of the BBAN as a generic identifier
			bankId = accountIban.replace(/\s/g, "").toUpperCase().slice(4, 7);
		}
	}

	// Auto-derive BIC from bankId if not explicitly provided
	let bic = flags.bic ?? configFile?.bic;
	if (!bic && bankId) {
		const derivedBic = lookupBic(bankId);
		if (derivedBic) bic = derivedBic;
	}

	const accountCurrency = flags["account-currency"] ?? configFile?.accountCurrency ?? "EUR";
	const accountHolderName = flags["account-holder"] ?? configFile?.accountHolderName ?? "";
	const accountDescription = flags["account-description"] ?? configFile?.accountDescription;
	const applicationCode = flags["application-code"] ?? configFile?.applicationCode;
	const companyIdRaw = flags["company-id"] ?? configFile?.companyId;
	const companyId = companyIdRaw ? formatCompanyId(companyIdRaw) : undefined;
	const statementSequenceRaw =
		flags["statement-sequence"] ?? configFile?.statementSequence?.toString();
	const statementSequence = statementSequenceRaw ? Number(statementSequenceRaw) : undefined;

	const openingBalanceRaw = flags["opening-balance"] ?? configFile?.openingBalance?.toString();
	if (openingBalanceRaw === undefined) {
		throw new Error(
			"Missing required option: --opening-balance (or openingBalance in config file)",
		);
	}
	const openingBalance = Number(openingBalanceRaw);
	if (!Number.isFinite(openingBalance)) {
		throw new Error(`Invalid opening balance: "${openingBalanceRaw}"`);
	}

	const openingDateRaw = flags["opening-date"] ?? configFile?.openingBalanceDate;
	if (!openingDateRaw) {
		throw new Error(
			"Missing required option: --opening-date (or openingBalanceDate in config file)",
		);
	}
	// If the user passes a bare date like "2026-01-01" (no time component),
	// JavaScript parses it as UTC midnight — which is correct. But if they
	// pass a local-time string like "2026-01-01T00:00:00" (no Z), it would
	// be treated as local time and could shift to the previous day in UTC+
	// timezones. Normalise: append T00:00:00Z if there is no time component.
	const openingDateNormalised = /^\d{4}-\d{2}-\d{2}$/.test(openingDateRaw)
		? `${openingDateRaw}T00:00:00Z`
		: openingDateRaw;
	const openingBalanceDate = new Date(openingDateNormalised);
	if (Number.isNaN(openingBalanceDate.getTime())) {
		throw new Error(`Invalid opening date: "${openingDateRaw}"`);
	}

	const config: CodaConfig = {
		bankId,
		accountIban,
		accountCurrency,
		accountHolderName,
		openingBalance,
		openingBalanceDate,
	};

	if (accountDescription !== undefined) config.accountDescription = accountDescription;
	if (applicationCode !== undefined) config.applicationCode = applicationCode;
	if (bic !== undefined) config.bic = bic;
	if (companyId !== undefined) config.companyId = companyId;
	if (statementSequence !== undefined) config.statementSequence = statementSequence;

	return config;
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP_MAIN = `
coda-export — Convert neobank CSV exports to Belgian CODA format

Usage:
  coda-export <command> [options]

Commands:
  convert   Convert a CSV file to a CODA statement
  validate  Validate an existing CODA file
  compare   Structurally compare two CODA files (no PII)
  init      Create a config file interactively

Options:
  --help, -h   Show this help message
  --version    Show version number

Run "coda-export <command> --help" for command-specific options.
`.trimStart();

const HELP_CONVERT = `
coda-export convert — Convert a CSV file to CODA format

Usage:
  coda-export convert --input <file.csv> [--output <file.cod>] [options]
  coda-export convert --input <file.csv> --config <account.json>

Config is auto-discovered at ./coda-export.json or ~/.coda-export.json.

Required options (if not in config file and not prompted interactively):
  --input <path>             Path to the input CSV file
  --account-iban <IBAN>      Account IBAN (e.g. BE68539007547034)
  --account-holder <name>    Account holder name (max 26 chars)
  --opening-balance <amount> Opening balance (e.g. 1234.56)

Optional options (auto-derived or prompted when running interactively):
  --bank-id <id>             Bank identification number (auto-derived from Belgian IBANs)
  --opening-date <YYYY-MM-DD> Date of opening balance (inferred from CSV if omitted)
  --output <path>            Output file path (default: <input>.cod in TTY mode, stdout otherwise)
  --config <path>            JSON config file (merged with CLI flags)
  --format <fmt>             Force input format: revolut-personal,
                             revolut-business, or qonto
  --account-currency <code>  Currency code (default: EUR)
  --account-description <s>  Account description (max 35 chars)
  --bic <bic>                Bank BIC (11 chars, auto-derived from Belgian IBANs)
  --company-id <id>          Company identification number
  --statement-sequence <n>   Statement sequence number (default: 1)
  --dry-run                  Show what would be generated without writing
  --help                     Show this help message

In interactive (TTY) mode, missing required values will be prompted.
`.trimStart();

const HELP_VALIDATE = `
coda-export validate — Validate an existing CODA file

Usage:
  coda-export validate --input <file.cod>

Options:
  --input <path>  Path to the CODA file to validate
  --help          Show this help message
`.trimStart();

const HELP_COMPARE = `
coda-export compare — Structurally compare two CODA files

Usage:
  coda-export compare --reference <real-bank.cod> --generated <our-output.cod>

Compares metadata and structural patterns only.
NO amounts, NO names, NO account numbers, NO PII are included in the output.

Options:
  --reference <path>  Path to the reference CODA file (e.g. a real bank file)
  --generated <path>  Path to the generated CODA file to compare against
  --help              Show this help message

What is compared:
  - Line counts and line length conformance
  - Version code (Record 0, position 127)
  - Account structure code (Record 1, position 1)
  - Count of each record type (0, 1, 21, 22, 23, 31, 32, 33, 4, 8, 9)
  - Transaction code families (Record 21, positions 53-54)
  - Communication types (Record 21, position 61)
  - Record 22 chain pattern (always between 21 and 23?)
  - File encoding (Latin-1 vs UTF-8)
`.trimStart();

const HELP_INIT = `
coda-export init — Create a config file interactively

Usage:
  coda-export init [--input <file.csv>]

Prompts for your account details (IBAN, holder name, currency) and creates
a config file. Bank ID and BIC are auto-derived from Belgian IBANs.

When --input is provided, the CSV is parsed to infer defaults such as the
account currency. Prompts are pre-filled with inferred values so you can
confirm or overwrite them.

The config file is auto-discovered at ./coda-export.json or ~/.coda-export.json.

Options:
  --input <path>  Optional path to a CSV export to infer defaults from
  --help          Show this help message
`.trimStart();

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function cmdConvert(flags: Record<string, string>): Promise<void> {
	if (flags.help === "true") {
		process.stdout.write(HELP_CONVERT);
		return;
	}

	// Load config file if explicitly provided
	let configFile: ConfigFileShape | undefined;
	if (flags.config) {
		configFile = loadConfigFile(flags.config);
	}

	// Auto-discover config file if not explicitly provided
	if (!flags.config) {
		const localConfig = "coda-export.json";
		const globalConfig = join(homedir(), ".coda-export.json");
		if (existsSync(localConfig)) {
			configFile = loadConfigFile(localConfig);
			process.stderr.write(`Loaded config from ${localConfig}\n`);
		} else if (existsSync(globalConfig)) {
			configFile = loadConfigFile(globalConfig);
			process.stderr.write(`Loaded config from ${globalConfig}\n`);
		}
	}

	// Input file
	const inputPath = flags.input;
	if (!inputPath) {
		process.stderr.write("Error: --input is required\n");
		process.exit(1);
	}

	let csvContent: string;
	try {
		csvContent = readFileSync(inputPath, "utf-8");
	} catch (e) {
		process.stderr.write(
			`Error: Cannot read input file "${inputPath}": ${(e as NodeJS.ErrnoException).message}\n`,
		);
		process.exit(1);
	}

	// Detect / force format
	const forcedFormat = flags.format as InputFormat | undefined;

	// Parse transactions first (so we can infer opening-date)
	let transactions: ReturnType<typeof parseTransactions>;
	try {
		transactions = parseTransactions(csvContent, forcedFormat);
	} catch (e) {
		process.stderr.write(`Error: ${(e as Error).message}\n`);
		process.exit(1);
	}

	// Infer opening-date from transactions if not provided
	if (!flags["opening-date"] && !configFile?.openingBalanceDate) {
		const inferred = inferOpeningDate(transactions);
		if (inferred) {
			const yyyy = inferred.getUTCFullYear();
			const mm = String(inferred.getUTCMonth() + 1).padStart(2, "0");
			const dd = String(inferred.getUTCDate()).padStart(2, "0");
			flags["opening-date"] = `${yyyy}-${mm}-${dd}`;
			process.stderr.write(`  ✓ Opening date: ${flags["opening-date"]} (day before earliest transaction)\n`);
		}
	}

	// Infer opening balance from running balance column (e.g. Qonto FR "Solde")
	if (!flags["opening-balance"] && configFile?.openingBalance === undefined) {
		const { openingBalance } = inferCsvDefaults(transactions);
		if (openingBalance !== undefined) {
			flags["opening-balance"] = String(openingBalance);
			process.stderr.write(`  ✓ Opening balance: ${openingBalance} (inferred from CSV running balance)\n`);
		}
	}

	// Interactive mode: show auto-derived values and prompt for missing required ones
	if (isTTY()) {
		const accountIban = flags["account-iban"] ?? configFile?.accountIban;
		if (accountIban) {
			const derivedBankId = extractBankIdFromIban(accountIban);
			if (derivedBankId) logDerived("Bank ID", derivedBankId);
			const derivedBic = lookupBic(derivedBankId ?? "");
			if (derivedBic) logDerived("BIC", derivedBic);
		}

		if (!flags["account-iban"] && !configFile?.accountIban) {
			flags["account-iban"] = await promptUser("Account IBAN (e.g. BE68539007547034)");
		}
		if (!flags["account-holder"] && !configFile?.accountHolderName) {
			flags["account-holder"] = await promptUser("Account holder name (max 26 chars)");
		}
		if (!flags["opening-balance"] && configFile?.openingBalance === undefined) {
			flags["opening-balance"] = await promptUser("Opening balance (e.g. 1234.56)");
		}
		if (!flags["opening-date"] && !configFile?.openingBalanceDate) {
			flags["opening-date"] = await promptUser("Opening balance date (YYYY-MM-DD)");
		}
	}

	// Build config
	let config: CodaConfig;
	try {
		config = buildCodaConfig(flags, configFile);
		validateConfig(config);
	} catch (e) {
		process.stderr.write(`Error: ${(e as Error).message}\n`);
		process.exit(1);
	}

	// Map and serialize
	let codaContent: string;
	try {
		const statement = mapToCoda(transactions, config);
		codaContent = serializeCoda(statement);
	} catch (e) {
		process.stderr.write(`Error: ${(e as Error).message}\n`);
		process.exit(1);
	}

	// Dry run: just print stats and a preview
	if (flags["dry-run"] === "true") {
		const lineCount = codaContent.split("\n").filter((l) => l.length > 0).length;
		process.stdout.write(`Dry run — would generate ${lineCount} CODA record lines\n`);
		process.stdout.write(
			`Detected format: ${detectFormat(csvContent) ?? forcedFormat ?? "unknown"}\n`,
		);
		process.stdout.write(`Transactions parsed: ${transactions.length}\n`);
		return;
	}

	// Determine output path
	const outputPath = flags.output ?? (process.stdout.isTTY ? inferOutputPath(inputPath) : undefined);

	// Write output encoded as Latin-1 (ISO-8859-1), matching real CODA files.
	if (outputPath) {
		try {
			writeFileSync(outputPath, encodeLatin1(codaContent));
			process.stderr.write(`Written to ${outputPath}\n`);
		} catch (e) {
			process.stderr.write(
				`Error: Cannot write output file "${outputPath}": ${(e as NodeJS.ErrnoException).message}\n`,
			);
			process.exit(1);
		}
	} else {
		// stdout
		process.stdout.write(encodeLatin1(codaContent));
	}
}

function cmdValidate(flags: Record<string, string>): void {
	if (flags.help === "true") {
		process.stdout.write(HELP_VALIDATE);
		return;
	}

	const inputPath = flags.input;
	if (!inputPath) {
		process.stderr.write("Error: --input is required\n");
		process.exit(1);
	}

	let content: string;
	try {
		content = readFileSync(inputPath, "utf-8");
	} catch (e) {
		process.stderr.write(
			`Error: Cannot read file "${inputPath}": ${(e as NodeJS.ErrnoException).message}\n`,
		);
		process.exit(1);
	}

	const result = validate(content);

	if (result.valid) {
		process.stdout.write(`✓ ${inputPath} is a valid CODA file\n`);
		if (result.errors.length > 0) {
			// There are warnings but no errors
			for (const e of result.errors) {
				process.stdout.write(`  warning (line ${e.line}): ${e.message}\n`);
			}
		}
	} else {
		process.stderr.write(`✗ ${inputPath} has validation errors:\n`);
		for (const e of result.errors) {
			const prefix = e.severity === "error" ? "  error" : "  warning";
			process.stderr.write(`${prefix} (line ${e.line}): ${e.message}\n`);
		}
		process.exit(1);
	}
}

function cmdCompare(flags: Record<string, string>): void {
	if (flags.help === "true") {
		process.stdout.write(HELP_COMPARE);
		return;
	}

	const referencePath = flags.reference;
	const generatedPath = flags.generated;

	if (!referencePath) {
		process.stderr.write("Error: --reference is required\n");
		process.exit(1);
	}
	if (!generatedPath) {
		process.stderr.write("Error: --generated is required\n");
		process.exit(1);
	}

	let refBytes: Uint8Array;
	let refContent: string;
	try {
		refBytes = new Uint8Array(readFileSync(referencePath));
		refContent = new TextDecoder("latin1").decode(refBytes);
	} catch (e) {
		process.stderr.write(
			`Error: Cannot read reference file "${referencePath}": ${(e as NodeJS.ErrnoException).message}\n`,
		);
		process.exit(1);
	}

	let genBytes: Uint8Array;
	let genContent: string;
	try {
		genBytes = new Uint8Array(readFileSync(generatedPath));
		genContent = new TextDecoder("latin1").decode(genBytes);
	} catch (e) {
		process.stderr.write(
			`Error: Cannot read generated file "${generatedPath}": ${(e as NodeJS.ErrnoException).message}\n`,
		);
		process.exit(1);
	}

	const reference = analyzeFile(refContent, refBytes);
	const generated = analyzeFile(genContent, genBytes);

	process.stdout.write(formatReport({ reference, generated }));
}

async function cmdInit(flags: Record<string, string>): Promise<void> {
	if (flags.help === "true") {
		process.stdout.write(HELP_INIT);
		return;
	}

	// Optionally parse an input CSV to infer defaults
	let inferredCurrency: string | undefined;
	let inferredHolder: string | undefined;
	let inferredOpeningBalance: number | undefined;
	let detectedFormat: string | undefined;

	const inputPath = flags.input;
	if (inputPath) {
		let csvContent: string;
		try {
			csvContent = readFileSync(inputPath, "utf-8");
		} catch (e) {
			process.stderr.write(
				`Error: Cannot read input file "${inputPath}": ${(e as NodeJS.ErrnoException).message}\n`,
			);
			process.exit(1);
		}

		let transactions: ReturnType<typeof parseTransactions>;
		try {
			transactions = parseTransactions(csvContent);
		} catch (e) {
			process.stderr.write(
				`Warning: Could not parse "${inputPath}" for defaults: ${(e as Error).message}\n`,
			);
			transactions = [];
		}

		if (transactions.length > 0) {
			const { currency, holderName, openingBalance } = inferCsvDefaults(transactions);
			inferredCurrency = currency;
			inferredHolder = holderName;
			inferredOpeningBalance = openingBalance;

			detectedFormat = detectFormat(csvContent) ?? undefined;
			if (detectedFormat) {
				process.stderr.write(`  ℹ  Detected format: ${detectedFormat}\n`);
			}
			if (inferredCurrency) {
				process.stderr.write(`  ℹ  Inferred currency: ${inferredCurrency} (from CSV transactions)\n`);
			}
			if (inferredOpeningBalance !== undefined) {
				process.stderr.write(`  ℹ  Inferred opening balance: ${inferredOpeningBalance} (from CSV running balance)\n`);
			}
		}
	}

	const configPath = await promptUser("Config file path", "coda-export.json");
	const iban = await promptUser("Account IBAN (e.g. BE68539007547034)");

	// Validate IBAN format
	if (!/^[A-Z]{2}\d{2}/i.test(iban.replace(/\s/g, ""))) {
		process.stderr.write("Error: Invalid IBAN format\n");
		process.exit(1);
	}

	const normalizedIban = iban.replace(/\s/g, "").toUpperCase();

	// Auto-derive bank-id and BIC
	const bankId = extractBankIdFromIban(normalizedIban);
	// Try Belgian bank lookup first, then neobank format lookup
	let bic = bankId ? lookupBic(bankId) : null;
	if (!bic && detectedFormat) {
		bic = lookupNeobankBic(detectedFormat);
	}

	if (bankId) logDerived("Bank ID", bankId);
	if (bic) {
		const source = bankId && lookupBic(bankId) ? "IBAN" : "detected format";
		process.stderr.write(`  ✓ BIC: ${bic} (derived from ${source})\n`);
	}

	// Pre-fill holder name with CSV-inferred value if available
	const holder = await promptUser("Account holder name (max 26 chars)", inferredHolder);
	// Pre-fill currency with CSV-inferred value, falling back to EUR
	const currency = await promptUser("Account currency", inferredCurrency ?? "EUR");
	// If no BIC was auto-derived, prompt for it
	let bicFinal = bic;
	if (!bicFinal) {
		const bicInput = await promptUser("Bank BIC/SWIFT (e.g. KREDBEBB, optional)");
		if (bicInput) bicFinal = bicInput.toUpperCase();
	}
	const companyIdRaw = await promptUser(
		"Company ID / enterprise number (e.g. BE0123456789 or 0123456789, optional)",
	);
	const description = await promptUser("Account description (optional, press Enter to skip)");

	// Format company ID: strip "BE" prefix, dots, spaces → 10 digits → prepend "0" for 11-char CODA field
	const companyId = formatCompanyId(companyIdRaw);

	const config: Record<string, unknown> = {
		accountIban: normalizedIban,
		accountHolderName: holder,
		accountCurrency: currency,
	};

	if (bankId) config.bankId = bankId;
	if (bicFinal) config.bic = bicFinal;
	if (companyId) config.companyId = companyId;
	if (description) config.accountDescription = description;
	if (inferredOpeningBalance !== undefined) config.openingBalance = inferredOpeningBalance;

	const json = JSON.stringify(config, null, 2) + "\n";

	writeFileSync(configPath, json);
	process.stderr.write(`\nConfig saved to ${configPath}\n`);
	process.stderr.write(`\nUsage:\n  coda-export convert --input transactions.csv --opening-balance 1234.56\n`);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<void> {
	const { command, flags } = parseArgs(argv);

	// Handle --version before anything else
	if (flags.version === "true") {
		const pkgJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
		process.stdout.write(`${pkgJson.version}\n`);
		return;
	}

	const knownCommands = new Set(["convert", "validate", "compare", "init"]);

	if (!command || flags.help === "true") {
		if (command && !knownCommands.has(command)) {
			process.stderr.write(`Error: Unknown command "${command}"\n\n`);
			process.stdout.write(HELP_MAIN);
			process.exit(1);
		}
		process.stdout.write(HELP_MAIN);
		return;
	}

	switch (command) {
		case "convert":
			await cmdConvert(flags);
			break;
		case "validate":
			cmdValidate(flags);
			break;
		case "compare":
			cmdCompare(flags);
			break;
		case "init":
			await cmdInit(flags);
			break;
		default:
			process.stderr.write(`Error: Unknown command "${command}"\n\n`);
			process.stdout.write(HELP_MAIN);
			process.exit(1);
	}
}

// Run when invoked directly
main(process.argv.slice(2)).catch((err) => {
	process.stderr.write(`Error: ${(err as Error).message}\n`);
	process.exit(1);
});
