/**
 * Phase 3: Transaction-to-CODA mapping engine
 *
 * Converts BankTransaction[] (from parsers) into a CodaStatement (for serializer).
 *
 * Key design decisions:
 *   - Amount conversion uses Math.round(amount * 1000) to avoid floating-point
 *     drift, then BigInt(). The amount field is always non-negative; sign is
 *     encoded separately as '0' (credit) or '1' (debit).
 *   - Belgian structured communication (OGM/VCS) is auto-detected and encoded
 *     as '101' + 12 raw digits per the CODA 2.6 spec.
 *   - Communication > 53 chars spills into Record 22 (53 chars) and Record 23
 *     (43 chars).
 *   - Record 22 is emitted when there is communication continuation OR a
 *     counterparty BIC.
 *   - Record 23 is emitted when there is a counterparty IBAN or name.
 */

import type { BankTransaction } from "./parsers/types.ts";
import { validateIban } from "./belgian-banks.ts";
import { formatDate, padNumeric, serializeAccountInfo } from "./serializer.ts";
import type {
	AccountInfo,
	AccountStructure,
	CodaStatement,
	Record0Header,
	Record1OldBalance,
	Record8NewBalance,
	Record9Trailer,
	Record21Movement,
	Record22MovementContinuation,
	Record23MovementEnd,
	SignCode,
	TransactionCode,
} from "./types.ts";

// ---------------------------------------------------------------------------
// CodaConfig — caller-supplied metadata not present in the CSV
// ---------------------------------------------------------------------------

export interface CodaConfig {
	/** 3-char bank identification number */
	bankId: string;
	/** IBAN of the account (e.g. "BE68539007547034") */
	accountIban: string;
	/** ISO 4217 currency code, typically "EUR" */
	accountCurrency: string;
	/** Name on the account (max 26 chars) */
	accountHolderName: string;
	/** Product description (max 35 chars) */
	accountDescription?: string;
	/** 2-char application code, default "05" */
	applicationCode?: string;
	/** 11-char BIC of the bank */
	bic?: string;
	/** 11-char company identification number */
	companyId?: string;
	/** Statement sequence number; auto-starts at 1 if omitted */
	statementSequence?: number;
	/** Balance at start of period, e.g. 1234.56 */
	openingBalance: number;
	/** Date of the opening balance */
	openingBalanceDate: Date;
}

// ---------------------------------------------------------------------------
// Structured communication patterns (Belgian OGM/VCS)
// ---------------------------------------------------------------------------

/** Matches +++NNN/NNNN/NNNNN+++ */
const OGM_PATTERN = /^\+\+\+(\d{3})\/(\d{4})\/(\d{5})\+\+\+$/;
/** Matches exactly 12 consecutive digits */
const OGM_DIGITS_PATTERN = /^(\d{3})(\d{4})(\d{5})$/;

/**
 * Validate the modulo-97 check digit of a Belgian OGM/VCS structured communication.
 *
 * @param digits - Exactly 12 numeric characters (no separators).
 *                 The first 10 are the base number; the last 2 are the check digit.
 * @returns true when the check digit is correct, false otherwise.
 */
export function validateOgmCheckDigit(digits: string): boolean {
	const base = parseInt(digits.slice(0, 10), 10);
	const check = parseInt(digits.slice(10, 12), 10);
	const expected = base % 97 === 0 ? 97 : base % 97;
	return check === expected;
}

/**
 * Format 10 base digits into a canonical +++NNN/NNNN/NNNNN+++ OGM string,
 * computing and appending the correct modulo-97 check digit.
 *
 * @param first10 - Exactly 10 numeric characters (leading zeros preserved).
 * @returns The formatted OGM string, e.g. "+++123/4567/89002+++".
 */
export function formatOgm(first10: string): string {
	const base = parseInt(first10, 10);
	const check = base % 97 === 0 ? 97 : base % 97;
	const checkStr = String(check).padStart(2, "0");
	const digits = first10 + checkStr;
	return `+++${digits.slice(0, 3)}/${digits.slice(3, 7)}/${digits.slice(7, 12)}+++`;
}

/**
 * Detect whether a string is a Belgian structured communication (OGM/VCS).
 * Returns the canonical +++NNN/NNNN/NNNNN+++ string if it matches AND the
 * modulo-97 check digit is valid, or null otherwise.
 */
export function detectOgm(value: string): string | null {
	if (!value) return null;
	const trimmed = value.trim();

	const ogmMatch = OGM_PATTERN.exec(trimmed);
	if (ogmMatch) {
		const digits = ogmMatch[1] + ogmMatch[2] + ogmMatch[3];
		if (!validateOgmCheckDigit(digits)) return null;
		return `+++${ogmMatch[1]}/${ogmMatch[2]}/${ogmMatch[3]}+++`;
	}

	const digitMatch = OGM_DIGITS_PATTERN.exec(trimmed);
	if (digitMatch) {
		const digits = digitMatch[1] + digitMatch[2] + digitMatch[3];
		if (!validateOgmCheckDigit(digits)) return null;
		return `+++${digitMatch[1]}/${digitMatch[2]}/${digitMatch[3]}+++`;
	}

	return null;
}

/**
 * Extract the 12 raw digits from a Belgian OGM/VCS structured communication.
 * Returns the raw digits if the value is a valid OGM, or null otherwise.
 *
 * Example: "+++269/0211/57996+++" → "269021157996"
 */
export function extractOgmDigits(value: string): string | null {
	if (!value) return null;
	const trimmed = value.trim();

	const ogmMatch = OGM_PATTERN.exec(trimmed);
	if (ogmMatch) {
		const digits = ogmMatch[1] + ogmMatch[2] + ogmMatch[3];
		if (!validateOgmCheckDigit(digits)) return null;
		return digits;
	}

	const digitMatch = OGM_DIGITS_PATTERN.exec(trimmed);
	if (digitMatch) {
		const digits = digitMatch[1] + digitMatch[2] + digitMatch[3];
		if (!validateOgmCheckDigit(digits)) return null;
		return digits;
	}

	return null;
}

// ---------------------------------------------------------------------------
// Amount conversion
// ---------------------------------------------------------------------------

/**
 * Convert a signed floating-point amount to a non-negative bigint in
 * milli-cents (3 decimal places, as required by CODA).
 *
 * We use Math.round(|amount| * 1000) to avoid floating-point drift, then
 * convert to BigInt.
 *
 * Examples:
 *   42.50  → 42500n
 *   -42.50 → 42500n  (sign returned separately)
 *   0.1 + 0.2 = 0.30000000000000004 → 300n  (correctly rounded)
 */
export function toMilliCents(amount: number): bigint {
	if (!Number.isFinite(amount)) {
		throw new Error(`Amount must be a finite number, got ${amount}`);
	}
	const abs = Math.abs(amount);
	const rounded = Math.round(abs * 1000);
	return BigInt(rounded);
}

/**
 * Determine the CODA sign code for an amount.
 *   '0' = credit (positive / incoming)
 *   '1' = debit  (negative / outgoing)
 */
export function toSignCode(amount: number): SignCode {
	return amount >= 0 ? "0" : "1";
}

// ---------------------------------------------------------------------------
// Transaction code mapping
// ---------------------------------------------------------------------------

interface TxCodeSpec {
	family: string;
	operation: string;
}

/**
 * Map a Revolut rawType + sign to a CODA transaction code family/operation.
 * Sign is '0' for credit, '1' for debit.
 */
function mapRevolutType(rawType: string | undefined, sign: SignCode): TxCodeSpec {
	switch (rawType) {
		case "CARD_PAYMENT":
			return { family: "43", operation: "01" };
		case "TRANSFER":
			// Received (credit) vs sent (debit) use different operation codes
			return sign === "0" ? { family: "01", operation: "01" } : { family: "01", operation: "37" };
		case "TOPUP":
			return { family: "01", operation: "01" };
		case "EXCHANGE":
			return { family: "41", operation: "01" };
		case "FEE":
			return { family: "35", operation: "01" };
		default:
			return { family: "01", operation: "01" };
	}
}

/**
 * Map a Qonto rawType (payment method) + sign to a CODA transaction code.
 */
function mapQontoType(rawType: string | undefined, sign: SignCode): TxCodeSpec {
	switch (rawType) {
		case "card":
			return { family: "43", operation: "01" };
		case "transfer":
			return sign === "0" ? { family: "01", operation: "01" } : { family: "01", operation: "37" };
		case "direct_debit":
			return { family: "05", operation: "01" };
		default:
			return { family: "01", operation: "01" };
	}
}

/**
 * Map an N26 rawType + sign to a CODA transaction code.
 */
function mapN26Type(rawType: string | undefined, sign: SignCode): TxCodeSpec {
	switch (rawType) {
		case "MasterCard Payment":
			return { family: "43", operation: "01" };
		case "Direct Debit":
			return { family: "05", operation: "01" };
		case "Credit Transfer":
		case "Outgoing Transfer":
		case "Income":
			return sign === "0" ? { family: "01", operation: "01" } : { family: "01", operation: "37" };
		default:
			return { family: "01", operation: "01" };
	}
}

/**
 * Map a Wise transaction to a CODA transaction code.
 * Wise is primarily a transfer service, so all transactions map to family 01.
 */
function mapWiseType(_rawType: string | undefined, sign: SignCode): TxCodeSpec {
	return sign === "0" ? { family: "01", operation: "01" } : { family: "01", operation: "37" };
}

/**
 * Build a TransactionCode from a BankTransaction.
 * Type is always "1" (individual). Category is always "000".
 */
export function buildTransactionCode(tx: BankTransaction): TransactionCode {
	const sign = toSignCode(tx.amount);
	let spec: TxCodeSpec;

	switch (tx.source) {
		case "revolut-personal":
		case "revolut-business":
			spec = mapRevolutType(tx.rawType, sign);
			break;
		case "qonto":
			spec = mapQontoType(tx.rawType, sign);
			break;
		case "n26":
			spec = mapN26Type(tx.rawType, sign);
			break;
		case "wise":
			spec = mapWiseType(tx.rawType, sign);
			break;
		default:
			spec = { family: "01", operation: "01" };
	}

	return {
		type: "1",
		family: spec.family,
		operation: spec.operation,
		category: "000",
	};
}

// ---------------------------------------------------------------------------
// IBAN handling
// ---------------------------------------------------------------------------

/**
 * Determine the AccountStructure for a given IBAN.
 *   "2" = Belgian IBAN (starts with "BE")
 *   "3" = Foreign IBAN
 */
export function ibanToAccountStructure(iban: string): AccountStructure {
	const normalized = iban.replace(/\s+/g, "").toUpperCase();
	return normalized.startsWith("BE") ? "2" : "3";
}

/**
 * Build a 37-char counterparty account block for Record 23.
 * When no IBAN is available, returns 37 spaces.
 */
export function buildCounterpartyAccountRaw(
	counterpartyIban: string | undefined,
	currency: string,
): string {
	if (!counterpartyIban) {
		return " ".repeat(37);
	}

	const normalized = counterpartyIban.replace(/\s+/g, "").toUpperCase();
	if (!validateIban(normalized)) {
		process.stderr.write(`Warning: counterparty IBAN has invalid check digit: ${normalized}\n`);
	}
	const structure = ibanToAccountStructure(normalized);
	return serializeAccountInfo(structure, normalized, currency);
}

// ---------------------------------------------------------------------------
// Communication splitting
// ---------------------------------------------------------------------------

interface CommunicationParts {
	/** Communication type: '0' free text, '1' structured OGM */
	type: "0" | "1";
	/** First 53 chars (Record 21 communication field) */
	part1: string;
	/** Next 53 chars (Record 22 communicationContinuation), empty string if not needed */
	part2: string;
	/** Remaining 43 chars (Record 23 remainingCommunication), empty string if not needed */
	part3: string;
}

/**
 * Split a transaction's communication text into the three CODA slots:
 *   Record 21: 53 chars
 *   Record 22: 53 chars
 *   Record 23: 43 chars
 *
 * For structured OGM, the formatted string (14 chars) is placed in part1.
 * For free text, the text is truncated/split across the three slots.
 */
export function splitCommunication(
	reference: string | undefined,
	description: string,
): CommunicationParts {
	// Prefer reference over description for communication text
	const text = reference ?? description ?? "";

	// Check for Belgian structured communication first
	const ogmDigits = extractOgmDigits(text);
	if (ogmDigits) {
		return {
			type: "1",
			part1: "101" + ogmDigits, // '101' type code + 12 raw digits = 15 chars, padded to 53 by serializer
			part2: "",
			part3: "",
		};
	}

	// Free text: split across 53 + 53 + 43 = 149 chars total
	const full = text.slice(0, 149);
	return {
		type: "0",
		part1: full.slice(0, 53),
		part2: full.slice(53, 106),
		part3: full.slice(106, 149),
	};
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

/**
 * Validate a CodaConfig object.
 * Throws a descriptive Error on the first validation failure found.
 */
export function validateConfig(config: CodaConfig): void {
	// IBAN: must start with 2 uppercase letters + 2 digits, no spaces
	if (!config.accountIban) {
		throw new Error("CodaConfig.accountIban is required");
	}
	if (/\s/.test(config.accountIban)) {
		throw new Error(`CodaConfig.accountIban must not contain spaces, got "${config.accountIban}"`);
	}
	if (!/^[A-Z]{2}\d{2}/i.test(config.accountIban)) {
		throw new Error(
			`CodaConfig.accountIban must start with 2 letters + 2 digits, got "${config.accountIban}"`,
		);
	}
	if (!validateIban(config.accountIban)) {
		throw new Error(
			`CodaConfig.accountIban has an invalid IBAN check digit: "${config.accountIban}"`,
		);
	}

	// bankId: 1–3 chars
	if (!config.bankId || config.bankId.length < 1 || config.bankId.length > 3) {
		throw new Error(`CodaConfig.bankId must be 1–3 characters, got "${config.bankId}"`);
	}

	// accountHolderName: required, max 26 chars
	if (!config.accountHolderName || config.accountHolderName.trim() === "") {
		throw new Error("CodaConfig.accountHolderName is required");
	}
	if (config.accountHolderName.length > 26) {
		throw new Error(
			`CodaConfig.accountHolderName must be at most 26 characters, got ${config.accountHolderName.length}`,
		);
	}

	// openingBalance: finite number
	if (!Number.isFinite(config.openingBalance)) {
		throw new Error(
			`CodaConfig.openingBalance must be a finite number, got ${config.openingBalance}`,
		);
	}

	// openingBalanceDate: valid Date
	if (
		!(config.openingBalanceDate instanceof Date) ||
		Number.isNaN(config.openingBalanceDate.getTime())
	) {
		throw new Error("CodaConfig.openingBalanceDate must be a valid Date");
	}
}

// ---------------------------------------------------------------------------
// Record builders
// ---------------------------------------------------------------------------

function buildRecord0(config: CodaConfig, now: Date): Record0Header {
	return {
		recordType: "0",
		creationDate: formatDate(now),
		bankIdentificationNumber: config.bankId,
		applicationCode: config.applicationCode ?? "05",
		isDuplicate: false,
		fileReference: formatDate(now).slice(0, 6) + padNumeric(String(config.statementSequence ?? 1), 4),
		addresseeName: config.accountHolderName,
		bic: config.bic ?? "",
		companyIdentificationNumber: config.companyId ?? "",
		externalApplicationCode: "",
		transactionReference: "",
		relatedReference: "",
		versionCode: "2",
	};
}

function buildAccountInfo(config: CodaConfig): AccountInfo {
	const normalized = config.accountIban.replace(/\s+/g, "").toUpperCase();
	const structure: AccountStructure = normalized.startsWith("BE") ? "2" : "3";
	return {
		accountStructure: structure,
		accountNumber: normalized,
		currency: config.accountCurrency,
	};
}

function buildRecord1(config: CodaConfig, seqNum: number): Record1OldBalance {
	const accountInfo = buildAccountInfo(config);
	const absAmount = toMilliCents(config.openingBalance);
	const sign = toSignCode(config.openingBalance);

	return {
		recordType: "1",
		accountStructure: accountInfo.accountStructure,
		statementSequenceNumber: seqNum,
		accountInfo,
		oldBalanceSign: sign,
		oldBalanceAmount: absAmount,
		oldBalanceDate: formatDate(config.openingBalanceDate),
		accountHolderName: config.accountHolderName,
		accountDescription: config.accountDescription ?? "",
		paperStatementSequenceNumber: seqNum,
	};
}

function buildRecord8(
	config: CodaConfig,
	seqNum: number,
	newBalanceAmount: bigint,
	newBalanceSign: SignCode,
	statementDate: Date,
): Record8NewBalance {
	const accountInfo = buildAccountInfo(config);
	const accountInfoRaw = serializeAccountInfo(
		accountInfo.accountStructure,
		accountInfo.accountNumber,
		accountInfo.currency,
	);

	return {
		recordType: "8",
		statementSequenceNumber: seqNum,
		accountInfoRaw,
		newBalanceSign,
		newBalanceAmount,
		newBalanceDate: formatDate(statementDate),
	};
}

// ---------------------------------------------------------------------------
// Main mapper
// ---------------------------------------------------------------------------

/**
 * Convert an array of BankTransaction objects into a complete CodaStatement.
 *
 * @param transactions - Normalised transactions from a parser
 * @param config       - Account metadata and opening balance
 * @returns            A CodaStatement ready for serialisation
 */
export function mapToCoda(transactions: BankTransaction[], config: CodaConfig): CodaStatement {
	validateConfig(config);

	const seqNum = config.statementSequence ?? 1;
	const now = new Date();

	const header = buildRecord0(config, now);
	const oldBalance = buildRecord1(config, seqNum);

	// Determine the statement date: last transaction date, or opening balance date
	const dates = transactions
		.map((tx) => tx.date)
		.filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()));
	const statementDate =
		dates.length > 0
			? new Date(Math.max(...dates.map((d) => d.getTime())))
			: config.openingBalanceDate;

	// Build movement records
	const movementRecords: Array<
		Record21Movement | Record22MovementContinuation | Record23MovementEnd
	> = [];

	let totalDebit = 0n;
	let totalCredit = 0n;

	// Sequence numbers must be unique across all emitted Record 21s (main + fee).
	// We maintain a running counter rather than using the loop index directly.
	let nextSeq = 1;

	for (let i = 0; i < transactions.length; i++) {
		const tx = transactions[i];
		const txSeq = nextSeq++;

		const amountSign = toSignCode(tx.amount);
		const amount = toMilliCents(tx.amount);
		const txCode = buildTransactionCode(tx);
		const entryDate = formatDate(tx.date);
		const valueDate = tx.valueDate ? formatDate(tx.valueDate) : entryDate;

		const comm = splitCommunication(tx.reference, tx.description);

		const hasCptyIban = !!tx.counterpartyIban;
		const hasCptyName = !!tx.counterpartyName;
		const hasCptyBic = !!tx.counterpartyBic;

		const needsRecord22 = comm.part2.length > 0 || hasCptyBic;
		const needsRecord23 = hasCptyIban || hasCptyName;

		// Accumulate totals
		if (amountSign === "1") {
			totalDebit += amount;
		} else {
			totalCredit += amount;
		}

		// Record 21
		const bankRef = `CODA${seqNum.toString().padStart(4, "0")}${txSeq.toString().padStart(13, "0")}`;
		const rec21: Record21Movement = {
			recordType: "21",
			sequenceNumber: txSeq,
			detailNumber: 0,
			bankReference: bankRef,
			amountSign,
			amount,
			entryDate,
			transactionCode: txCode,
			communicationType: comm.type,
			communication: comm.part1,
			valueDate,
			statementSequenceNumber: seqNum,
			globalizationCode: 0,
			hasContinuation: needsRecord22 || needsRecord23,
		};
		movementRecords.push(rec21);

		// Record 22 (continuation) — emit when there's spill communication, counterparty BIC, or counterparty IBAN/name
		if (needsRecord22 || needsRecord23) {
			const rec22: Record22MovementContinuation = {
				recordType: "22",
				sequenceNumber: txSeq,
				detailNumber: 0,
				communicationContinuation: comm.part2,
				clientReference: "",
				counterpartyBic: tx.counterpartyBic ?? "",
				transactionType: "",
				isoReasonReturnCode: "",
				categoryPurpose: "",
				purpose: "",
				hasContinuation: needsRecord23,
			};
			movementRecords.push(rec22);
		}

		// Record 23 — emit when there's counterparty IBAN or name
		if (needsRecord23) {
			const counterpartyAccountRaw = buildCounterpartyAccountRaw(
				tx.counterpartyIban,
				config.accountCurrency,
			);
			const rec23: Record23MovementEnd = {
				recordType: "23",
				sequenceNumber: txSeq,
				detailNumber: 0,
				counterpartyAccountRaw,
				counterpartyName: tx.counterpartyName ?? "",
				remainingCommunication: comm.part3,
				isLastRecord: true,
			};
			movementRecords.push(rec23);
		}

		// Fee record — emit a separate debit Record 21 when the transaction carries a fee
		if (tx.fee !== undefined && tx.fee !== 0) {
			const feeSeq = nextSeq++;
			const feeAmount = toMilliCents(tx.fee); // toMilliCents always returns abs value
			const feeSign: SignCode = "1"; // fees are always debits
			const feeBankRef = `CODA${seqNum.toString().padStart(4, "0")}${feeSeq.toString().padStart(13, "0")}`;

			const feeRec21: Record21Movement = {
				recordType: "21",
				sequenceNumber: feeSeq,
				detailNumber: 0,
				bankReference: feeBankRef,
				amountSign: feeSign,
				amount: feeAmount,
				entryDate,
				transactionCode: { type: "1", family: "35", operation: "01", category: "000" },
				communicationType: "0",
				communication: `Fee: ${tx.description}`.slice(0, 53),
				valueDate,
				statementSequenceNumber: seqNum,
				globalizationCode: 0,
				hasContinuation: false,
			};
			movementRecords.push(feeRec21);
			totalDebit += feeAmount;
		}
	}

	// Compute new balance: opening balance ± each transaction
	// We work in milli-cents signed arithmetic
	const openingMilliCents = BigInt(Math.round(config.openingBalance * 1000));
	const netChange = totalCredit - totalDebit; // credits increase balance, debits decrease
	const newBalanceMilliCents = openingMilliCents + netChange;

	const newBalanceSign: SignCode = newBalanceMilliCents >= 0n ? "0" : "1";
	const newBalanceAmount = newBalanceMilliCents < 0n ? -newBalanceMilliCents : newBalanceMilliCents;

	const newBalance = buildRecord8(config, seqNum, newBalanceAmount, newBalanceSign, statementDate);

	// Record count excludes Record 0 and Record 9 themselves.
	// It includes Record 1, all movement records, and Record 8.
	const recordCount = 1 + movementRecords.length + 1; // rec1 + movements + rec8

	const trailer: Record9Trailer = {
		recordType: "9",
		recordCount,
		totalDebit,
		totalCredit,
	};

	return {
		header,
		oldBalance,
		records: movementRecords,
		newBalance,
		trailer,
	};
}
