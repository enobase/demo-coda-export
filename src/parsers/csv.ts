/**
 * Minimal, zero-dependency CSV parser.
 *
 * Handles:
 *   - Comma and semicolon delimiters (auto-detected from the header line)
 *   - Quoted fields (double-quote wrapping)
 *   - Escaped quotes (two consecutive double-quotes inside a quoted field)
 *   - Empty fields
 *   - Trims whitespace from unquoted field values
 *   - CRLF and LF line endings
 */

export type CsvRow = Record<string, string>;

/**
 * Detect whether the header line uses a semicolon or comma as the field
 * delimiter.  We count occurrences of each outside quoted regions and pick the
 * one that appears more frequently.  Falls back to comma.
 */
export function detectDelimiter(headerLine: string): "," | ";" {
	let inQuotes = false;
	let commas = 0;
	let semis = 0;

	for (let i = 0; i < headerLine.length; i++) {
		const ch = headerLine[i];
		if (ch === '"') {
			// Handle escaped quote ("")
			if (inQuotes && headerLine[i + 1] === '"') {
				i++; // skip the second quote
			} else {
				inQuotes = !inQuotes;
			}
		} else if (!inQuotes) {
			if (ch === ",") commas++;
			else if (ch === ";") semis++;
		}
	}

	return semis > commas ? ";" : ",";
}

/**
 * Parse a single CSV line into an array of raw string values.
 * The line should NOT contain a trailing newline.
 */
export function parseCsvLine(line: string, delimiter: "," | ";", lineNumber?: number): string[] {
	const fields: string[] = [];
	let i = 0;
	const len = line.length;

	while (i <= len) {
		// Start of a new field
		if (i === len) {
			// Trailing delimiter produced an empty last field
			fields.push("");
			break;
		}

		if (line[i] === '"') {
			// Quoted field
			i++; // skip opening quote
			const fieldStart = i;
			let value = "";
			let closedProperly = false;
			while (i < len) {
				const ch = line[i];
				if (ch === '"') {
					if (line[i + 1] === '"') {
						// Escaped quote
						value += '"';
						i += 2;
					} else {
						// Closing quote
						closedProperly = true;
						i++;
						break;
					}
				} else {
					value += ch;
					i++;
				}
			}
			if (!closedProperly) {
				const lineRef = lineNumber !== undefined ? ` line ${lineNumber}:` : "";
				process.stderr.write(
					`Warning:${lineRef} unclosed quoted field starting at position ${fieldStart - 1}\n`,
				);
			}
			fields.push(value);
			// Skip the delimiter (or accept end of line)
			if (i < len && line[i] === delimiter) {
				i++;
			} else if (i >= len) {
				break;
			}
		} else {
			// Unquoted field — read until next delimiter or end of line
			const start = i;
			while (i < len && line[i] !== delimiter) {
				i++;
			}
			fields.push(line.slice(start, i).trim());
			// Skip the delimiter
			if (i < len) {
				i++;
			} else {
				break;
			}
		}
	}

	return fields;
}

export interface ParseCsvOptions {
	/** Override delimiter detection */
	delimiter?: "," | ";";
}

/**
 * Parse CSV content into an array of row objects keyed by the header column
 * names.  Empty lines (after stripping whitespace) are silently ignored.
 *
 * @throws {Error} if the content has no lines at all.
 */
/**
 * Validate that all required columns are present in the actual column list.
 *
 * @throws {Error} listing every missing column name and the parser that
 *   performed the check.
 */
export function validateColumns(
	actualColumns: string[],
	requiredColumns: string[],
	parserName: string,
): void {
	const missing = requiredColumns.filter((col) => !actualColumns.includes(col));
	if (missing.length > 0) {
		throw new Error(
			`${parserName}: missing required column(s): ${missing.map((c) => `"${c}"`).join(", ")}. ` +
				`Found columns: ${actualColumns.map((c) => `"${c}"`).join(", ")}`,
		);
	}
}

/**
 * Parse a raw CSV amount string into a number.
 *
 * Returns 0 for empty strings or lone dashes (common in bank exports for
 * fields that have no value). Throws for genuinely invalid values.
 *
 * @param raw     - The raw string from the CSV cell.
 * @param options - Pass `{ required: true }` to throw when the field is empty
 *                  or a lone dash rather than silently returning 0.
 */
export function parseAmount(raw: string, options?: { required?: boolean }): number {
	const trimmed = raw.trim();
	if (trimmed === "" || trimmed === "-") {
		if (options?.required) {
			throw new Error(`Required amount field is empty or invalid: "${raw}"`);
		}
		return 0;
	}
	const value = Number.parseFloat(trimmed);
	if (Number.isNaN(value)) {
		throw new Error(`Invalid amount value: "${raw}"`);
	}
	if (!Number.isFinite(value)) {
		throw new Error(`Invalid amount value: "${raw}"`);
	}
	return value;
}

/** Normalise an IBAN: strip spaces, uppercase. Returns undefined if empty. */
export function normaliseIban(raw: string): string | undefined {
	const cleaned = raw.replace(/\s+/g, "").toUpperCase();
	return cleaned.length > 0 ? cleaned : undefined;
}

export function parseCsv(content: string, options?: ParseCsvOptions): CsvRow[] {
	// Normalise line endings
	const rawLines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

	// Drop trailing empty lines produced by a final newline in the file
	while (rawLines.length > 0 && rawLines[rawLines.length - 1]?.trim() === "") {
		rawLines.pop();
	}

	if (rawLines.length === 0) {
		throw new Error("CSV content is empty");
	}

	const headerLine = rawLines[0] ?? "";
	const delimiter = options?.delimiter ?? detectDelimiter(headerLine);
	const headers = parseCsvLine(headerLine, delimiter);

	const rows: CsvRow[] = [];

	for (let lineIdx = 1; lineIdx < rawLines.length; lineIdx++) {
		const line = rawLines[lineIdx] ?? "";
		if (line.trim() === "") continue;

		const values = parseCsvLine(line, delimiter, lineIdx + 1);
		const row: CsvRow = {};

		for (let col = 0; col < headers.length; col++) {
			const key = headers[col] ?? `col${col}`;
			row[key] = values[col] ?? "";
		}

		rows.push(row);
	}

	return rows;
}
