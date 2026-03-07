# OPEN-QUESTIONS.md

Uncertainties and unresolved questions discovered during implementation. These represent places
where the code makes a reasonable choice but cannot be verified without access to real Belgian
bank CODA files or production accounting software.

---

## CODA specification ambiguities

### Record 0 positions [1:5] vs [5:11] — date duplication

Record 0 contains the creation date twice: at positions `[1:5]` (DDMM, 4 chars) and `[5:11]`
(full DDMMYY, 6 chars). The DDMM block is the first four characters of the date field, so both
regions encode the same date. The purpose of the apparent duplication is not explained in the
sources consulted. We currently write the DDMM slice at `[1:5]` and the full date at `[5:11]`.

Some CODA samples seen in the wild appear to treat `[1:5]` differently (as a numeric file
sequence or bank reference). No definitive answer was found.

### Record 9 record count — what counts?

The CODA spec says Record 9 contains the number of records, "excluding Record 0 and Record 9
itself." We implement this as: `1 (Record 1) + len(movementRecords) + 1 (Record 8)`.

The spec is silent on whether information records (31/32/33) and free communication records (4)
should be counted differently from movement records. Since we do not generate those, the
question is currently moot. If they are added in the future, the counting logic should be
reviewed.

### Whether Record 22 is required when Record 23 is present

The mapper always emits a Record 22 when a Record 23 is needed (even when there is no
communication overflow or counterparty BIC). This is consistent with the continuation indicator
chain: Record 21 sets `hasContinuation = 1` to signal Record 22 follows, and Record 22 sets
`hasContinuation = 1` to signal Record 23 follows. Whether a real bank would omit Record 22 and
go straight from 21 to 23 is unknown.

---

## Amount precision

### Three decimal places for EUR (which has 2)

CODA uses 3 decimal places for all currencies regardless of the currency's natural precision.
For EUR (2 decimal places), this means amounts like EUR 42.50 are encoded as `42500` in the
15-digit field (i.e. 42.500). The last digit will always be `0` for EUR transactions coming from
neobank exports. This appears to be by design in the CODA spec but has not been confirmed
against real files.

### Floating-point rounding at the boundary

We use `Math.round(|amount| * 1000)` to convert to milli-cents. This is correct for amounts with
at most 3 significant decimal digits. Amounts with more decimal digits (which should not appear
in financial data but could in test fixtures) are silently rounded to the nearest milli-cent.

---

## Character encoding

### UTF-8 vs Latin-1 in real CODA files

Belgian accounting software from the 1990s–2000s used Latin-1 (ISO-8859-1) character encoding.
The CODA spec predates Unicode. Real CODA files from Belgian banks are likely Latin-1 encoded.

This tool writes UTF-8. If a counterparty name or description contains non-ASCII characters
(accented letters common in French and Dutch), the output will be valid UTF-8 but may not be
accepted by software that expects Latin-1, or may display incorrectly if software opens the file
with the wrong encoding.

No attempt is made to transliterate or drop non-ASCII characters.

---

## Date and timezone handling

### Local time vs UTC in formatDate()

The `formatDate()` function uses `Date.getDate()`, `Date.getMonth()`, and `Date.getFullYear()` —
which are local-time methods, not UTC. The parsers create all dates as UTC midnight
(`new Date("YYYY-MM-DDT00:00:00Z")`). When `formatDate()` is called in a timezone with a
negative UTC offset (e.g. UTC-5), a UTC-midnight date will appear as the previous calendar day
in local time, producing an off-by-one date in the CODA output.

In practice, Belgian accounting software runs in CET/CEST (UTC+1/UTC+2), so this is not an
issue for the intended deployment. But it is a latent bug for users running the tool in
UTC-negative timezones.

---

## Whether real Belgian accounting software would accept our output

We have no confirmation that the files produced by this tool can be successfully imported into:

- Exact Online (Belgium)
- Yuki
- BOB50 / Sage BOB
- Isabel Connect
- Any other Belgian accounting or bank reconciliation package

The output passes our own structural validator but that validator was written alongside the
serializer and tests the same field positions, so it cannot catch systematic interpretation
errors.

---

## Qonto CSV column names

The Qonto parser comment notes that column names "may vary slightly between export versions."
The parser uses the following column names literally:

- `Settlement date (UTC)`
- `Operation date (UTC)`
- `Total amount (incl. VAT)`
- `Counterparty name`
- `Payment method`
- `Transaction ID`
- `IBAN`
- `Reference`
- `Category`

If Qonto changes any of these names in a future export version, the parser will silently produce
empty values for those fields rather than throwing an error.

---

## Revolut date format variations

The Revolut Personal parser handles two date formats:

1. `YYYY-MM-DD HH:MM:SS` — ISO-style with time
2. `DD Mon YYYY` — Human-readable (e.g. `15 Jan 2024`)

It is not known whether other locale-specific formats exist (e.g. `MM/DD/YYYY` for US-locale
exports, or formats with non-English month abbreviations). Encountering an unrecognised format
throws an error.

---

## Fee handling

Both Revolut parsers parse the `Fee` column into `BankTransaction.fee`. However, this fee
amount is **not** mapped into a separate CODA transaction. It is stored in the `BankTransaction`
but the mapper ignores it. This means:

1. The running balance in the CODA output may not match the source balance column exactly if
   fees are significant.
2. Accounting software that reconciles against a bank balance may find discrepancies.

The correct treatment of fees (separate debit transaction vs. folded into the main transaction
amount) depends on how the bank actually books them, which varies by institution.

---

## OGM/VCS check digit validation

The OGM/VCS structured communication format includes a 2-digit check digit embedded in the
reference number. This tool detects the pattern `+++NNN/NNNN/NNNNN+++` and treats it as
structured communication, but does **not** validate the check digit. A reference with an invalid
check digit will be passed through and marked as structured communication type `'1'`.
