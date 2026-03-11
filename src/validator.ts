/**
 * CODA 2.6 Validator
 *
 * Validates a serialized CODA file (multi-line string) against the format
 * rules defined by Febelfin.
 *
 * All checks are non-destructive: the function collects every issue found
 * and returns them in a single ValidationResult rather than throwing on the
 * first error.
 */

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface ValidationError {
	/** 1-based line number where the issue was found */
	line: number;
	message: string;
	severity: "error" | "warning";
}

export interface ValidationResult {
	valid: boolean;
	errors: ValidationError[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Expected line length for all CODA records */
const CODA_LINE_LENGTH = 128;

function err(line: number, message: string): ValidationError {
	return { line, severity: "error", message };
}

function warn(line: number, message: string): ValidationError {
	return { line, severity: "warning", message };
}

/**
 * Parse a 15-digit CODA amount string to a bigint.
 * Returns null if the string is not exactly 15 digits.
 */
function parseAmount(s: string): bigint | null {
	if (!/^\d{15}$/.test(s)) return null;
	return BigInt(s);
}

// ---------------------------------------------------------------------------
// validate()
// ---------------------------------------------------------------------------

/**
 * Validate a CODA file content string.
 *
 * Checks performed:
 *  1.  Every line is exactly 128 characters
 *  2.  First line starts with "0" (header)
 *  3.  Last line starts with "9" (trailer)
 *  4.  Second line starts with "1" (old balance)
 *  5.  Second-to-last line starts with "8" (new balance)
 *  6.  Record sequence is valid: 0 → 1 → (2x/3x/4)* → 8 → 9
 *  7.  Record 9 record count matches actual count (excluding records 0 and 9)
 *  8.  Record 9 debit total matches sum of all debit amounts in Record 21 lines
 *  9.  Record 9 credit total matches sum of all credit amounts in Record 21 lines
 * 10.  Movement record continuity: 21 with continuation must be followed by 22,
 *      22 with continuation must be followed by 23
 * 11.  Version code at position 127 of Record 0 should be "2"
 * 12.  Sign codes in Record 21 should be "0" or "1"
 */
export function validate(content: string): ValidationResult {
	const errors: ValidationError[] = [];

	// Split on LF or CRLF, strip trailing empty line produced by the serializer
	const rawLines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const lines = rawLines[rawLines.length - 1] === "" ? rawLines.slice(0, -1) : rawLines;

	if (lines.length === 0) {
		errors.push(err(1, "File is empty"));
		return { valid: false, errors };
	}

	// -----------------------------------------------------------------------
	// Check 1: every line is exactly 128 characters
	// -----------------------------------------------------------------------
	for (let i = 0; i < lines.length; i++) {
		const lineNo = i + 1;
		const line = lines[i]!;
		if (line.length !== CODA_LINE_LENGTH) {
			errors.push(err(lineNo, `Line length is ${line.length}, expected ${CODA_LINE_LENGTH}`));
		}
	}

	// -----------------------------------------------------------------------
	// Check 2: first line starts with "0"
	// -----------------------------------------------------------------------
	if (!lines[0]!.startsWith("0")) {
		errors.push(err(1, `First line must start with "0" (header record), got "${lines[0]![0]}"`));
	}

	// -----------------------------------------------------------------------
	// Check 3: last line starts with "9"
	// -----------------------------------------------------------------------
	const lastLine = lines[lines.length - 1]!;
	const lastLineNo = lines.length;
	if (!lastLine.startsWith("9")) {
		errors.push(
			err(lastLineNo, `Last line must start with "9" (trailer record), got "${lastLine[0]}"`),
		);
	}

	// If fewer than 4 lines we cannot check the structure further meaningfully
	if (lines.length < 2) {
		return { valid: errors.length === 0, errors };
	}

	// -----------------------------------------------------------------------
	// Check 4: second line starts with "1"
	// -----------------------------------------------------------------------
	if (!lines[1]!.startsWith("1")) {
		errors.push(
			err(2, `Second line must start with "1" (old balance record), got "${lines[1]![0]}"`),
		);
	}

	// -----------------------------------------------------------------------
	// Check 5: second-to-last line starts with "8"
	// -----------------------------------------------------------------------
	if (lines.length >= 3) {
		const secondToLast = lines[lines.length - 2]!;
		const secondToLastLineNo = lines.length - 1;
		if (!secondToLast.startsWith("8")) {
			errors.push(
				err(
					secondToLastLineNo,
					`Second-to-last line must start with "8" (new balance record), got "${secondToLast[0]}"`,
				),
			);
		}
	}

	// -----------------------------------------------------------------------
	// Check 6: valid record sequence 0 → 1 → (2x/3x/4)* → 8 → 9
	// -----------------------------------------------------------------------
	//
	// Valid record type tokens in the body (between record 1 and record 8):
	//   21, 22, 23, 31, 32, 33, 4
	//
	// We build the sequence of record type tokens and check it.
	const BODY_TYPES = new Set(["21", "22", "23", "31", "32", "33", "4"]);

	for (let i = 0; i < lines.length; i++) {
		const lineNo = i + 1;
		const line = lines[i]!;
		if (line.length < 2) continue; // already flagged by check 1

		const token2 = line.slice(0, 2); // first 2 chars
		const token1 = line[0]!; // first char

		// We only validate the "body" lines (everything except 0, 1, 8, 9)
		if (i === 0) {
			// must be "0" — already checked
			continue;
		}
		if (i === 1) {
			// must be "1" — already checked
			continue;
		}
		if (i === lines.length - 1) {
			// must be "9" — already checked
			continue;
		}
		if (i === lines.length - 2) {
			// must be "8" — already checked
			continue;
		}

		// Inner body line: must be one of the valid body record types
		if (!BODY_TYPES.has(token2) && !BODY_TYPES.has(token1)) {
			errors.push(err(lineNo, `Unexpected record type "${token2}" in statement body`));
		}
	}

	// -----------------------------------------------------------------------
	// Checks 7, 8, 9: trailer record counts and totals
	// -----------------------------------------------------------------------
	const trailerLine = lines[lines.length - 1]!;
	if (trailerLine.length === CODA_LINE_LENGTH) {
		// Record count: positions [16:22] (6 digits)
		const countStr = trailerLine.slice(16, 22);
		const claimedCount = Number(countStr);

		// Actual count: all lines excluding record 0 and record 9
		const actualCount = lines.length - 2;

		if (!Number.isNaN(claimedCount) && claimedCount !== actualCount) {
			errors.push(
				err(
					lastLineNo,
					`Record 9 record count is ${claimedCount}, but actual count (excluding records 0 and 9) is ${actualCount}`,
				),
			);
		}

		// Debit total: positions [22:37]
		const claimedDebitStr = trailerLine.slice(22, 37);
		const claimedDebit = parseAmount(claimedDebitStr);

		// Credit total: positions [37:52]
		const claimedCreditStr = trailerLine.slice(37, 52);
		const claimedCredit = parseAmount(claimedCreditStr);

		// Sum amounts from Record 21 lines
		let totalDebit = 0n;
		let totalCredit = 0n;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			if (line.length !== CODA_LINE_LENGTH) continue;
			if (!line.startsWith("21")) continue;

			// sign at position [31], amount at [32:47]
			const signChar = line[31]!;
			const amountStr = line.slice(32, 47);
			const amount = parseAmount(amountStr);
			if (amount === null) continue;

			if (signChar === "1") {
				totalDebit += amount;
			} else if (signChar === "0") {
				totalCredit += amount;
			}
		}

		if (claimedDebit !== null && claimedDebit !== totalDebit) {
			errors.push(
				err(
					lastLineNo,
					`Record 9 debit total is ${claimedDebit}, but sum of Record 21 debits is ${totalDebit}`,
				),
			);
		}

		if (claimedCredit !== null && claimedCredit !== totalCredit) {
			errors.push(
				err(
					lastLineNo,
					`Record 9 credit total is ${claimedCredit}, but sum of Record 21 credits is ${totalCredit}`,
				),
			);
		}
	}

	// -----------------------------------------------------------------------
	// Check 10: movement record continuation chains
	//   21 with hasContinuation=1 must be followed by 22
	//   22 with hasContinuation=1 must be followed by 23
	// -----------------------------------------------------------------------
	for (let i = 0; i < lines.length - 1; i++) {
		const line = lines[i]!;
		if (line.length !== CODA_LINE_LENGTH) continue;

		const lineNo = i + 1;
		const nextLine = lines[i + 1]!;

		if (line.startsWith("21")) {
			const continuationFlag = line[127]!;
			if (continuationFlag === "1") {
				if (!nextLine.startsWith("22")) {
					errors.push(
						err(
							lineNo,
							`Record 21 at line ${lineNo} has continuation flag "1" but is not followed by Record 22 (got "${nextLine.slice(0, 2)}")`,
						),
					);
				}
			}
		} else if (line.startsWith("22")) {
			const continuationFlag = line[127]!;
			if (continuationFlag === "1") {
				if (!nextLine.startsWith("23")) {
					errors.push(
						err(
							lineNo,
							`Record 22 at line ${lineNo} has continuation flag "1" but is not followed by Record 23 (got "${nextLine.slice(0, 2)}")`,
						),
					);
				}
			}
		}
	}

	// -----------------------------------------------------------------------
	// Check 11: version code at position 127 of Record 0 should be "2"
	// -----------------------------------------------------------------------
	const headerLine = lines[0]!;
	if (headerLine.length === CODA_LINE_LENGTH) {
		const versionCode = headerLine[127]!;
		if (versionCode !== "2") {
			errors.push(
				warn(1, `Record 0 version code at position 127 should be "2", got "${versionCode}"`),
			);
		}
	}

	// -----------------------------------------------------------------------
	// Check 12: sign codes in Record 21 should be "0" or "1"
	// -----------------------------------------------------------------------
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.length !== CODA_LINE_LENGTH) continue;
		if (!line.startsWith("21")) continue;

		const lineNo = i + 1;
		const signCode = line[31]!; // position [31]
		if (signCode !== "0" && signCode !== "1") {
			errors.push(
				err(lineNo, `Record 21 sign code at position 31 must be "0" or "1", got "${signCode}"`),
			);
		}
	}

	return {
		valid: errors.filter((e) => e.severity === "error").length === 0,
		errors,
	};
}
