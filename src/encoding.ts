/**
 * Latin-1 (ISO-8859-1) encoding utilities for CODA output.
 *
 * Real Belgian CODA files use ISO-8859-1 encoding. These helpers ensure
 * that non-Latin-1 characters (e.g. emoji, CJK) are safely replaced before
 * the fixed-width 128-char constraint is enforced, and that the final output
 * is encoded as Latin-1 bytes rather than UTF-8.
 */

/**
 * Convert a Unicode string to a Latin-1-safe string.
 * Characters in the Latin-1 range (U+0000–U+00FF) are kept as-is.
 * Characters outside Latin-1 are replaced with '?'.
 *
 * This is a strict 1:1 code-unit replacement — the returned string always
 * has the same `.length` as the input string (JavaScript strings are
 * sequences of UTF-16 code units). Characters outside the Basic Multilingual
 * Plane (e.g. emoji, some CJK extension blocks) occupy two code units
 * (a surrogate pair); each surrogate individually has a code value above
 * U+00FF and is therefore replaced with its own '?', keeping the length
 * invariant intact.
 *
 * This makes it safe to call before any fixed-width padding or truncation
 * logic that relies on `.length` (such as the CODA 128-char line constraint).
 */
export function toLatin1Safe(str: string): string {
	let result = "";
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i); // UTF-16 code unit value
		result += code <= 0xff ? str[i] : "?";
	}
	return result;
}

/**
 * Encode a string as a Latin-1 Buffer.
 * Calls toLatin1Safe first so that any non-Latin-1 characters are replaced
 * with '?' before encoding — this guarantees that each character maps to
 * exactly one byte in the output Buffer.
 */
export function encodeLatin1(str: string): Buffer {
	const safe = toLatin1Safe(str);
	return Buffer.from(safe, "latin1");
}
