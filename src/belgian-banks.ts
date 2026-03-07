/**
 * Belgian Banks — BIC lookup and IBAN utilities
 *
 * Maps 3-digit Belgian bank identification codes (as found in CODA Record 0
 * and in positions 4–6 of a BE IBAN) to their canonical BIC and common names.
 *
 * Sources:
 *   - Febelfin published bank code list
 *   - National Bank of Belgium clearing directory
 */

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export interface BankEntry {
	name: string;
	bic: string;
	aliases: string[];
}

/**
 * Map of 3-digit bank identification code → bank metadata.
 *
 * Keys are zero-padded 3-digit strings (e.g. "001", "068").
 */
export const BELGIAN_BANKS: ReadonlyMap<string, BankEntry> = new Map<string, BankEntry>([
	["539", { name: "KBC", bic: "KREDBEBB", aliases: ["kbc", "kredietbank"] }],
	["310", { name: "ING", bic: "BBRUBEBB", aliases: ["ing", "ing belgium"] }],
	["001", { name: "BNP Paribas Fortis", bic: "GEBABEBB", aliases: ["bnp", "fortis", "bnp paribas"] }],
	["068", { name: "Belfius", bic: "GKCCBEBB", aliases: ["belfius", "dexia"] }],
	["683", { name: "Keytrade", bic: "NICABEBB", aliases: ["keytrade", "keytrade bank"] }],
	["034", { name: "Argenta", bic: "ARSPBE22", aliases: ["argenta"] }],
	["860", { name: "bpost bank", bic: "BMPBBEBB", aliases: ["bpost", "bpost bank", "la poste"] }],
	["103", { name: "ING", bic: "BBRUBEBB", aliases: ["ing", "ing alt"] }],
	["690", { name: "Wise", bic: "TRWIBEB1", aliases: ["wise", "transferwise"] }],
	["097", { name: "CBC", bic: "CREGBEBB", aliases: ["cbc", "cbc banque"] }],
	["143", { name: "AXA Bank / Crelan", bic: "ABORBE22", aliases: ["axa", "crelan", "axa bank"] }],
]);

// ---------------------------------------------------------------------------
// IBAN utilities
// ---------------------------------------------------------------------------

/**
 * Extract the 3-digit bank identification code from a Belgian IBAN.
 *
 * A Belgian IBAN has the structure:
 *   BE<2 check digits><3 bank code digits><7 account digits><2 check digits>
 *
 * The bank code occupies characters at index 4–6 (0-indexed), i.e. positions
 * 5–7 in the conventional 1-indexed notation used by Febelfin.
 *
 * Returns null for non-Belgian IBANs or malformed input.
 */
export function extractBankIdFromIban(iban: string): string | null {
	const normalized = iban.replace(/\s/g, "").toUpperCase();
	if (!normalized.startsWith("BE")) {
		return null;
	}
	// BE + 2 check digits + 3 bank digits = first 7 chars, bank code is [4..6]
	if (normalized.length < 7) {
		return null;
	}
	return normalized.slice(4, 7);
}

// ---------------------------------------------------------------------------
// BIC lookup
// ---------------------------------------------------------------------------

/**
 * Look up the BIC for a given 3-digit bank identification code.
 *
 * Returns null if the bank code is not found in the registry.
 */
export function lookupBic(bankId: string): string | null {
	const entry = BELGIAN_BANKS.get(bankId);
	return entry ? entry.bic : null;
}

// ---------------------------------------------------------------------------
// Name-based fuzzy search
// ---------------------------------------------------------------------------

/**
 * Find a bank by name using case-insensitive substring matching.
 *
 * Matches against the canonical `name` field and all `aliases`.
 * Returns the first match found, or null if no bank matches the query.
 *
 * @example
 * findBankByName("kbc")     // { bankId: "539", bic: "KREDBEBB", name: "KBC" }
 * findBankByName("ING")     // { bankId: "310", bic: "BBRUBEBB", name: "ING" }
 * findBankByName("belfius") // { bankId: "068", bic: "GKCCBEBB", name: "Belfius" }
 */
export function findBankByName(
	query: string,
): { bankId: string; bic: string; name: string } | null {
	const q = query.toLowerCase().trim();
	if (!q) {
		return null;
	}

	for (const [bankId, entry] of BELGIAN_BANKS) {
		const nameMatch = entry.name.toLowerCase().includes(q);
		const aliasMatch = entry.aliases.some((alias) => alias.toLowerCase().includes(q));
		if (nameMatch || aliasMatch) {
			return { bankId, bic: entry.bic, name: entry.name };
		}
	}

	return null;
}
