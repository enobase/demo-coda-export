/**
 * CODA Structural Comparison
 *
 * Compares two CODA files on metadata and structural patterns only.
 * NO amounts, NO names, NO account numbers, NO PII are extracted or reported.
 */

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface CodaFileStats {
	/** Total number of non-empty lines */
	lineCount: number;
	/** Whether every line is exactly 128 characters */
	allLines128: boolean;
	/** Version code from position [127] of Record 0, or null if not present */
	versionCode: string | null;
	/** Account structure code from position [1] of Record 1, or null if not present */
	accountStructureCode: string | null;
	/** Count of each record type encountered (keyed by record type string: "0", "1", "21", etc.) */
	recordTypeCounts: Map<string, number>;
	/** Unique transaction code families from positions [53:55] of Record 21 lines */
	transactionCodeFamilies: string[];
	/** Count of each communication type from position [61] of Record 21 lines */
	communicationTypeCounts: Map<string, number>;
	/** Whether Record 22 always appears between every Record 21 and Record 23 */
	record22ChainAlwaysPresent: boolean;
	/** Detected file encoding */
	encoding: "Latin-1" | "UTF-8" | "unknown";
}

export interface ComparisonReport {
	reference: CodaFileStats;
	generated: CodaFileStats;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const CODA_LINE_LENGTH = 128;

/**
 * Determine the record type token for a given line.
 * Returns e.g. "0", "1", "21", "22", "23", "31", "32", "33", "4", "8", "9".
 */
function recordType(line: string): string {
	if (line.length < 2) return line[0] ?? "?";
	const firstChar = line[0]!;
	// Multi-character record types start with 2, 3, or 4
	if (firstChar === "2" || firstChar === "3") {
		return line.slice(0, 2);
	}
	return firstChar;
}

/**
 * Detect encoding by scanning raw bytes.
 * If any byte is in the 0x80-0xFF range and the content is NOT valid UTF-8,
 * we classify it as Latin-1.
 */
function detectEncoding(rawBytes: Uint8Array): "Latin-1" | "UTF-8" | "unknown" {
	// Check for bytes in the high range
	let hasHighBytes = false;
	for (const byte of rawBytes) {
		if (byte > 0x7f) {
			hasHighBytes = true;
			break;
		}
	}

	if (!hasHighBytes) {
		// Pure ASCII — compatible with both, but typically UTF-8 in modern contexts
		return "UTF-8";
	}

	// Try to decode as UTF-8
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
		return "UTF-8";
	} catch {
		// Decoding as UTF-8 failed — must be Latin-1 (or similar single-byte encoding)
		return "Latin-1";
	}
}

// ---------------------------------------------------------------------------
// analyzeFile()
// ---------------------------------------------------------------------------

/**
 * Analyze a CODA file and extract structural statistics.
 * The rawBytes parameter is used for encoding detection only.
 * The content string is used for all structural analysis.
 */
export function analyzeFile(content: string, rawBytes?: Uint8Array): CodaFileStats {
	// Normalize line endings and split
	const rawLines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const lines = rawLines[rawLines.length - 1] === "" ? rawLines.slice(0, -1) : rawLines;

	const lineCount = lines.length;
	const allLines128 = lines.every((l) => l.length === CODA_LINE_LENGTH);

	// Version code: position [127] of Record 0 (first line starting with "0")
	let versionCode: string | null = null;
	const headerLine = lines.find((l) => l[0] === "0" && l.length === CODA_LINE_LENGTH);
	if (headerLine) {
		versionCode = headerLine[127] ?? null;
	}

	// Account structure code: position [1] of Record 1
	let accountStructureCode: string | null = null;
	const balanceLine = lines.find((l) => l[0] === "1" && l.length === CODA_LINE_LENGTH);
	if (balanceLine) {
		accountStructureCode = balanceLine[1] ?? null;
	}

	// Count record types
	const recordTypeCounts = new Map<string, number>();
	for (const line of lines) {
		if (line.length === 0) continue;
		const rt = recordType(line);
		recordTypeCounts.set(rt, (recordTypeCounts.get(rt) ?? 0) + 1);
	}

	// Transaction code families: positions [53:55] of Record 21 lines
	const familySet = new Set<string>();
	// Communication types: position [61] of Record 21 lines
	const commTypeCounts = new Map<string, number>();

	for (const line of lines) {
		if (!line.startsWith("21") || line.length !== CODA_LINE_LENGTH) continue;
		// Transaction code family
		const family = line.slice(53, 55);
		if (/^\d{2}$/.test(family)) {
			familySet.add(family);
		}
		// Communication type
		const commType = line[61];
		if (commType === "0" || commType === "1") {
			commTypeCounts.set(commType, (commTypeCounts.get(commType) ?? 0) + 1);
		}
	}

	const transactionCodeFamilies = Array.from(familySet).sort();

	// Record 22 chain pattern
	// For each Record 21, check if a Record 22 appears before Record 23
	// Pattern: 21 → (22 →)? 23
	// We consider "always present" if every 21 is followed by a 22 before the closing 23.
	let record22ChainAlwaysPresent = true;
	{
		let i = 0;
		let saw21 = false;
		while (i < lines.length) {
			const line = lines[i]!;
			if (line.startsWith("21") && line.length === CODA_LINE_LENGTH) {
				saw21 = true;
				// Look ahead
				const next = lines[i + 1];
				if (next?.startsWith("23")) {
					// 21 → 23 directly, no 22 in between
					record22ChainAlwaysPresent = false;
				}
			}
			i++;
		}
		// If there were no Record 21 lines at all, the chain pattern is N/A —
		// we leave it as true to avoid misleading output.
		if (!saw21) {
			record22ChainAlwaysPresent = true;
		}
	}

	// Encoding detection
	const encoding = rawBytes ? detectEncoding(rawBytes) : "unknown";

	return {
		lineCount,
		allLines128,
		versionCode,
		accountStructureCode,
		recordTypeCounts,
		transactionCodeFamilies,
		communicationTypeCounts: commTypeCounts,
		record22ChainAlwaysPresent,
		encoding,
	};
}

// ---------------------------------------------------------------------------
// formatReport()
// ---------------------------------------------------------------------------

/** Labels for the known record types in display order */
const RECORD_TYPE_LABELS: Array<[string, string]> = [
	["0", "Record 0  (header)     "],
	["1", "Record 1  (old balance)"],
	["21", "Record 21 (movement)   "],
	["22", "Record 22 (cont.)      "],
	["23", "Record 23 (end)        "],
	["31", "Record 31 (info)       "],
	["32", "Record 32 (info cont.) "],
	["33", "Record 33 (info end)   "],
	["4", "Record 4  (free comm.) "],
	["8", "Record 8  (new balance)"],
	["9", "Record 9  (trailer)    "],
];

function col(value: string | number | null | undefined, width = 12): string {
	const s = value == null ? "—" : String(value);
	return s.padEnd(width);
}

function yesNo(value: boolean): string {
	return value ? "yes" : "no";
}

/**
 * Format a ComparisonReport as a human-readable string.
 * Contains NO PII, amounts, names, or account numbers.
 */
export function formatReport(report: ComparisonReport): string {
	const { reference: ref, generated: gen } = report;

	const lines: string[] = [];

	lines.push("=== Structural CODA Comparison ===");
	lines.push("");
	lines.push(`${"".padEnd(26)}${"Reference".padEnd(13)}Generated`);
	lines.push(`${"Lines".padEnd(26)}${col(ref.lineCount)}${gen.lineCount}`);
	lines.push(
		`${"All lines 128 chars".padEnd(26)}${col(yesNo(ref.allLines128))}${yesNo(gen.allLines128)}`,
	);
	lines.push(
		`${"Version code (Rec 0)".padEnd(26)}${col(ref.versionCode ?? "—")}${gen.versionCode ?? "—"}`,
	);
	lines.push(
		`${"Account structure".padEnd(26)}${col(ref.accountStructureCode ?? "—")}${gen.accountStructureCode ?? "—"}`,
	);

	lines.push("");
	lines.push("Record type counts:");
	for (const [rt, label] of RECORD_TYPE_LABELS) {
		const refCount = ref.recordTypeCounts.get(rt);
		const genCount = gen.recordTypeCounts.get(rt);
		if (refCount === undefined && genCount === undefined) continue;
		lines.push(`  ${label}  ${col(refCount ?? 0)}${genCount ?? 0}`);
	}

	lines.push("");
	lines.push("Transaction code families:");
	lines.push(
		`  Reference: ${ref.transactionCodeFamilies.length > 0 ? ref.transactionCodeFamilies.join(", ") : "(none)"}`,
	);
	lines.push(
		`  Generated: ${gen.transactionCodeFamilies.length > 0 ? gen.transactionCodeFamilies.join(", ") : "(none)"}`,
	);

	lines.push("");
	lines.push("Communication types:");
	{
		const refFree = ref.communicationTypeCounts.get("0") ?? 0;
		const refStruct = ref.communicationTypeCounts.get("1") ?? 0;
		const genFree = gen.communicationTypeCounts.get("0") ?? 0;
		const genStruct = gen.communicationTypeCounts.get("1") ?? 0;
		lines.push(`  Reference: 0 (free): ${refFree}, 1 (structured): ${refStruct}`);
		lines.push(`  Generated: 0 (free): ${genFree}, 1 (structured): ${genStruct}`);
	}

	lines.push("");
	lines.push("Record 22 chain:");
	lines.push(
		`  Reference: ${ref.record22ChainAlwaysPresent ? "always present between 21 and 23" : "21→23 direct jumps exist (22 sometimes absent)"}`,
	);
	lines.push(
		`  Generated: ${gen.record22ChainAlwaysPresent ? "always present between 21 and 23" : "21→23 direct jumps exist (22 sometimes absent)"}`,
	);

	lines.push("");
	lines.push("Encoding:");
	lines.push(`  Reference: ${ref.encoding}`);
	lines.push(`  Generated: ${gen.encoding}`);

	lines.push("");

	return lines.join("\n");
}
