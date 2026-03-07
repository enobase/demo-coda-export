/**
 * Comprehensive test suite for Phase 2 CSV parsers.
 * Covers: CSV utility, Revolut Personal, Revolut Business, Qonto, and the
 * auto-detection / registry layer.
 *
 * Run with: bun test
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectDelimiter, parseCsv, parseCsvLine } from "../csv.ts";
import { detectFormat, parseTransactions } from "../index.ts";
import { qontoParser } from "../qonto.ts";
import { revolutBusinessParser } from "../revolut-business.ts";
import { revolutPersonalParser } from "../revolut-personal.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES = join(import.meta.dir, "fixtures");

function fixture(name: string): string {
	return readFileSync(join(FIXTURES, name), "utf-8");
}

/**
 * Return arr[index] and assert it is defined (throws if out-of-bounds).
 * This avoids non-null assertions while keeping tests readable.
 */
function getAt<T>(arr: T[], index: number): T {
	const item = arr[index];
	if (item === undefined) {
		throw new Error(`Expected element at index ${index}, but array has length ${arr.length}`);
	}
	return item;
}

// ---------------------------------------------------------------------------
// CSV utility: detectDelimiter
// ---------------------------------------------------------------------------

describe("detectDelimiter", () => {
	test("detects comma delimiter", () => {
		expect(detectDelimiter("Type,Product,Amount,Currency")).toBe(",");
	});

	test("detects semicolon delimiter", () => {
		expect(detectDelimiter("Type;Product;Amount;Currency")).toBe(";");
	});

	test("prefers semicolon when it appears more", () => {
		expect(detectDelimiter("A;B;C,D")).toBe(";");
	});

	test("falls back to comma when equal occurrences", () => {
		expect(detectDelimiter("A,B;C")).toBe(",");
	});

	test("handles empty string (falls back to comma)", () => {
		expect(detectDelimiter("")).toBe(",");
	});

	test("ignores commas inside quoted fields when counting", () => {
		// 2 semicolons outside quotes, 1 comma inside a quoted field
		expect(detectDelimiter('"A,B";C;D')).toBe(";");
	});
});

// ---------------------------------------------------------------------------
// CSV utility: parseCsvLine
// ---------------------------------------------------------------------------

describe("parseCsvLine", () => {
	test("splits a simple comma-delimited line", () => {
		expect(parseCsvLine("a,b,c", ",")).toEqual(["a", "b", "c"]);
	});

	test("splits a simple semicolon-delimited line", () => {
		expect(parseCsvLine("a;b;c", ";")).toEqual(["a", "b", "c"]);
	});

	test("handles quoted field containing delimiter", () => {
		expect(parseCsvLine('"hello, world",b', ",")).toEqual(["hello, world", "b"]);
	});

	test("handles escaped double-quotes inside quoted field", () => {
		expect(parseCsvLine('"say ""hi""",b', ",")).toEqual(['say "hi"', "b"]);
	});

	test("handles empty fields", () => {
		expect(parseCsvLine("a,,c", ",")).toEqual(["a", "", "c"]);
	});

	test("handles leading/trailing empty fields", () => {
		expect(parseCsvLine(",b,", ",")).toEqual(["", "b", ""]);
	});

	test("trims whitespace from unquoted fields", () => {
		expect(parseCsvLine("  a  ,  b  ", ",")).toEqual(["a", "b"]);
	});

	test("preserves whitespace inside quoted fields", () => {
		expect(parseCsvLine('"  a  ",b', ",")).toEqual(["  a  ", "b"]);
	});

	test("handles a single field line", () => {
		expect(parseCsvLine("only", ",")).toEqual(["only"]);
	});

	test("handles all-empty fields", () => {
		expect(parseCsvLine(",,", ",")).toEqual(["", "", ""]);
	});
});

// ---------------------------------------------------------------------------
// CSV utility: parseCsv
// ---------------------------------------------------------------------------

describe("parseCsv", () => {
	test("parses a basic CSV into row objects", () => {
		const csv = "Name,Age\nAlice,30\nBob,25";
		const rows = parseCsv(csv);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual({ Name: "Alice", Age: "30" });
		expect(rows[1]).toEqual({ Name: "Bob", Age: "25" });
	});

	test("skips blank lines in the body", () => {
		const csv = "A,B\n1,2\n\n3,4\n";
		const rows = parseCsv(csv);
		expect(rows).toHaveLength(2);
	});

	test("throws on empty content", () => {
		expect(() => parseCsv("")).toThrow("CSV content is empty");
	});

	test("throws on content that is only whitespace", () => {
		expect(() => parseCsv("   \n  \n")).toThrow("CSV content is empty");
	});

	test("returns empty array for header-only CSV", () => {
		const rows = parseCsv("Name,Age\n");
		expect(rows).toHaveLength(0);
	});

	test("auto-detects semicolon delimiter", () => {
		const csv = "A;B\n1;2";
		const rows = parseCsv(csv);
		expect(rows[0]).toEqual({ A: "1", B: "2" });
	});

	test("delimiter override works", () => {
		const csv = "A,B\n1,2";
		const rows = parseCsv(csv, { delimiter: "," });
		expect(rows[0]).toEqual({ A: "1", B: "2" });
	});

	test("handles CRLF line endings", () => {
		const csv = "A,B\r\n1,2\r\n3,4";
		const rows = parseCsv(csv);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual({ A: "1", B: "2" });
	});

	test("handles quoted fields spanning the full value", () => {
		const csv = 'Name,Note\nAlice,"has, a comma"';
		const rows = parseCsv(csv);
		expect(rows[0]?.Note).toBe("has, a comma");
	});
});

// ---------------------------------------------------------------------------
// Revolut Personal parser
// ---------------------------------------------------------------------------

describe("Revolut Personal — fixture parsing", () => {
	const content = fixture("revolut-personal.csv");
	const txns = revolutPersonalParser.parse(content);

	test("filters out PENDING rows — returns 8 transactions", () => {
		expect(txns).toHaveLength(8);
	});

	test("all transactions have source = revolut-personal", () => {
		for (const tx of txns) {
			expect(tx.source).toBe("revolut-personal");
		}
	});

	test("first transaction: CARD_PAYMENT at Delhaize", () => {
		const tx = getAt(txns, 0);
		expect(tx.description).toBe("Delhaize");
		expect(tx.amount).toBe(-42.5);
		expect(tx.currency).toBe("EUR");
		expect(tx.rawType).toBe("CARD_PAYMENT");
		expect(tx.balance).toBe(1957.5);
		expect(tx.fee).toBeUndefined(); // 0.00 fee should not be set
	});

	test("first transaction date is 2026-01-15", () => {
		const tx = getAt(txns, 0);
		expect(tx.date.getUTCFullYear()).toBe(2026);
		expect(tx.date.getUTCMonth()).toBe(0); // January (0-indexed)
		expect(tx.date.getUTCDate()).toBe(15);
	});

	test("TRANSFER to Jan Peeters", () => {
		const tx = getAt(txns, 1);
		expect(tx.amount).toBe(-500.0);
		expect(tx.description).toBe("Transfer to Jan Peeters");
		expect(tx.balance).toBe(1457.5);
	});

	test("TOPUP is credit (positive amount)", () => {
		const tx = getAt(txns, 2);
		expect(tx.amount).toBe(2000.0);
		expect(tx.rawType).toBe("TOPUP");
	});

	test("EXCHANGE transaction has fee", () => {
		const tx = getAt(txns, 5);
		expect(tx.rawType).toBe("EXCHANGE");
		expect(tx.amount).toBe(-200.0);
		expect(tx.fee).toBe(-1.5);
	});

	test("Amazon.de transaction: correct amount and balance", () => {
		const tx = getAt(txns, 6);
		expect(tx.description).toBe("Amazon.de");
		expect(tx.amount).toBeCloseTo(-89.99);
		expect(tx.balance).toBeCloseTo(4602.21);
	});

	test("last imported transaction is Rent payment", () => {
		const tx = getAt(txns, 7);
		expect(tx.description).toBe("Rent payment");
		expect(tx.amount).toBe(-850.0);
	});
});

describe("Revolut Personal — semicolon delimiter fixture", () => {
	const content = fixture("revolut-personal-semicolon.csv");
	const txns = revolutPersonalParser.parse(content);

	test("parses semicolon-delimited file correctly — 3 transactions", () => {
		expect(txns).toHaveLength(3);
	});

	test("first transaction amount correct", () => {
		expect(txns[0]?.amount).toBe(-42.5);
	});

	test("second transaction description correct", () => {
		expect(txns[1]?.description).toBe("Transfer to Jan Peeters");
	});
});

describe("Revolut Personal — detect()", () => {
	test("detects comma header", () => {
		const header =
			"Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance";
		expect(revolutPersonalParser.detect(header)).toBe(true);
	});

	test("detects semicolon header", () => {
		const header =
			"Type;Product;Started Date;Completed Date;Description;Amount;Fee;Currency;State;Balance";
		expect(revolutPersonalParser.detect(header)).toBe(true);
	});

	test("does NOT detect business header", () => {
		const header =
			"Date started (UTC),Date completed (UTC),ID,Type,Description,Reference,Payer,Card number,Orig currency,Orig amount,Payment currency,Amount,Fee,Balance,Account,Beneficiary account number,Beneficiary sort code or routing number,Beneficiary IBAN,Beneficiary BIC";
		expect(revolutPersonalParser.detect(header)).toBe(false);
	});

	test("does NOT detect Qonto header", () => {
		const header =
			"Status,Settlement date (UTC),Operation date (UTC),Total amount (incl. VAT),Currency,Counterparty name";
		expect(revolutPersonalParser.detect(header)).toBe(false);
	});
});

describe("Revolut Personal — edge cases", () => {
	test("header-only CSV returns empty array", () => {
		const csv =
			"Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n";
		expect(revolutPersonalParser.parse(csv)).toHaveLength(0);
	});

	test("all PENDING rows return empty array", () => {
		const csv =
			"Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\nCARD_PAYMENT,Current,2026-01-01,2026-01-01,Test,-10.00,0.00,EUR,PENDING,100.00\n";
		expect(revolutPersonalParser.parse(csv)).toHaveLength(0);
	});

	test("human-readable date format parses correctly", () => {
		const csv =
			"Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\nTRANSFER,Current,15 Jan 2026,15 Jan 2026,Test,100.00,0.00,EUR,COMPLETED,200.00\n";
		const txns = revolutPersonalParser.parse(csv);
		expect(txns).toHaveLength(1);
		expect(txns[0]?.date.getUTCDate()).toBe(15);
		expect(txns[0]?.date.getUTCMonth()).toBe(0);
		expect(txns[0]?.date.getUTCFullYear()).toBe(2026);
	});

	test("zero balance is stored as balance", () => {
		const csv =
			"Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\nTRANSFER,Current,2026-01-01,2026-01-01,Last txn,-100.00,0.00,EUR,COMPLETED,0.00\n";
		const txns = revolutPersonalParser.parse(csv);
		expect(txns[0]?.balance).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Revolut Business parser
// ---------------------------------------------------------------------------

describe("Revolut Business — fixture parsing", () => {
	const content = fixture("revolut-business.csv");
	const txns = revolutBusinessParser.parse(content);

	test("returns 6 transactions", () => {
		expect(txns).toHaveLength(6);
	});

	test("all transactions have source = revolut-business", () => {
		for (const tx of txns) {
			expect(tx.source).toBe("revolut-business");
		}
	});

	test("first transaction: invoice payment with IBAN and BIC", () => {
		const tx = getAt(txns, 0);
		expect(tx.amount).toBe(-1200.0);
		expect(tx.currency).toBe("EUR");
		expect(tx.counterpartyIban).toBe("BE68539007547034");
		expect(tx.counterpartyBic).toBe("BBRUBEBB");
		expect(tx.reference).toBe("INV-2026-001");
		expect(tx.balance).toBe(8800.0);
	});

	test("first transaction date is 2026-02-01", () => {
		const tx = getAt(txns, 0);
		expect(tx.date.getUTCFullYear()).toBe(2026);
		expect(tx.date.getUTCMonth()).toBe(1); // February
		expect(tx.date.getUTCDate()).toBe(1);
	});

	test("second transaction: card payment with no IBAN", () => {
		const tx = getAt(txns, 1);
		expect(tx.rawType).toBe("card_payment");
		expect(tx.counterpartyIban).toBeUndefined();
		expect(tx.counterpartyBic).toBeUndefined();
		expect(tx.reference).toBeUndefined();
	});

	test("third transaction: structured reference (OGM)", () => {
		const tx = getAt(txns, 2);
		expect(tx.reference).toBe("+++090/9337/55493+++");
		expect(tx.amount).toBe(3500.0);
		expect(tx.counterpartyIban).toBe("BE71096123456769");
	});

	test("fourth transaction: salary with IBAN and BIC", () => {
		const tx = getAt(txns, 3);
		expect(tx.reference).toBe("SAL-2026-02");
		expect(tx.counterpartyIban).toBe("BE43068999999501");
		expect(tx.counterpartyBic).toBe("GKCCBEBB");
	});

	test("fifth transaction: fee with no counterparty", () => {
		const tx = getAt(txns, 4);
		expect(tx.rawType).toBe("fee");
		expect(tx.amount).toBe(-15.0);
		expect(tx.counterpartyIban).toBeUndefined();
	});

	test("sixth transaction: currency exchange", () => {
		const tx = getAt(txns, 5);
		expect(tx.rawType).toBe("exchange");
		expect(tx.amount).toBe(920.5);
		expect(tx.currency).toBe("EUR");
	});

	test("IBAN is normalised (spaces removed, uppercase)", () => {
		const tx = getAt(txns, 0);
		// Source had " BE68 5390 0754 7034" — should be cleaned
		expect(tx.counterpartyIban).not.toContain(" ");
		expect(tx.counterpartyIban).toBe(tx.counterpartyIban?.toUpperCase());
	});
});

describe("Revolut Business — detect()", () => {
	test("detects business header", () => {
		const header =
			"Date started (UTC),Date completed (UTC),ID,Type,Description,Reference,Payer,Card number,Orig currency,Orig amount,Payment currency,Amount,Fee,Balance,Account,Beneficiary account number,Beneficiary sort code or routing number,Beneficiary IBAN,Beneficiary BIC";
		expect(revolutBusinessParser.detect(header)).toBe(true);
	});

	test("does NOT detect personal header", () => {
		const header =
			"Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance";
		expect(revolutBusinessParser.detect(header)).toBe(false);
	});

	test("does NOT detect Qonto header", () => {
		const header =
			"Status,Settlement date (UTC),Total amount (incl. VAT),Currency,Counterparty name";
		expect(revolutBusinessParser.detect(header)).toBe(false);
	});
});

describe("Revolut Business — edge cases", () => {
	test("row with empty completed date is skipped", () => {
		const csv =
			"Date started (UTC),Date completed (UTC),ID,Type,Description,Reference,Payer,Card number,Orig currency,Orig amount,Payment currency,Amount,Fee,Balance,Account,Beneficiary account number,Beneficiary sort code or routing number,Beneficiary IBAN,Beneficiary BIC\n" +
			"2026-02-01 09:00:00,,txn_p,transfer,Pending,,ACME,,EUR,-100.00,EUR,-100.00,0.00,900.00,Main,,,,\n";
		const txns = revolutBusinessParser.parse(csv);
		expect(txns).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Qonto parser
// ---------------------------------------------------------------------------

describe("Qonto — fixture parsing", () => {
	const content = fixture("qonto.csv");
	const txns = qontoParser.parse(content);

	test("returns 5 settled transactions (1 pending filtered out)", () => {
		expect(txns).toHaveLength(5);
	});

	test("all transactions have source = qonto", () => {
		for (const tx of txns) {
			expect(tx.source).toBe("qonto");
		}
	});

	test("first transaction: Proximus direct debit", () => {
		const tx = getAt(txns, 0);
		expect(tx.counterpartyName).toBe("Proximus");
		expect(tx.amount).toBe(-150.0);
		expect(tx.currency).toBe("EUR");
		expect(tx.counterpartyIban).toBe("BE95001234567890");
		expect(tx.reference).toBe("+++123/4567/89002+++");
		expect(tx.category).toBe("Telecom");
		expect(tx.rawType).toBe("direct_debit");
	});

	test("first transaction date is 2026-01-10", () => {
		const tx = getAt(txns, 0);
		expect(tx.date.getUTCFullYear()).toBe(2026);
		expect(tx.date.getUTCMonth()).toBe(0);
		expect(tx.date.getUTCDate()).toBe(10);
	});

	test("second transaction: credit from client", () => {
		const tx = getAt(txns, 1);
		expect(tx.amount).toBe(5000.0);
		expect(tx.counterpartyName).toBe("Client Alpha BVBA");
		expect(tx.reference).toBe("INV-2026-042");
		expect(tx.category).toBe("Revenue");
	});

	test("third transaction: hosting, no IBAN, no reference", () => {
		const tx = getAt(txns, 2);
		expect(tx.counterpartyName).toBe("Hosting Provider");
		expect(tx.counterpartyIban).toBeUndefined();
		expect(tx.reference).toBeUndefined();
		expect(tx.category).toBe("Services");
	});

	test("fourth transaction: Office Depot card payment with reference", () => {
		const tx = getAt(txns, 3);
		expect(tx.amount).toBeCloseTo(-45.99);
		expect(tx.reference).toBe("ORD-88721");
	});

	test("sixth (last) transaction: Accountant BVBA with structured reference", () => {
		const tx = getAt(txns, 4);
		expect(tx.counterpartyName).toBe("Accountant BVBA");
		expect(tx.reference).toBe("+++456/7890/12345+++");
		expect(tx.amount).toBe(-890.0);
	});

	test("IBAN is normalised (spaces removed, uppercase)", () => {
		const tx = getAt(txns, 0);
		expect(tx.counterpartyIban).not.toContain(" ");
	});

	test("description falls back to counterparty name", () => {
		const tx = getAt(txns, 0);
		expect(tx.description).toBe("Proximus");
	});
});

describe("Qonto — detect()", () => {
	test("detects Qonto header", () => {
		const header =
			"Status,Settlement date (UTC),Operation date (UTC),Total amount (incl. VAT),Currency,Counterparty name,Payment method,Transaction ID,IBAN,Reference,Category,Note,VAT amount,Initiator";
		expect(qontoParser.detect(header)).toBe(true);
	});

	test("does NOT detect Revolut Personal header", () => {
		const header =
			"Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance";
		expect(qontoParser.detect(header)).toBe(false);
	});

	test("does NOT detect Revolut Business header", () => {
		const header = "Date started (UTC),Date completed (UTC),ID,Beneficiary IBAN,Beneficiary BIC";
		expect(qontoParser.detect(header)).toBe(false);
	});
});

describe("Qonto — edge cases", () => {
	test("header-only CSV returns empty array", () => {
		const csv =
			"Status,Settlement date (UTC),Operation date (UTC),Total amount (incl. VAT),Currency,Counterparty name,Payment method,Transaction ID,IBAN,Reference,Category,Note,VAT amount,Initiator\n";
		expect(qontoParser.parse(csv)).toHaveLength(0);
	});

	test("'executed' status is also accepted", () => {
		const csv =
			"Status,Settlement date (UTC),Operation date (UTC),Total amount (incl. VAT),Currency,Counterparty name,Payment method,Transaction ID,IBAN,Reference,Category,Note,VAT amount,Initiator\n" +
			"executed,2026-01-01 00:00:00,2026-01-01 00:00:00,-100.00,EUR,Test,transfer,qt_x,,,,,,Admin\n";
		const txns = qontoParser.parse(csv);
		expect(txns).toHaveLength(1);
	});

	test("all pending rows return empty array", () => {
		const csv =
			"Status,Settlement date (UTC),Operation date (UTC),Total amount (incl. VAT),Currency,Counterparty name,Payment method,Transaction ID,IBAN,Reference,Category,Note,VAT amount,Initiator\n" +
			"pending,2026-01-01 00:00:00,,-100.00,EUR,Vendor,transfer,qt_p,,,,,, Admin\n";
		expect(qontoParser.parse(csv)).toHaveLength(0);
	});

	test("semicolon-delimited Qonto CSV parses correctly", () => {
		const csv =
			"Status;Settlement date (UTC);Operation date (UTC);Total amount (incl. VAT);Currency;Counterparty name;Payment method;Transaction ID;IBAN;Reference;Category;Note;VAT amount;Initiator\n" +
			"settled;2026-02-01 00:00:00;2026-02-01 00:00:00;-50.00;EUR;Test Corp;card;qt_s1;;REF-001;;;\n";
		const txns = qontoParser.parse(csv);
		expect(txns).toHaveLength(1);
		expect(txns[0]?.amount).toBe(-50.0);
		expect(txns[0]?.reference).toBe("REF-001");
	});
});

// ---------------------------------------------------------------------------
// Auto-detection and registry (index.ts)
// ---------------------------------------------------------------------------

describe("detectFormat", () => {
	test("detects revolut-personal from fixture", () => {
		expect(detectFormat(fixture("revolut-personal.csv"))).toBe("revolut-personal");
	});

	test("detects revolut-business from fixture", () => {
		expect(detectFormat(fixture("revolut-business.csv"))).toBe("revolut-business");
	});

	test("detects qonto from fixture", () => {
		expect(detectFormat(fixture("qonto.csv"))).toBe("qonto");
	});

	test("detects revolut-personal from semicolon fixture", () => {
		expect(detectFormat(fixture("revolut-personal-semicolon.csv"))).toBe("revolut-personal");
	});

	test("returns null for unknown format", () => {
		expect(detectFormat("foo,bar,baz\n1,2,3\n")).toBeNull();
	});

	test("returns null for empty content", () => {
		expect(detectFormat("")).toBeNull();
	});

	test("returns null for whitespace-only content", () => {
		expect(detectFormat("   \n   \n")).toBeNull();
	});
});

describe("parseTransactions — auto-detect", () => {
	test("auto-detects and parses revolut-personal fixture", () => {
		const txns = parseTransactions(fixture("revolut-personal.csv"));
		expect(txns).toHaveLength(8);
		expect(txns[0]?.source).toBe("revolut-personal");
	});

	test("auto-detects and parses revolut-business fixture", () => {
		const txns = parseTransactions(fixture("revolut-business.csv"));
		expect(txns).toHaveLength(6);
		expect(txns[0]?.source).toBe("revolut-business");
	});

	test("auto-detects and parses qonto fixture", () => {
		const txns = parseTransactions(fixture("qonto.csv"));
		expect(txns).toHaveLength(5);
		expect(txns[0]?.source).toBe("qonto");
	});

	test("throws on unrecognised format when no explicit format given", () => {
		expect(() => parseTransactions("garbage,header\n1,2\n")).toThrow("Unable to detect CSV format");
	});
});

describe("parseTransactions — explicit format", () => {
	test("explicit revolut-personal bypasses detection", () => {
		const txns = parseTransactions(fixture("revolut-personal.csv"), "revolut-personal");
		expect(txns).toHaveLength(8);
	});

	test("explicit revolut-business bypasses detection", () => {
		const txns = parseTransactions(fixture("revolut-business.csv"), "revolut-business");
		expect(txns).toHaveLength(6);
	});

	test("explicit qonto bypasses detection", () => {
		const txns = parseTransactions(fixture("qonto.csv"), "qonto");
		expect(txns).toHaveLength(5);
	});
});

// ---------------------------------------------------------------------------
// Cross-format field type guarantees
// ---------------------------------------------------------------------------

describe("BankTransaction field types", () => {
	test("all dates are valid Date objects", () => {
		const all = [
			...parseTransactions(fixture("revolut-personal.csv")),
			...parseTransactions(fixture("revolut-business.csv")),
			...parseTransactions(fixture("qonto.csv")),
		];
		for (const tx of all) {
			expect(tx.date).toBeInstanceOf(Date);
			expect(Number.isNaN(tx.date.getTime())).toBe(false);
		}
	});

	test("all amounts are finite numbers", () => {
		const all = [
			...parseTransactions(fixture("revolut-personal.csv")),
			...parseTransactions(fixture("revolut-business.csv")),
			...parseTransactions(fixture("qonto.csv")),
		];
		for (const tx of all) {
			expect(typeof tx.amount).toBe("number");
			expect(Number.isFinite(tx.amount)).toBe(true);
		}
	});

	test("all currency codes are non-empty strings", () => {
		const all = [
			...parseTransactions(fixture("revolut-personal.csv")),
			...parseTransactions(fixture("revolut-business.csv")),
			...parseTransactions(fixture("qonto.csv")),
		];
		for (const tx of all) {
			expect(typeof tx.currency).toBe("string");
			expect(tx.currency.length).toBeGreaterThan(0);
		}
	});
});
