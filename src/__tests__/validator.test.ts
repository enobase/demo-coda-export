/**
 * Phase 4: validator.ts — unit tests
 *
 * Tests the validate() function with at least 15 test cases covering:
 *   - Valid CODA file passes
 *   - Line length != 128 detected
 *   - Missing header detected
 *   - Missing trailer detected
 *   - Wrong record count detected
 *   - Wrong totals detected
 *   - Bad continuation chain detected
 *   - Version code warning
 *   - Sign code validation
 *   - Empty file
 *   - Structure checks
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodaConfig } from "../mapper.ts";
import { mapToCoda } from "../mapper.ts";
import type { BankTransaction } from "../parsers/index.ts";
import { serializeCoda } from "../serializer.ts";
import { validate } from "../validator.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES = join(import.meta.dir, "fixtures");

/** Build a minimal but structurally valid CODA content with 1 Record 21 */
function buildValidCoda(): string {
	const config: CodaConfig = {
		bankId: "539",
		accountIban: "BE68539007547034",
		accountCurrency: "EUR",
		accountHolderName: "Test User",
		openingBalance: 1000.0,
		openingBalanceDate: new Date("2026-01-01"),
	};
	const transactions: BankTransaction[] = [
		{
			date: new Date("2026-01-15"),
			amount: -100.0,
			currency: "EUR",
			description: "Test payment",
			source: "revolut-personal",
		},
	];
	const statement = mapToCoda(transactions, config);
	return serializeCoda(statement);
}

function mutateLines(coda: string, mutator: (lines: string[]) => string[]): string {
	const lines = coda.trimEnd().split("\n");
	return `${mutator(lines).join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validate()", () => {
	// -----------------------------------------------------------------------
	// 1. Valid CODA file passes
	// -----------------------------------------------------------------------
	it("valid CODA file from golden fixture passes validation", () => {
		const content = readFileSync(join(FIXTURES, "revolut-personal.coda"), "utf-8");
		const result = validate(content);
		expect(result.valid).toBe(true);
		expect(result.errors.filter((e) => e.severity === "error")).toHaveLength(0);
	});

	it("valid CODA file from qonto golden fixture passes validation", () => {
		const content = readFileSync(join(FIXTURES, "qonto.coda"), "utf-8");
		const result = validate(content);
		expect(result.valid).toBe(true);
	});

	it("freshly generated CODA passes validation", () => {
		const coda = buildValidCoda();
		const result = validate(coda);
		expect(result.valid).toBe(true);
		expect(result.errors.filter((e) => e.severity === "error")).toHaveLength(0);
	});

	// -----------------------------------------------------------------------
	// 2. Line length != 128
	// -----------------------------------------------------------------------
	it("detects line that is too short", () => {
		const coda = mutateLines(buildValidCoda(), (lines) => {
			lines[2] = lines[2]!.slice(0, 100); // truncate a body line
			return lines;
		});
		const result = validate(coda);
		expect(result.valid).toBe(false);
		const lengthError = result.errors.find((e) => e.message.includes("Line length"));
		expect(lengthError).toBeDefined();
		expect(lengthError?.line).toBe(3);
	});

	it("detects line that is too long", () => {
		const coda = mutateLines(buildValidCoda(), (lines) => {
			lines[1] += "EXTRA"; // make a line too long
			return lines;
		});
		const result = validate(coda);
		expect(result.valid).toBe(false);
		const lengthError = result.errors.find((e) => e.message.includes("Line length"));
		expect(lengthError).toBeDefined();
	});

	// -----------------------------------------------------------------------
	// 3. Missing / wrong header record
	// -----------------------------------------------------------------------
	it("detects missing header (first line does not start with 0)", () => {
		const coda = mutateLines(buildValidCoda(), (lines) => {
			lines[0] = `X${lines[0]!.slice(1)}`;
			return lines;
		});
		const result = validate(coda);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes('First line must start with "0"'))).toBe(
			true,
		);
	});

	// -----------------------------------------------------------------------
	// 4. Missing / wrong trailer record
	// -----------------------------------------------------------------------
	it("detects missing trailer (last line does not start with 9)", () => {
		const coda = mutateLines(buildValidCoda(), (lines) => {
			const last = lines[lines.length - 1]!;
			lines[lines.length - 1] = `X${last.slice(1)}`;
			return lines;
		});
		const result = validate(coda);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes('Last line must start with "9"'))).toBe(
			true,
		);
	});

	// -----------------------------------------------------------------------
	// 5. Wrong record count
	// -----------------------------------------------------------------------
	it("detects wrong record count in trailer", () => {
		const coda = mutateLines(buildValidCoda(), (lines) => {
			// Patch the count field in the trailer (positions 16-22)
			const trailer = lines[lines.length - 1]!;
			const wrong = `${trailer.slice(0, 16)}999999${trailer.slice(22)}`;
			lines[lines.length - 1] = wrong;
			return lines;
		});
		const result = validate(coda);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("record count"))).toBe(true);
	});

	// -----------------------------------------------------------------------
	// 6. Wrong debit total
	// -----------------------------------------------------------------------
	it("detects wrong debit total in trailer", () => {
		const coda = mutateLines(buildValidCoda(), (lines) => {
			const trailer = lines[lines.length - 1]!;
			// Patch debit total (positions 22-37) to an incorrect value
			const wrong = `${trailer.slice(0, 22)}000000000000999${trailer.slice(37)}`;
			lines[lines.length - 1] = wrong;
			return lines;
		});
		const result = validate(coda);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("debit total"))).toBe(true);
	});

	// -----------------------------------------------------------------------
	// 7. Wrong credit total
	// -----------------------------------------------------------------------
	it("detects wrong credit total in trailer", () => {
		const coda = mutateLines(buildValidCoda(), (lines) => {
			const trailer = lines[lines.length - 1]!;
			// Patch credit total (positions 37-52)
			const wrong = `${trailer.slice(0, 37)}000000000000999${trailer.slice(52)}`;
			lines[lines.length - 1] = wrong;
			return lines;
		});
		const result = validate(coda);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("credit total"))).toBe(true);
	});

	// -----------------------------------------------------------------------
	// 8. Bad continuation chain: 21 with flag 1 not followed by 22
	// -----------------------------------------------------------------------
	it("detects Record 21 continuation flag pointing to wrong record type", () => {
		const coda = mutateLines(buildValidCoda(), (lines) => {
			// Find the Record 21 line and set its continuation flag to "1"
			for (let i = 0; i < lines.length; i++) {
				if (lines[i]!.startsWith("21") && lines[i]!.length === 128) {
					// Set continuation flag at position 127 to "1"
					lines[i] = `${lines[i]!.slice(0, 127)}1`;
					// Insert a non-22 line after it (insert a duplicate Record 21)
					lines.splice(i + 1, 0, lines[i]!);
					// Update the trailer count: +1
					const trailer = lines[lines.length - 1]!;
					const oldCount = Number(trailer.slice(16, 22));
					const newCount = String(oldCount + 1).padStart(6, "0");
					lines[lines.length - 1] = `${trailer.slice(0, 16)}${newCount}${trailer.slice(22)}`;
					break;
				}
			}
			return lines;
		});
		const result = validate(coda);
		// Should have a continuation error
		expect(result.errors.some((e) => e.message.includes("continuation flag"))).toBe(true);
	});

	// -----------------------------------------------------------------------
	// 9. Version code warning
	// -----------------------------------------------------------------------
	it("warns when Record 0 version code is not 2", () => {
		const coda = mutateLines(buildValidCoda(), (lines) => {
			const header = lines[0]!;
			lines[0] = `${header.slice(0, 127)}1`; // change version code to "1"
			return lines;
		});
		const result = validate(coda);
		const versionWarn = result.errors.find(
			(e) => e.severity === "warning" && e.message.includes("version code"),
		);
		expect(versionWarn).toBeDefined();
		// Version code warning doesn't make the file invalid
		// (only errors affect validity)
	});

	// -----------------------------------------------------------------------
	// 10. Sign code validation
	// -----------------------------------------------------------------------
	it("detects invalid sign code in Record 21", () => {
		const coda = mutateLines(buildValidCoda(), (lines) => {
			for (let i = 0; i < lines.length; i++) {
				if (lines[i]!.startsWith("21") && lines[i]!.length === 128) {
					// Replace sign at position 31 with an invalid character
					lines[i] = `${lines[i]!.slice(0, 31)}X${lines[i]!.slice(32)}`;
					break;
				}
			}
			return lines;
		});
		const result = validate(coda);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("sign code"))).toBe(true);
	});

	// -----------------------------------------------------------------------
	// 11. Second line must be Record 1
	// -----------------------------------------------------------------------
	it("detects missing old balance record (second line not 1)", () => {
		const coda = mutateLines(buildValidCoda(), (lines) => {
			lines[1] = `X${lines[1]!.slice(1)}`;
			return lines;
		});
		const result = validate(coda);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes('Second line must start with "1"'))).toBe(
			true,
		);
	});

	// -----------------------------------------------------------------------
	// 12. Second-to-last line must be Record 8
	// -----------------------------------------------------------------------
	it("detects missing new balance record (second-to-last line not 8)", () => {
		const coda = mutateLines(buildValidCoda(), (lines) => {
			const idx = lines.length - 2;
			lines[idx] = `X${lines[idx]!.slice(1)}`;
			return lines;
		});
		const result = validate(coda);
		expect(result.valid).toBe(false);
		expect(
			result.errors.some((e) => e.message.includes('Second-to-last line must start with "8"')),
		).toBe(true);
	});

	// -----------------------------------------------------------------------
	// 13. Empty file
	// -----------------------------------------------------------------------
	it("reports error for empty file", () => {
		const result = validate("");
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("empty"))).toBe(true);
	});

	// -----------------------------------------------------------------------
	// 14. Multiple errors are all reported
	// -----------------------------------------------------------------------
	it("reports multiple errors in a single pass", () => {
		const coda = mutateLines(buildValidCoda(), (lines) => {
			// Wrong header + wrong trailer
			lines[0] = `X${lines[0]!.slice(1)}`;
			const last = lines[lines.length - 1]!;
			lines[lines.length - 1] = `X${last.slice(1)}`;
			return lines;
		});
		const result = validate(coda);
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThanOrEqual(2);
	});

	// -----------------------------------------------------------------------
	// 15. ValidationResult structure
	// -----------------------------------------------------------------------
	it("result has valid, errors fields", () => {
		const coda = buildValidCoda();
		const result = validate(coda);
		expect(typeof result.valid).toBe("boolean");
		expect(Array.isArray(result.errors)).toBe(true);
	});

	it("each error has line, message, severity", () => {
		const coda = mutateLines(buildValidCoda(), (lines) => {
			lines[0] = `X${lines[0]!.slice(1)}`;
			return lines;
		});
		const result = validate(coda);
		for (const e of result.errors) {
			expect(typeof e.line).toBe("number");
			expect(e.line).toBeGreaterThan(0);
			expect(typeof e.message).toBe("string");
			expect(e.severity === "error" || e.severity === "warning").toBe(true);
		}
	});

	// -----------------------------------------------------------------------
	// 16. CODA with only minimal records (no movements) is valid
	// -----------------------------------------------------------------------
	it("CODA with no movement records is valid", () => {
		const config: CodaConfig = {
			bankId: "539",
			accountIban: "BE68539007547034",
			accountCurrency: "EUR",
			accountHolderName: "Test User",
			openingBalance: 500.0,
			openingBalanceDate: new Date("2026-01-01"),
		};
		const statement = mapToCoda([], config);
		const coda = serializeCoda(statement);
		const result = validate(coda);
		expect(result.valid).toBe(true);
	});

	// -----------------------------------------------------------------------
	// 17. Line number reported correctly
	// -----------------------------------------------------------------------
	it("reports correct 1-based line number for the error", () => {
		const coda = mutateLines(buildValidCoda(), (lines) => {
			// Corrupt line 3 (index 2)
			if (lines.length > 2) {
				lines[2] = lines[2]!.slice(0, 50);
			}
			return lines;
		});
		const result = validate(coda);
		const lengthError = result.errors.find((e) => e.message.includes("Line length"));
		expect(lengthError?.line).toBe(3);
	});
});
