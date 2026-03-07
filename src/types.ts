/**
 * CODA 2.6 Format Type Definitions
 *
 * CODA (Coded Statement of Account) is a Belgian bank statement format
 * defined by Febelfin. Every line is exactly 128 characters wide.
 *
 * Field positions below are 0-indexed (matching JavaScript's string.slice semantics).
 * All positions are verified against:
 *   - wimverstuyf/php-coda-parser (PHP reference implementation)
 *   - Real sample CODA files from Belgian banks
 *
 * Amount encoding: 15 digits, no decimal separator.
 *   12 integer digits + 3 decimal digits.
 *   e.g. 1234.567 -> "000000001234567"
 *
 * Sign encoding: '0' = credit (positive), '1' = debit (negative).
 *
 * Date encoding: DDMMYY (6 digits, e.g. 17 October 2023 -> "171023").
 */

// ---------------------------------------------------------------------------
// Branded primitives
// ---------------------------------------------------------------------------

/** A sign code: '0' = credit/positive, '1' = debit/negative */
export type SignCode = "0" | "1";

/** Account structure type */
export type AccountStructure =
	| "0" // Belgian account (12 digits)
	| "1" // Foreign account (34 chars)
	| "2" // IBAN Belgian (BE + 2 check + 12 BBAN = up to 31 chars)
	| "3"; // IBAN Foreign (up to 34 chars)

/** CODA version code (always '2' for CODA 2.x) */
export type VersionCode = "2";

/** Communication type: '0' = free text, '1' = structured (OGM/VCS) */
export type CommunicationType = "0" | "1";

/** Continuation/sequence flag on Record 2x/3x lines */
export type ContinuationCode = "0" | "1";

// ---------------------------------------------------------------------------
// Shared sub-structures
// ---------------------------------------------------------------------------

/**
 * Transaction code — 8 digits total
 *   [0]    type        (1 digit): 0=global, 1=individual
 *   [1:3]  family      (2 digits): e.g. 01=credit transfers, 05=cash
 *   [3:5]  operation   (2 digits): e.g. 01=received, 07=paid
 *   [5:8]  category    (3 digits): bank-defined sub-category
 */
export interface TransactionCode {
	/** 1 digit: 0=non-individual (global), 1=individual */
	type: string;
	/** 2 digits: e.g. "01" = credit transfers */
	family: string;
	/** 2 digits: e.g. "01" = received */
	operation: string;
	/** 3 digits: bank-defined category */
	category: string;
}

/**
 * Account holder information (37 chars in the file, structure depends on accountStructure)
 *
 * For accountStructure "0" (Belgian):
 *   [0:12]  Belgian account number (12 digits)
 *   [12]    blank
 *   [13:16] currency code (ISO 4217, 3 chars)
 *   [16]    blank
 *   [17:19] country code (ISO 3166-1 alpha-2, 2 chars)
 *   [19:37] blanks
 *
 * For accountStructure "1" (Foreign):
 *   [0:34]  foreign account number (34 chars)
 *   [34:37] currency code
 *
 * For accountStructure "2" (IBAN Belgian):
 *   [0:31]  IBAN (e.g. "BE68539007547034             " — left-aligned, space-padded)
 *   [31:34] blanks
 *   [34:37] currency code (ISO 4217)
 *
 * For accountStructure "3" (IBAN Foreign):
 *   [0:34]  IBAN (34 chars, space-padded)
 *   [34:37] currency code
 */
export interface AccountInfo {
	accountStructure: AccountStructure;
	/** The account number or IBAN string (raw, as it appears in the 37-char block) */
	accountNumber: string;
	/** ISO 4217 currency code, e.g. "EUR" */
	currency: string;
	/** ISO 3166-1 alpha-2, only meaningful for structure "0" */
	country?: string;
}

// ---------------------------------------------------------------------------
// Record 0 — Header
// ---------------------------------------------------------------------------
/**
 * Record 0: File identification (header)
 *
 * Positions (0-indexed):
 *   [0]       = "0" (record type)
 *   [1:5]     = creation date first 4 chars (DDMM) — rarely used separately; [5:11] is the canonical date
 *   [5:11]    = creation date DDMMYY
 *   [11:14]   = bank identification number (3 chars)
 *   [14:16]   = application code (2 chars, usually "05")
 *   [16]      = duplicate flag (' ' = original, 'D' = duplicate)
 *   [17:24]   = blanks
 *   [24:34]   = file reference (10 chars)
 *   [34:60]   = addressee / account holder name (26 chars)
 *   [60:71]   = bank BIC (11 chars)
 *   [71:82]   = company identification number (11 chars)
 *   [82]      = blank
 *   [83:88]   = external application code (5 chars)
 *   [88:104]  = transaction reference (16 chars)
 *   [104:120] = related reference (16 chars)
 *   [120:127] = blanks
 *   [127]     = version code (always "2")
 */
export interface Record0Header {
	recordType: "0";
	/** DDMMYY */
	creationDate: string;
	/** 3-char bank identification number */
	bankIdentificationNumber: string;
	/** 2-char application code, typically "05" */
	applicationCode: string;
	/** true if this is a duplicate file */
	isDuplicate: boolean;
	/** 10-char file reference assigned by the bank */
	fileReference: string;
	/** 26-char name of the account holder / addressee */
	addresseeName: string;
	/** 11-char BIC code of the bank */
	bic: string;
	/** 11-char company identification number */
	companyIdentificationNumber: string;
	/** 5-char external application code */
	externalApplicationCode: string;
	/** 16-char transaction reference */
	transactionReference: string;
	/** 16-char related file reference */
	relatedReference: string;
	/** Always "2" for CODA 2.x */
	versionCode: VersionCode;
}

// ---------------------------------------------------------------------------
// Record 1 — Old Balance (opening balance)
// ---------------------------------------------------------------------------
/**
 * Record 1: Old balance (opening balance for this statement)
 *
 * Positions (0-indexed):
 *   [0]       = "1" (record type)
 *   [1]       = account structure (AccountStructure)
 *   [2:5]     = statement sequence number (3 digits, zero-padded)
 *   [5:42]    = account info block (37 chars — interpretation depends on [1])
 *   [42]      = sign of old balance (SignCode)
 *   [43:58]   = old balance amount (15 digits: 12 integer + 3 decimal)
 *   [58:64]   = old balance date DDMMYY
 *   [64:90]   = account holder name (26 chars)
 *   [90:125]  = account description (35 chars)
 *   [125:128] = paper statement sequence number (3 digits)
 */
export interface Record1OldBalance {
	recordType: "1";
	accountStructure: AccountStructure;
	/** 3-digit statement sequence number */
	statementSequenceNumber: number;
	accountInfo: AccountInfo;
	/** Sign of the opening balance */
	oldBalanceSign: SignCode;
	/** Amount in cents (smallest currency unit × 1000 for 3 decimal places) */
	oldBalanceAmount: bigint;
	/** DDMMYY */
	oldBalanceDate: string;
	/** Account holder name (26 chars) */
	accountHolderName: string;
	/** Account description / product name (35 chars) */
	accountDescription: string;
	/** 3-digit paper statement sequence */
	paperStatementSequenceNumber: number;
}

// ---------------------------------------------------------------------------
// Record 21 — Transaction (movement) main line
// ---------------------------------------------------------------------------
/**
 * Record 21: Transaction movement - part 1
 *
 * Positions (0-indexed):
 *   [0:2]     = "21" (record type)
 *   [2:6]     = sequence number (4 digits)
 *   [6:10]    = detail number (4 digits, 0000 for first/only, incremented for continuations)
 *   [10:31]   = bank reference (21 chars)
 *   [31]      = sign of amount (SignCode)
 *   [32:47]   = amount (15 digits)
 *   [47:53]   = entry date DDMMYY
 *   [53:61]   = transaction code (8 digits: 1 type + 2 family + 2 operation + 3 category)
 *   [61:115]  = communication (54 chars; structured if type='1': first 3 chars = "+++", etc.)
 *   [115:121] = value date DDMMYY
 *   [121:124] = statement sequence number (3 digits)
 *   [124]     = globalization code (0 = individual, 1-9 = grouped)
 *   [125:127] = blanks / reserved
 *   [127]     = continuation indicator ('0' = no more for this txn, '1' = record 22 follows)
 */
export interface Record21Movement {
	recordType: "21";
	/** 4-digit sequence number (identifies the transaction within the statement) */
	sequenceNumber: number;
	/** 4-digit detail number (0 = main line) */
	detailNumber: number;
	/** 21-char bank reference */
	bankReference: string;
	/** Sign of the transaction amount */
	amountSign: SignCode;
	/** Amount in milli-cents (15 digits: 12 integer + 3 decimal) */
	amount: bigint;
	/** Entry/booking date DDMMYY */
	entryDate: string;
	transactionCode: TransactionCode;
	/** Communication type: '0' = free text, '1' = structured OGM */
	communicationType: CommunicationType;
	/** 53 chars of communication (after the 1-char type indicator at position 61) */
	communication: string;
	/** Value date DDMMYY */
	valueDate: string;
	/** 3-digit statement sequence (back-reference to record 1) */
	statementSequenceNumber: number;
	/** 0 = individual transaction, 1–9 = part of a globalization group */
	globalizationCode: number;
	/** true = record 22 follows for this transaction */
	hasContinuation: boolean;
}

// ---------------------------------------------------------------------------
// Record 22 — Transaction continuation
// ---------------------------------------------------------------------------
/**
 * Record 22: Transaction movement - part 2 (continuation of communication + counterparty BIC)
 *
 * Positions (0-indexed):
 *   [0:2]     = "22" (record type)
 *   [2:6]     = sequence number (same as Record 21)
 *   [6:10]    = detail number (same as Record 21)
 *   [10:63]   = communication continuation (53 chars)
 *   [63:98]   = client reference (35 chars)
 *   [98:109]  = counterparty BIC (11 chars)
 *   [109:112] = blanks
 *   [112]     = transaction type (1 char)
 *   [113:117] = ISO reason return code (4 chars)
 *   [117:121] = category purpose (4 chars)
 *   [121:125] = purpose (4 chars)
 *   [125:127] = blanks / reserved
 *   [127]     = continuation indicator ('0' = no more, '1' = record 23 follows)
 */
export interface Record22MovementContinuation {
	recordType: "22";
	sequenceNumber: number;
	detailNumber: number;
	/** 53-char continuation of communication from Record 21 */
	communicationContinuation: string;
	/** 35-char client/end-to-end reference */
	clientReference: string;
	/** 11-char BIC of counterparty bank */
	counterpartyBic: string;
	/** 1-char transaction type (SEPA purpose) */
	transactionType: string;
	/** 4-char ISO reason return code (used for returned payments) */
	isoReasonReturnCode: string;
	/** 4-char SEPA category purpose */
	categoryPurpose: string;
	/** 4-char SEPA purpose */
	purpose: string;
	/** true = record 23 follows */
	hasContinuation: boolean;
}

// ---------------------------------------------------------------------------
// Record 23 — Transaction end (counterparty info)
// ---------------------------------------------------------------------------
/**
 * Record 23: Transaction movement - part 3 (counterparty account + name + remaining communication)
 *
 * Positions (0-indexed):
 *   [0:2]     = "23" (record type)
 *   [2:6]     = sequence number
 *   [6:10]    = detail number
 *   [10:47]   = counterparty account (37 chars — same layout as Record 1 account block)
 *   [47:82]   = counterparty name (35 chars)
 *   [82:125]  = remaining communication (43 chars)
 *   [125:127] = blanks / reserved
 *   [127]     = end indicator ('0' = more records, '1' = last record for this transaction)
 */
export interface Record23MovementEnd {
	recordType: "23";
	sequenceNumber: number;
	detailNumber: number;
	/** 37-char counterparty account block (same format as Record 1 account block) */
	counterpartyAccountRaw: string;
	/** 35-char counterparty name */
	counterpartyName: string;
	/** 43-char remaining communication */
	remainingCommunication: string;
	/** true = this is the last line for this transaction */
	isLastRecord: boolean;
}

// ---------------------------------------------------------------------------
// Record 31 — Information main line
// ---------------------------------------------------------------------------
/**
 * Record 31: Information (non-financial) - part 1
 *
 * Same structure as Record 21 except no amount/date fields.
 * Informational records relate to a transaction but carry additional text.
 *
 * Positions (0-indexed):
 *   [0:2]     = "31" (record type)
 *   [2:6]     = sequence number (links to the associated Record 21)
 *   [6:10]    = detail number
 *   [10:31]   = bank reference (21 chars)
 *   [31:39]   = transaction code (8 digits)
 *   [39:113]  = communication (74 chars; first char is communication type)
 *   [113:127] = blanks
 *   [127]     = continuation indicator
 */
export interface Record31Information {
	recordType: "31";
	sequenceNumber: number;
	detailNumber: number;
	/** 21-char bank reference */
	bankReference: string;
	transactionCode: TransactionCode;
	communicationType: CommunicationType;
	/** 73 chars of communication text */
	communication: string;
	hasContinuation: boolean;
}

// ---------------------------------------------------------------------------
// Record 32 — Information continuation
// ---------------------------------------------------------------------------
/**
 * Record 32: Information - part 2
 *
 * Positions (0-indexed):
 *   [0:2]     = "32" (record type)
 *   [2:6]     = sequence number
 *   [6:10]    = detail number
 *   [10:115]  = communication continuation (105 chars)
 *   [115:127] = blanks
 *   [127]     = continuation indicator
 */
export interface Record32InformationContinuation {
	recordType: "32";
	sequenceNumber: number;
	detailNumber: number;
	/** 105-char communication continuation */
	communicationContinuation: string;
	hasContinuation: boolean;
}

// ---------------------------------------------------------------------------
// Record 33 — Information end
// ---------------------------------------------------------------------------
/**
 * Record 33: Information - part 3
 *
 * Positions (0-indexed):
 *   [0:2]     = "33" (record type)
 *   [2:6]     = sequence number
 *   [6:10]    = detail number
 *   [10:100]  = communication continuation (90 chars)
 *   [100:127] = blanks
 *   [127]     = end indicator
 */
export interface Record33InformationEnd {
	recordType: "33";
	sequenceNumber: number;
	detailNumber: number;
	/** 90-char communication continuation */
	communicationContinuation: string;
	isLastRecord: boolean;
}

// ---------------------------------------------------------------------------
// Record 4 — Free communication
// ---------------------------------------------------------------------------
/**
 * Record 4: Free-text message (e.g. bank notice)
 *
 * Positions (0-indexed):
 *   [0]       = "4" (record type)
 *   [1]       = blank
 *   [2:6]     = sequence number (4 digits)
 *   [6:10]    = detail number (4 digits)
 *   [10:32]   = blanks
 *   [32:112]  = free text (80 chars)
 *   [112:127] = blanks
 *   [127]     = continuation indicator
 */
export interface Record4FreeMessage {
	recordType: "4";
	sequenceNumber: number;
	detailNumber: number;
	/** 80-char free message text */
	message: string;
	hasContinuation: boolean;
}

// ---------------------------------------------------------------------------
// Record 8 — New Balance (closing balance)
// ---------------------------------------------------------------------------
/**
 * Record 8: New balance (closing balance for this statement)
 *
 * Positions (0-indexed):
 *   [0]       = "8" (record type)
 *   [1:4]     = statement sequence number (3 digits)
 *   [4:41]    = account info block (37 chars — same as Record 1)
 *   [41]      = sign of new balance (SignCode)
 *   [42:57]   = new balance amount (15 digits)
 *   [57:63]   = new balance date DDMMYY
 *   [63:127]  = blanks
 *   [127]     = always '0'
 */
export interface Record8NewBalance {
	recordType: "8";
	statementSequenceNumber: number;
	/** 37-char raw account block (same as in Record 1) */
	accountInfoRaw: string;
	newBalanceSign: SignCode;
	newBalanceAmount: bigint;
	/** DDMMYY */
	newBalanceDate: string;
}

// ---------------------------------------------------------------------------
// Record 9 — Trailer
// ---------------------------------------------------------------------------
/**
 * Record 9: End-of-file trailer
 *
 * Positions (0-indexed):
 *   [0]       = "9" (record type)
 *   [1:16]    = blanks
 *   [16:22]   = number of records (6 digits; excludes Record 0 and Record 9 itself)
 *   [22:37]   = total debit amount (15 digits; sum of all debits, no sign)
 *   [37:52]   = total credit amount (15 digits; sum of all credits, no sign)
 *   [52:127]  = blanks
 *   [127]     = always '1' (end-of-file marker)
 */
export interface Record9Trailer {
	recordType: "9";
	/** Count of all records excluding Record 0 and Record 9 */
	recordCount: number;
	/** Sum of all debit amounts (milli-cents, 15 digits) */
	totalDebit: bigint;
	/** Sum of all credit amounts (milli-cents, 15 digits) */
	totalCredit: bigint;
}

// ---------------------------------------------------------------------------
// Union of all record types
// ---------------------------------------------------------------------------
export type CodaRecord =
	| Record0Header
	| Record1OldBalance
	| Record21Movement
	| Record22MovementContinuation
	| Record23MovementEnd
	| Record31Information
	| Record32InformationContinuation
	| Record33InformationEnd
	| Record4FreeMessage
	| Record8NewBalance
	| Record9Trailer;

// ---------------------------------------------------------------------------
// Top-level statement container
// ---------------------------------------------------------------------------

/**
 * A complete CODA statement as produced by a Belgian bank.
 *
 * The sequence of records in a valid CODA file is:
 *   Record 0  (header)
 *   Record 1  (old balance)
 *   [Record 21 [Record 22] [Record 23]]+  (movements)
 *   [Record 31 [Record 32] [Record 33]]*  (informational lines, optional)
 *   [Record 4]*  (free messages, optional)
 *   Record 8  (new balance)
 *   Record 9  (trailer)
 */
export interface CodaStatement {
	header: Record0Header;
	oldBalance: Record1OldBalance;
	records: Array<
		| Record21Movement
		| Record22MovementContinuation
		| Record23MovementEnd
		| Record31Information
		| Record32InformationContinuation
		| Record33InformationEnd
		| Record4FreeMessage
	>;
	newBalance: Record8NewBalance;
	trailer: Record9Trailer;
}
