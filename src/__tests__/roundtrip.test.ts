/**
 * Phase 5: pycoda round-trip tests
 *
 * Generates a CODA file from the Revolut Personal fixture, writes it to a
 * temp file, parses it back with pycoda (Python), and compares key fields.
 *
 * The test suite is skipped gracefully when:
 *   - python3 is not in PATH, OR
 *   - pycoda is not installed in the active Python environment.
 *
 * pycoda compatibility note:
 *   Our serializer now writes '0000' at positions [1:5] of Record 0, matching
 *   real bank-generated CODA files and pycoda's is_valid_coda() expectation.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodaConfig } from "../mapper.ts";
import { mapToCoda } from "../mapper.ts";
import { parseTransactions } from "../parsers/index.ts";
import { serializeCoda } from "../serializer.ts";

// ---------------------------------------------------------------------------
// Availability checks (run once at module load so skip decisions are fast)
// ---------------------------------------------------------------------------

/**
 * Check whether a command is available in PATH.
 * Returns true on exit code 0, false otherwise.
 */
function commandExists(cmd: string): boolean {
	try {
		const result = Bun.spawnSync(["which", cmd]);
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * Check whether pycoda can be imported by the active python3.
 */
function pycoda_available(): boolean {
	try {
		const result = Bun.spawnSync(["python3", "-c", "from coda.parser import Parser"]);
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

const PYTHON_AVAILABLE = commandExists("python3");
const PYCODA_AVAILABLE = PYTHON_AVAILABLE && pycoda_available();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Path to the verify script, relative to the repo root. */
const VERIFY_SCRIPT = join(import.meta.dir, "../../scripts/roundtrip-verify.py");

interface PycondaTransaction {
	amount: number;
	date: string | null;
	entryDate: string | null;
	communication: string | null;
	counterpartyName: string | null;
	counterpartyNumber: string | null;
	counterpartyBic: string | null;
}

interface PycondaStatement {
	accNumber: string | null;
	currency: string | null;
	oldBalance: number;
	oldBalanceDate: string | null;
	newBalance: number;
	newBalanceDate: string | null;
	transactionCount: number;
	transactions: PycondaTransaction[];
}

interface PycondaResult {
	statementCount: number;
	statements: PycondaStatement[];
	error?: string;
}

/**
 * Write a CODA string to a temp file and run the pycoda verify script on it.
 * Returns the parsed JSON output.
 */
function runPycoda(codaContent: string, label: string): PycondaResult {
	// Write to a deterministic temp path so failures are inspectable
	const dir = join(tmpdir(), "coda-roundtrip");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmpFile = join(dir, `${label}.coda`);

	// Write as Latin-1 (matching our serializer's default encoding)
	writeFileSync(tmpFile, Buffer.from(codaContent, "latin1"));

	const result = Bun.spawnSync(["python3", VERIFY_SCRIPT, tmpFile], {
		stdout: "pipe",
		stderr: "pipe",
	});

	const stdout = result.stdout.toString("utf-8").trim();
	const stderr = result.stderr.toString("utf-8").trim();

	if (result.exitCode !== 0) {
		throw new Error(
			`pycoda verify script exited with code ${result.exitCode}.\n` +
				`stdout: ${stdout}\nstderr: ${stderr}`,
		);
	}

	try {
		return JSON.parse(stdout) as PycondaResult;
	} catch {
		throw new Error(`pycoda output is not valid JSON:\n${stdout}`);
	}
}

// ---------------------------------------------------------------------------
// Fixture: Revolut Personal
// ---------------------------------------------------------------------------

const REV_CSV_PATH = join(import.meta.dir, "../parsers/__tests__/fixtures/revolut-personal.csv");

const REV_CONFIG: CodaConfig = {
	bankId: "535",
	accountIban: "BE68539007547034",
	accountCurrency: "EUR",
	accountHolderName: "Test User",
	bic: "REVOLT21",
	openingBalance: 2000.0,
	openingBalanceDate: new Date("2026-01-14"),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!PYTHON_AVAILABLE || !PYCODA_AVAILABLE)("pycoda round-trip", () => {
	//
	// Generate the CODA once and reuse across all it() blocks
	//
	const csv = readFileSync(REV_CSV_PATH, "utf-8");
	const transactions = parseTransactions(csv, "revolut-personal");
	const statement = mapToCoda(transactions, REV_CONFIG);
	const codaContent = serializeCoda(statement);

	let parsed: PycondaResult;

	// We need the parsed result before any assertion.  Bun:test does not have
	// beforeAll/afterAll with return values, so we call runPycoda lazily and
	// cache the result inside a helper that throws on first access.
	function getResult(): PycondaResult {
		if (!parsed) {
			parsed = runPycoda(codaContent, "revolut-personal");
		}
		return parsed;
	}

	it("pycoda parses exactly 1 statement", () => {
		const result = getResult();
		expect(result.error).toBeUndefined();
		expect(result.statementCount).toBe(1);
	});

	it("account number matches", () => {
		const stmt = getResult().statements[0];
		expect(stmt.accNumber).toBe("BE68539007547034");
	});

	it("currency matches", () => {
		const stmt = getResult().statements[0];
		expect(stmt.currency).toBe("EUR");
	});

	it("old balance matches", () => {
		const stmt = getResult().statements[0];
		// Opening balance is 2000.00 (credit)
		expect(stmt.oldBalance).toBeCloseTo(2000.0, 2);
	});

	it("new balance matches", () => {
		const stmt = getResult().statements[0];
		// credits: 2000 + 1500 = 3500
		// debits:  42.50 + 500 + 65.30 + 200 + 1.50 (fee) + 89.99 + 850 = 1749.29
		// new balance = 2000 + 3500 - 1749.29 = 3750.71
		expect(stmt.newBalance).toBeCloseTo(3750.71, 2);
	});

	it("transaction count matches (8 main + 1 fee record = 9 Record21 lines)", () => {
		const stmt = getResult().statements[0];
		// Revolut Personal fixture has 8 COMPLETED transactions, one of which
		// (EXCHANGE) carries a non-zero fee (-1.50).  mapToCoda emits a
		// separate Record 21 for the fee, so pycoda sees 9 movements total.
		expect(stmt.transactionCount).toBe(9);
	});

	it("individual transaction amounts match (signed)", () => {
		const stmt = getResult().statements[0];
		const amounts = stmt.transactions.map((t) => t.amount);

		// Expected amounts in emission order: main transactions first (PENDING
		// filtered), then fee record appended after EXCHANGE
		const expected = [-42.5, -500.0, 2000.0, -65.3, 1500.0, -200.0, -1.5, -89.99, -850.0];

		expect(amounts).toHaveLength(expected.length);
		for (let i = 0; i < expected.length; i++) {
			expect(amounts[i]).toBeCloseTo(expected[i], 2);
		}
	});

	it("transaction dates are present and in YYYY-MM-DD format", () => {
		const stmt = getResult().statements[0];
		const datePattern = /^\d{4}-\d{2}-\d{2}$/;
		for (const tx of stmt.transactions) {
			expect(tx.date).not.toBeNull();
			expect(datePattern.test(tx.date ?? "")).toBe(true);
		}
	});

	it("first transaction communication matches", () => {
		const stmt = getResult().statements[0];
		// Revolut Personal fixture first COMPLETED row: 'Delhaize'
		expect(stmt.transactions[0].communication).toContain("Delhaize");
	});
});

// ---------------------------------------------------------------------------
// Graceful skip message when dependencies are missing
// ---------------------------------------------------------------------------

describe("pycoda availability", () => {
	it("python3 is available (or tests are skipped)", () => {
		if (!PYTHON_AVAILABLE) {
			console.log("SKIP: python3 not found in PATH — pycoda round-trip tests skipped");
		}
		expect(true).toBe(true);
	});

	it("pycoda is installed (or tests are skipped)", () => {
		if (PYTHON_AVAILABLE && !PYCODA_AVAILABLE) {
			console.log(
				"SKIP: pycoda not importable — run `pip install pycoda` or `bash scripts/setup-roundtrip.sh`",
			);
		}
		expect(true).toBe(true);
	});
});
