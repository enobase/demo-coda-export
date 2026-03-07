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
 *     --bank-id 539 \
 *     --opening-balance 1234.56 \
 *     --opening-date 2026-01-01
 *
 *   coda-export convert --input transactions.csv --config account.json
 *   coda-export validate --input statement.cod
 *   coda-export --help
 */

import { readFileSync, writeFileSync } from "node:fs";
import { analyzeFile, formatReport } from "./compare.ts";
import { encodeLatin1 } from "./encoding.ts";
import type { CodaConfig } from "./mapper.ts";
import { mapToCoda, validateConfig } from "./mapper.ts";
import type { InputFormat } from "./parsers/index.ts";
import { detectFormat, parseTransactions } from "./parsers/index.ts";
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
 * Boolean flags (--dry-run, --help) are stored as the string "true".
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
	// Merge: config file first, then CLI flags override
	const bankId = flags["bank-id"] ?? configFile?.bankId ?? "";
	const accountIban = flags["account-iban"] ?? configFile?.accountIban ?? "";
	const accountCurrency = flags["account-currency"] ?? configFile?.accountCurrency ?? "EUR";
	const accountHolderName = flags["account-holder"] ?? configFile?.accountHolderName ?? "";
	const accountDescription = flags["account-description"] ?? configFile?.accountDescription;
	const applicationCode = flags["application-code"] ?? configFile?.applicationCode;
	const bic = flags.bic ?? configFile?.bic;
	const companyId = flags["company-id"] ?? configFile?.companyId;
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

Options:
  --help, -h  Show this help message

Run "coda-export <command> --help" for command-specific options.
`.trimStart();

const HELP_CONVERT = `
coda-export convert — Convert a CSV file to CODA format

Usage:
  coda-export convert --input <file.csv> [--output <file.cod>] [options]
  coda-export convert --input <file.csv> --config <account.json>

Required options (if not in config file):
  --input <path>             Path to the input CSV file
  --account-iban <IBAN>      Account IBAN (e.g. BE68539007547034)
  --account-holder <name>    Account holder name (max 26 chars)
  --bank-id <id>             Bank identification number (1-3 chars)
  --opening-balance <amount> Opening balance (e.g. 1234.56)
  --opening-date <YYYY-MM-DD> Date of opening balance

Optional options:
  --output <path>            Output file path (default: stdout)
  --config <path>            JSON config file (merged with CLI flags)
  --format <fmt>             Force input format: revolut-personal,
                             revolut-business, or qonto
  --account-currency <code>  Currency code (default: EUR)
  --account-description <s>  Account description (max 35 chars)
  --bic <bic>                Bank BIC (11 chars)
  --company-id <id>          Company identification number
  --statement-sequence <n>   Statement sequence number (default: 1)
  --dry-run                  Show what would be generated without writing
  --help                     Show this help message
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

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

function cmdConvert(flags: Record<string, string>): void {
	if (flags.help === "true") {
		process.stdout.write(HELP_CONVERT);
		return;
	}

	// Load config file if provided
	let configFile: ConfigFileShape | undefined;
	if (flags.config) {
		configFile = loadConfigFile(flags.config);
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

	// Build config
	let config: CodaConfig;
	try {
		config = buildCodaConfig(flags, configFile);
		validateConfig(config);
	} catch (e) {
		process.stderr.write(`Error: ${(e as Error).message}\n`);
		process.exit(1);
	}

	// Detect / force format
	const forcedFormat = flags.format as InputFormat | undefined;

	// Parse transactions
	let transactions: ReturnType<typeof parseTransactions>;
	try {
		transactions = parseTransactions(csvContent, forcedFormat);
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

	// Write output encoded as Latin-1 (ISO-8859-1), matching real CODA files.
	const outputPath = flags.output;
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

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function main(argv: string[]): void {
	const { command, flags } = parseArgs(argv);

	const knownCommands = new Set(["convert", "validate", "compare"]);

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
			cmdConvert(flags);
			break;
		case "validate":
			cmdValidate(flags);
			break;
		case "compare":
			cmdCompare(flags);
			break;
		default:
			process.stderr.write(`Error: Unknown command "${command}"\n\n`);
			process.stdout.write(HELP_MAIN);
			process.exit(1);
	}
}

// Run when invoked directly
main(process.argv.slice(2));
