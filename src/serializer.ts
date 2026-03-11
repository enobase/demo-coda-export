/**
 * CODA 2.6 Serializer
 *
 * Converts CodaStatement (and individual record objects) to the fixed-width
 * 128-character-per-line text format used by Belgian banks.
 *
 * Rules:
 *   - Every line must be exactly 128 characters.
 *   - Alpha fields: left-aligned, right-padded with spaces.
 *   - Numeric fields: right-aligned, left-padded with zeros.
 *   - Amounts: 15 digits, 12 integer + 3 decimal, no separator.
 *     e.g. EUR 1234.567 -> "000000001234567"
 *   - Sign: '0' = credit/positive, '1' = debit/negative.
 *   - Dates: DDMMYY (6 digits).
 */

import { toLatin1Safe } from "./encoding.ts";
import type {
	CodaStatement,
	Record0Header,
	Record1OldBalance,
	Record4FreeMessage,
	Record8NewBalance,
	Record9Trailer,
	Record21Movement,
	Record22MovementContinuation,
	Record23MovementEnd,
	Record31Information,
	Record32InformationContinuation,
	Record33InformationEnd,
	TransactionCode,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Serialization options
// ---------------------------------------------------------------------------

export interface SerializeOptions {
	/**
	 * Output encoding to target.
	 *   'latin-1' (default) — sanitizes each line through toLatin1Safe so that
	 *     every character is in the Latin-1 range before the 128-char check.
	 *     This matches real Belgian CODA files which use ISO-8859-1.
	 *   'utf-8' — no sanitization; output is returned as plain UTF-16 JS string.
	 */
	encoding?: "utf-8" | "latin-1";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LINE_LENGTH = 128;

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

/**
 * Pad a string on the right with spaces to the given length.
 * Truncates if the string is longer than `length`.
 */
export function padAlpha(value: string, length: number): string {
	if (value.length >= length) {
		return value.slice(0, length);
	}
	return value.padEnd(length, " ");
}

/**
 * Pad a numeric string on the left with zeros to the given length.
 * Truncates from the left if longer (keeps least-significant digits).
 */
export function padNumeric(value: string, length: number): string {
	if (value.length >= length) {
		return value.slice(-length);
	}
	return value.padStart(length, "0");
}

/**
 * Format a non-negative bigint amount as a 15-digit string.
 * The amount is expressed in milli-cents (i.e. the last 3 digits are the
 * decimal part when the currency has 2 decimal places, but CODA always
 * uses 3 decimal digits regardless).
 *
 * Example: BigInt(1234567) -> "000000001234567"   (= 1234.567)
 *          BigInt(0)       -> "000000000000000"
 */
export function formatAmount(amount: bigint): string {
	if (amount < 0n) {
		throw new RangeError(`Amount must be non-negative, got ${amount}`);
	}
	const s = amount.toString();
	if (s.length > 15) {
		throw new RangeError(`Amount ${amount} exceeds 15 digits (max 999999999999999)`);
	}
	return s.padStart(15, "0");
}

/**
 * Format a date as DDMMYY (6 digits).
 * Accepts a Date object or an already-formatted DDMMYY string.
 */
export function formatDate(date: Date | string): string {
	if (typeof date === "string") {
		if (!/^\d{6}$/.test(date)) {
			throw new TypeError(`Date string must be DDMMYY (6 digits), got "${date}"`);
		}
		return date;
	}
	const dd = String(date.getUTCDate()).padStart(2, "0");
	const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
	const yy = String(date.getUTCFullYear()).slice(-2);
	return `${dd}${mm}${yy}`;
}

/**
 * Format a TransactionCode as an 8-digit string.
 *   type(1) + family(2) + operation(2) + category(3)
 */
export function formatTransactionCode(code: TransactionCode): string {
	return (
		padNumeric(code.type, 1) +
		padNumeric(code.family, 2) +
		padNumeric(code.operation, 2) +
		padNumeric(code.category, 3)
	);
}

/**
 * Assert that a serialized line is exactly LINE_LENGTH characters.
 * Throws if not. Used internally to catch bugs.
 */
function assertLength(line: string, recordType: string): string {
	if (line.length !== LINE_LENGTH) {
		throw new Error(
			`Record ${recordType} serialized to ${line.length} chars, expected ${LINE_LENGTH}`,
		);
	}
	return line;
}

// ---------------------------------------------------------------------------
// Per-record serializers
// ---------------------------------------------------------------------------

/**
 * Serialize Record 0 (Header).
 *
 * Layout (128 chars):
 *   [0]       '0'
 *   [1:5]     zeros ('0000') — reserved/file sequence (real bank files always use 0000)
 *   [5:11]    creation date DDMMYY
 *   [11:14]   bank identification number (3 chars)
 *   [14:16]   application code (2 chars)
 *   [16]      duplicate flag (' ' or 'D')
 *   [17:24]   blanks (7)
 *   [24:34]   file reference (10 chars)
 *   [34:60]   addressee name (26 chars)
 *   [60:71]   bank BIC (11 chars)
 *   [71:82]   company identification number (11 chars)
 *   [82]      blank
 *   [83:88]   external application code (5 chars)
 *   [88:104]  transaction reference (16 chars)
 *   [104:120] related reference (16 chars)
 *   [120:127] blanks (7)
 *   [127]     version code ('2')
 */
export function serializeRecord0(rec: Record0Header): string {
	const date = formatDate(rec.creationDate);

	const line =
		"0" + // [0]       record type
		"0000" + // [1:5]    zeros (reserved/file sequence; real bank files always use 0000)
		date + // [5:11]   DDMMYY
		padNumeric(rec.bankIdentificationNumber, 3) + // [11:14]
		padAlpha(rec.applicationCode, 2) + // [14:16]
		(rec.isDuplicate ? "D" : " ") + // [16]
		" ".repeat(7) + // [17:24]
		padAlpha(rec.fileReference, 10) + // [24:34]
		padAlpha(rec.addresseeName, 26) + // [34:60]
		padAlpha(rec.bic, 11) + // [60:71]
		padAlpha(rec.companyIdentificationNumber, 11) + // [71:82]
		" " + // [82]
		padAlpha(rec.externalApplicationCode, 5) + // [83:88]
		padAlpha(rec.transactionReference, 16) + // [88:104]
		padAlpha(rec.relatedReference, 16) + // [104:120]
		" ".repeat(7) + // [120:127]
		rec.versionCode; // [127]

	return assertLength(line, "0");
}

/**
 * Serialize the 37-character account info block used in Records 1 and 8.
 *
 * For structure "0" (Belgian, 12-digit account):
 *   [0:12]  account number (12 digits)
 *   [12]    blank
 *   [13:16] currency (3 chars)
 *   [16]    blank
 *   [17:19] country (2 chars)
 *   [19:37] blanks
 *
 * For structure "1" (foreign):
 *   [0:34]  account number (34 chars)
 *   [34:37] currency (3 chars)
 *
 * For structure "2" (IBAN Belgian):
 *   [0:31]  IBAN (space-padded on right)
 *   [31:34] blanks
 *   [34:37] currency (3 chars)
 *
 * For structure "3" (IBAN foreign):
 *   [0:34]  IBAN (space-padded on right)
 *   [34:37] currency (3 chars)
 */
export function serializeAccountInfo(
	structure: string,
	accountNumber: string,
	currency: string,
	country?: string,
): string {
	let block: string;
	switch (structure) {
		case "0":
			block =
				padNumeric(accountNumber, 12) + // [0:12]
				" " + // [12]
				padAlpha(currency, 3) + // [13:16]
				" " + // [16]
				padAlpha(country ?? "  ", 2) + // [17:19]
				" ".repeat(18); // [19:37]
			break;
		case "1":
			block =
				padAlpha(accountNumber, 34) + // [0:34]
				padAlpha(currency, 3); // [34:37]
			break;
		case "2":
			block =
				padAlpha(accountNumber, 31) + // [0:31]
				"   " + // [31:34]
				padAlpha(currency, 3); // [34:37]
			break;
		case "3":
			block =
				padAlpha(accountNumber, 34) + // [0:34]
				padAlpha(currency, 3); // [34:37]
			break;
		default:
			throw new TypeError(`Unknown account structure: "${structure}"`);
	}

	if (block.length !== 37) {
		throw new Error(
			`Account info block for structure "${structure}" has length ${block.length}, expected 37`,
		);
	}
	return block;
}

/**
 * Serialize Record 1 (Old Balance).
 *
 * Layout (128 chars):
 *   [0]       '1'
 *   [1]       account structure
 *   [2:5]     statement sequence number (3 digits)
 *   [5:42]    account info block (37 chars)
 *   [42]      sign of old balance ('0' or '1')
 *   [43:58]   old balance amount (15 digits)
 *   [58:64]   old balance date DDMMYY
 *   [64:90]   account holder name (26 chars)
 *   [90:125]  account description (35 chars)
 *   [125:128] paper statement sequence (3 digits)
 */
export function serializeRecord1(rec: Record1OldBalance): string {
	const accountBlock = serializeAccountInfo(
		rec.accountStructure,
		rec.accountInfo.accountNumber,
		rec.accountInfo.currency,
		rec.accountInfo.country,
	);

	const line =
		"1" + // [0]
		rec.accountStructure + // [1]
		padNumeric(rec.statementSequenceNumber.toString(), 3) + // [2:5]
		accountBlock + // [5:42]
		rec.oldBalanceSign + // [42]
		formatAmount(rec.oldBalanceAmount) + // [43:58]
		formatDate(rec.oldBalanceDate) + // [58:64]
		padAlpha(rec.accountHolderName, 26) + // [64:90]
		padAlpha(rec.accountDescription, 35) + // [90:125]
		padNumeric(rec.paperStatementSequenceNumber.toString(), 3); // [125:128]

	return assertLength(line, "1");
}

/**
 * Serialize Record 21 (Transaction movement — part 1).
 *
 * Layout (128 chars):
 *   [0:2]     '21'
 *   [2:6]     sequence number (4 digits)
 *   [6:10]    detail number (4 digits)
 *   [10:31]   bank reference (21 chars)
 *   [31]      sign of amount ('0' or '1')
 *   [32:47]   amount (15 digits)
 *   [47:53]   value date DDMMYY
 *   [53:61]   transaction code (8 digits)
 *   [61]      communication type ('0' or '1')
 *   [62:115]  communication (53 chars)
 *   [115:121] entry date DDMMYY
 *   [121:124] statement sequence number (3 digits)
 *   [124]     globalization code (1 digit)
 *   [125:127] blanks (2)
 *   [127]     continuation indicator ('0' or '1')
 */
export function serializeRecord21(rec: Record21Movement): string {
	const line =
		"21" + // [0:2]
		padNumeric(rec.sequenceNumber.toString(), 4) + // [2:6]
		padNumeric(rec.detailNumber.toString(), 4) + // [6:10]
		padAlpha(rec.bankReference, 21) + // [10:31]
		rec.amountSign + // [31]
		formatAmount(rec.amount) + // [32:47]
		formatDate(rec.valueDate) + // [47:53]
		formatTransactionCode(rec.transactionCode) + // [53:61]
		rec.communicationType + // [61]
		padAlpha(rec.communication, 53) + // [62:115]
		formatDate(rec.entryDate) + // [115:121]
		padNumeric(rec.statementSequenceNumber.toString(), 3) + // [121:124]
		padNumeric(rec.globalizationCode.toString(), 1) + // [124]
		"  " + // [125:127]  reserved
		(rec.hasContinuation ? "1" : "0"); // [127]

	return assertLength(line, "21");
}

/**
 * Serialize Record 22 (Transaction continuation).
 *
 * Layout (128 chars):
 *   [0:2]     '22'
 *   [2:6]     sequence number (4 digits)
 *   [6:10]    detail number (4 digits)
 *   [10:63]   communication continuation (53 chars)
 *   [63:98]   client reference (35 chars)
 *   [98:109]  counterparty BIC (11 chars)
 *   [109:112] blanks (3)
 *   [112]     transaction type (1 char)
 *   [113:117] ISO reason return code (4 chars)
 *   [117:121] category purpose (4 chars)
 *   [121:125] purpose (4 chars)
 *   [125:127] blanks (2)
 *   [127]     continuation indicator ('0' or '1')
 */
export function serializeRecord22(rec: Record22MovementContinuation): string {
	const line =
		"22" + // [0:2]
		padNumeric(rec.sequenceNumber.toString(), 4) + // [2:6]
		padNumeric(rec.detailNumber.toString(), 4) + // [6:10]
		padAlpha(rec.communicationContinuation, 53) + // [10:63]
		padAlpha(rec.clientReference, 35) + // [63:98]
		padAlpha(rec.counterpartyBic, 11) + // [98:109]
		"   " + // [109:112]
		padAlpha(rec.transactionType, 1) + // [112]
		padAlpha(rec.isoReasonReturnCode, 4) + // [113:117]
		padAlpha(rec.categoryPurpose, 4) + // [117:121]
		padAlpha(rec.purpose, 4) + // [121:125]
		"  " + // [125:127]
		(rec.hasContinuation ? "1" : "0"); // [127]

	return assertLength(line, "22");
}

/**
 * Serialize Record 23 (Transaction end — counterparty info).
 *
 * Layout (128 chars):
 *   [0:2]     '23'
 *   [2:6]     sequence number (4 digits)
 *   [6:10]    detail number (4 digits)
 *   [10:47]   counterparty account raw (37 chars)
 *   [47:82]   counterparty name (35 chars)
 *   [82:125]  remaining communication (43 chars)
 *   [125:127] blanks (2)
 *   [127]     end indicator ('0' = more, '1' = last)
 */
export function serializeRecord23(rec: Record23MovementEnd): string {
	const line =
		"23" + // [0:2]
		padNumeric(rec.sequenceNumber.toString(), 4) + // [2:6]
		padNumeric(rec.detailNumber.toString(), 4) + // [6:10]
		padAlpha(rec.counterpartyAccountRaw, 37) + // [10:47]
		padAlpha(rec.counterpartyName, 35) + // [47:82]
		padAlpha(rec.remainingCommunication, 43) + // [82:125]
		"  " + // [125:127]
		(rec.isLastRecord ? "1" : "0"); // [127]

	return assertLength(line, "23");
}

/**
 * Serialize Record 31 (Information — part 1).
 *
 * Layout (128 chars):
 *   [0:2]     '31'
 *   [2:6]     sequence number (4 digits)
 *   [6:10]    detail number (4 digits)
 *   [10:31]   bank reference (21 chars)
 *   [31:39]   transaction code (8 digits)
 *   [39]      communication type ('0' or '1')
 *   [40:113]  communication (73 chars)
 *   [113:127] blanks (14)
 *   [127]     continuation indicator ('0' or '1')
 */
export function serializeRecord31(rec: Record31Information): string {
	const line =
		"31" + // [0:2]
		padNumeric(rec.sequenceNumber.toString(), 4) + // [2:6]
		padNumeric(rec.detailNumber.toString(), 4) + // [6:10]
		padAlpha(rec.bankReference, 21) + // [10:31]
		formatTransactionCode(rec.transactionCode) + // [31:39]
		rec.communicationType + // [39]
		padAlpha(rec.communication, 73) + // [40:113]
		" ".repeat(14) + // [113:127]
		(rec.hasContinuation ? "1" : "0"); // [127]

	return assertLength(line, "31");
}

/**
 * Serialize Record 32 (Information continuation).
 *
 * Layout (128 chars):
 *   [0:2]     '32'
 *   [2:6]     sequence number (4 digits)
 *   [6:10]    detail number (4 digits)
 *   [10:115]  communication continuation (105 chars)
 *   [115:127] blanks (12)
 *   [127]     continuation indicator
 */
export function serializeRecord32(rec: Record32InformationContinuation): string {
	const line =
		"32" + // [0:2]
		padNumeric(rec.sequenceNumber.toString(), 4) + // [2:6]
		padNumeric(rec.detailNumber.toString(), 4) + // [6:10]
		padAlpha(rec.communicationContinuation, 105) + // [10:115]
		" ".repeat(12) + // [115:127]
		(rec.hasContinuation ? "1" : "0"); // [127]

	return assertLength(line, "32");
}

/**
 * Serialize Record 33 (Information end).
 *
 * Layout (128 chars):
 *   [0:2]     '33'
 *   [2:6]     sequence number (4 digits)
 *   [6:10]    detail number (4 digits)
 *   [10:100]  communication continuation (90 chars)
 *   [100:127] blanks (27)
 *   [127]     end indicator ('0' or '1')
 */
export function serializeRecord33(rec: Record33InformationEnd): string {
	const line =
		"33" + // [0:2]
		padNumeric(rec.sequenceNumber.toString(), 4) + // [2:6]
		padNumeric(rec.detailNumber.toString(), 4) + // [6:10]
		padAlpha(rec.communicationContinuation, 90) + // [10:100]
		" ".repeat(27) + // [100:127]
		(rec.isLastRecord ? "1" : "0"); // [127]

	return assertLength(line, "33");
}

/**
 * Serialize Record 4 (Free message).
 *
 * Layout (128 chars):
 *   [0]       '4'
 *   [1]       blank
 *   [2:6]     sequence number (4 digits)
 *   [6:10]    detail number (4 digits)
 *   [10:32]   blanks (22)
 *   [32:112]  message (80 chars)
 *   [112:127] blanks (15)
 *   [127]     continuation indicator
 */
export function serializeRecord4(rec: Record4FreeMessage): string {
	const line =
		"4" + // [0]
		" " + // [1]
		padNumeric(rec.sequenceNumber.toString(), 4) + // [2:6]
		padNumeric(rec.detailNumber.toString(), 4) + // [6:10]
		" ".repeat(22) + // [10:32]
		padAlpha(rec.message, 80) + // [32:112]
		" ".repeat(15) + // [112:127]
		(rec.hasContinuation ? "1" : "0"); // [127]

	return assertLength(line, "4");
}

/**
 * Serialize Record 8 (New Balance).
 *
 * Layout (128 chars):
 *   [0]       '8'
 *   [1:4]     statement sequence number (3 digits)
 *   [4:41]    account info raw (37 chars)
 *   [41]      sign of new balance ('0' or '1')
 *   [42:57]   new balance amount (15 digits)
 *   [57:63]   new balance date DDMMYY
 *   [63:127]  blanks (64)
 *   [127]     '0'
 */
export function serializeRecord8(rec: Record8NewBalance): string {
	const line =
		"8" + // [0]
		padNumeric(rec.statementSequenceNumber.toString(), 3) + // [1:4]
		padAlpha(rec.accountInfoRaw, 37) + // [4:41]
		rec.newBalanceSign + // [41]
		formatAmount(rec.newBalanceAmount) + // [42:57]
		formatDate(rec.newBalanceDate) + // [57:63]
		" ".repeat(64) + // [63:127]
		"0"; // [127]

	return assertLength(line, "8");
}

/**
 * Serialize Record 9 (Trailer).
 *
 * Layout (128 chars):
 *   [0]       '9'
 *   [1:16]    blanks (15)
 *   [16:22]   record count (6 digits; excludes Record 0 and Record 9)
 *   [22:37]   total debit — sign(1) + amount(14 digits)
 *   [37:52]   total credit — sign(1) + amount(14 digits)
 *   [52:127]  blanks (75)
 *   [127]     version code ('2')
 */
export function serializeRecord9(rec: Record9Trailer): string {
	const line =
		"9" + // [0]
		" ".repeat(15) + // [1:16]
		padNumeric(rec.recordCount.toString(), 6) + // [16:22]
		"0" + padNumeric(rec.totalDebit.toString(), 14) + // [22:37] sign + 14-digit amount
		"0" + padNumeric(rec.totalCredit.toString(), 14) + // [37:52] sign + 14-digit amount
		" ".repeat(75) + // [52:127]
		"2"; // [127] version code

	return assertLength(line, "9");
}

// ---------------------------------------------------------------------------
// Top-level statement serializer
// ---------------------------------------------------------------------------

/**
 * Serialize a complete CodaStatement to a multi-line string.
 *
 * The output ends with a newline after the last line (Record 9).
 * Line endings are LF (\n).
 *
 * Record ordering:
 *   Record 0 (header)
 *   Record 1 (old balance)
 *   ... movement / information / free-message records ...
 *   Record 8 (new balance)
 *   Record 9 (trailer)
 */
export function serializeCoda(statement: CodaStatement, options?: SerializeOptions): string {
	const lines: string[] = [];

	lines.push(serializeRecord0(statement.header));
	lines.push(serializeRecord1(statement.oldBalance));

	for (const rec of statement.records) {
		switch (rec.recordType) {
			case "21":
				lines.push(serializeRecord21(rec));
				break;
			case "22":
				lines.push(serializeRecord22(rec));
				break;
			case "23":
				lines.push(serializeRecord23(rec));
				break;
			case "31":
				lines.push(serializeRecord31(rec));
				break;
			case "32":
				lines.push(serializeRecord32(rec));
				break;
			case "33":
				lines.push(serializeRecord33(rec));
				break;
			case "4":
				lines.push(serializeRecord4(rec));
				break;
		}
	}

	lines.push(serializeRecord8(statement.newBalance));
	lines.push(serializeRecord9(statement.trailer));

	// Apply Latin-1 sanitization per line (default behaviour).
	// toLatin1Safe is a 1:1 character replacement so it cannot change line
	// lengths — the 128-char invariant is preserved.
	const encoding = options?.encoding ?? "latin-1";
	const outputLines = encoding === "latin-1" ? lines.map(toLatin1Safe) : lines;

	return `${outputLines.join("\n")}\n`;
}
