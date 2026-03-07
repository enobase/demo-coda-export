# OPEN-QUESTIONS.md

Uncertainties and unresolved questions discovered during implementation. These represent places
where the code makes a reasonable choice but cannot be verified without access to real Belgian
bank CODA files or production accounting software.

---

## CODA specification ambiguities

### Record 0 positions [1:5] vs [5:11] — DDMM vs 0000

Record 0 contains the creation date twice: at positions `[1:5]` (DDMM, 4 chars) and `[5:11]`
(full DDMMYY, 6 chars). The Febelfin CODA 2.6 spec places the creation date (DDMM) at positions
[1:5]; we follow this interpretation and write the date digits there.

However, pycoda's `is_valid_coda()` header-validation regex requires `0000` at positions [1:5].
This means pycoda's validator rejects our output as invalid, even though pycoda's own `parse()`
method handles the file correctly. It is unknown whether Belgian banks ever write `0000` at
[1:5] (treating it as a numeric file sequence or leaving it blank), or whether all banks write
DDMM as specified.

The round-trip tests bypass `is_valid_coda()` and call `parse()` directly. Our interpretation
may be wrong for some software.

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

---

## Whether real Belgian accounting software would accept our output

We have no confirmation that the files produced by this tool can be successfully imported into:

- Exact Online (Belgium)
- Yuki
- BOB50 / Sage BOB
- Isabel Connect
- Any other Belgian accounting or bank reconciliation package

The output passes our own structural validator and pycoda's `parse()` method, but neither can
catch systematic interpretation errors in field positions or transaction code assignments.

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

## N26 column name variations

N26 column names may vary depending on the account language or locale. The parser has been
tested against English-locale exports. German-locale exports may use different column names
(e.g. `Betrag (EUR)` instead of `Amount (EUR)`). Detection relies on `Partner Iban`,
`Account Name`, and `Amount (EUR)` being present; a German-locale export may not be
auto-detected.
