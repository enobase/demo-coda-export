# SCOPE.md — Trust Boundaries

This document defines what `demo-coda-export` guarantees, what it attempts on a best-effort
basis, and what it explicitly does not support. Read this before using the output in a
production accounting workflow.

---

## Fully tested and guaranteed

The following behaviours are covered by the test suite (611 tests) and are considered reliable.

### CODA record types generated

| Record | What is tested |
|---|---|
| **Record 0 (header)** | All field positions: creation date (DDMMYY), bank ID, application code, duplicate flag, file reference, addressee name (26 chars), BIC (11 chars), company ID (11 chars), external application code, transaction reference, related reference, version code `"2"` at position 127. |
| **Record 1 (old balance)** | IBAN-based accounts (structure `"2"` for Belgian BE IBANs, `"3"` for foreign). Account info block (37 chars), sign code, amount (15 digits), date (DDMMYY), account holder name (26 chars), account description (35 chars), statement sequence. |
| **Record 21 (movement)** | Signed amount, entry date, value date, transaction code (8 digits), communication type and text (53 chars), statement sequence, globalization code, continuation indicator. |
| **Record 22 (continuation)** | Communication overflow (53 chars), client reference (35 chars), counterparty BIC (11 chars), continuation indicator. |
| **Record 23 (movement end)** | Counterparty account block (37 chars), counterparty name (35 chars), remaining communication (43 chars), end indicator. |
| **Record 8 (new balance)** | Closing balance computed as opening balance ± all movements (bigint arithmetic), sign code, date (DDMMYY), account block. |
| **Record 9 (trailer)** | Record count (excludes records 0 and 9), total debit sum (bigint), total credit sum (bigint). |

### Amount serialization

- Amounts are represented as **bigint milli-cents**: `Math.round(|amount| * 1000)` then `BigInt()`.
  This avoids floating-point drift (e.g. `0.1 + 0.2 = 0.30000000000000004` is correctly rounded to `300n`).
- Serialized as 15 digits with no decimal separator (12 integer + 3 decimal places).
  Example: EUR 1234.56 → `000000001234560`.
- Sign is encoded separately: `'0'` = credit (positive), `'1'` = debit (negative). Amounts in
  the amount field are always non-negative.
- Maximum representable amount: 999,999,999,999.999.

### Date formatting

- All dates are serialized as **DDMMYY** (6 digits), e.g. 17 October 2023 → `171023`.
- `Date` objects are formatted using `getUTCDate()`, `getUTCMonth() + 1`, `getUTCFullYear()` —
  UTC methods. The parsers create all dates as UTC midnight (`new Date("YYYY-MM-DDT00:00:00Z")`).
  Using UTC methods ensures the serialized date matches the original calendar date regardless of
  the runtime timezone, including UTC-negative offsets.

### Line length

- Every serialized line is **exactly 128 characters**. An internal `assertLength` check throws
  at serialization time if this invariant is violated.

### Latin-1 encoding

- CODA output is **Latin-1 (ISO-8859-1)** encoded by default. Characters outside the Latin-1
  range (code points above U+00FF) are replaced with `?` before the 128-character line
  constraint is enforced. This matches the encoding used by real Belgian CODA files and
  accounting software from the 1990s–2000s. Accented Latin characters (French, Dutch) in the
  Latin-1 range (e.g. é, à, ü) are preserved unchanged.

### Belgian OGM/VCS structured communication detection and validation

- Strings matching `+++NNN/NNNN/NNNNN+++` or exactly 12 consecutive digits are recognized as
  structured OGM/VCS references.
- The modulo-97 check digit is validated. References with an invalid check digit are treated as
  free text rather than structured communication.
- When valid, communication type is set to `'1'` (structured) and the reference is formatted
  as `+++NNN/NNNN/NNNNN+++` in the communication field of Record 21.

### Fee handling

- When a parsed transaction carries a non-zero `fee` field (Revolut, Wise), a separate debit
  Record 21 is emitted with transaction code family `35` (bank charges) and communication text
  `"Fee: <description>"`. Fee amounts are included in the Record 9 total debit sum and in the
  closing balance computation.

### CSV parsing

- Comma and semicolon delimiters are auto-detected from the header line.
- Quoted fields (double-quote wrapping) and escaped quotes (`""` inside quotes) are handled.
- CRLF and LF line endings are both accepted.
- Whitespace is trimmed from unquoted field values.
- Required columns are validated at parse time; missing columns throw a descriptive error.

### Parser coverage

All five parsers are fully tested:

| Parser | Detection key | Date format |
|---|---|---|
| Revolut Personal | `Started Date` + `State` + `Balance` (no `Beneficiary IBAN`) | `YYYY-MM-DD HH:MM:SS` or `DD Mon YYYY` |
| Revolut Business | `Beneficiary IBAN` in header | `YYYY-MM-DD HH:MM:SS` |
| Qonto | `Settlement date (UTC)` + `Total amount (incl. VAT)` | `YYYY-MM-DDTHH:MM:SS.sssZ` |
| N26 | `Partner Iban` + `Account Name` + `Amount (EUR)` | `YYYY-MM-DD` |
| Wise | `TransferWise ID` | `DD-MM-YYYY` |

---

## Best-effort (not guaranteed)

The following features are implemented but cannot be fully verified without real Belgian bank
CODA samples or access to production accounting software.

### Transaction code mapping (family/operation codes)

The family and operation codes in Record 21 are **approximations** based on the source
transaction type string. Real Belgian banks assign these codes based on internal clearing rules
that are not publicly documented. Our mapping covers Revolut Personal, Revolut Business, Qonto,
N26, and Wise (see [README.md](README.md)) and is a reasonable interpretation, but may not match
what a specific bank would produce for the same transaction type.

N26 type strings may vary by account language or locale (e.g. German-locale exports may use
different values than English-locale exports).

Accounting software that uses these codes for categorization (e.g. BOB50) may behave
differently than expected.

### Category codes

The category field (last 3 digits of the 8-digit transaction code) is always `"000"` (unspecified).
Real bank files use bank-specific category codes that we have no way to reproduce.

### Communication splitting across records 21 → 22 → 23

Free-text communication longer than 53 characters is split across Record 21 (53 chars),
Record 22 (53 chars), and Record 23 (43 chars) for a maximum of 149 characters total.
This mechanical splitting at byte boundaries may cut words in unexpected places. Some
accounting software may join these fields back together; others may not.

---

## Not supported

The following are explicitly **not generated** by this tool.

| Feature | Notes |
|---|---|
| **Information records (31/32/33)** | Not generated. These carry non-financial informational text. |
| **Free communication record (Record 4)** | Not generated. |
| **Globalization codes** | Always `0` (individual transaction). Grouped/batch transactions are not represented. |
| **Multi-account files** | One account per file only. The CODA format supports multiple account sections; we do not. |
| **Non-EUR primary currency** | The pipeline is untested with currencies other than EUR. Amount precision (3 decimal places) should be correct for any ISO 4217 currency, but this has not been verified. |
| **Record 0 file reference** | Always empty. Real banks populate this with their own reference number. |
| **Record 0 transaction reference / related reference** | Always empty. |
| **CODA parsing (reading existing CODA files)** | This tool is a **writer only**. |

---

## What would be needed for production use

The implementation is based on the CODA 2.6 specification as interpreted from open-source
reference parsers (`wimverstuyf/php-coda-parser`). The following steps would be required before
trusting the output in a live accounting environment:

1. **Validation against real CODA files from Belgian banks** — We have no real sample files from
   ING, KBC, BNP Paribas Fortis, Belfius, or other Belgian banks. Field positions are taken from
   the reference parser; subtle differences in how banks fill edge-case fields cannot be ruled out.

2. **Round-trip testing with known CODA parsers** — The test suite includes pycoda round-trip
   tests (see [README.md](README.md)). These tests confirm that pycoda can parse our output and
   that account number, balances, transaction count, amounts, and dates are preserved. However,
   there is a known discrepancy: pycoda's header validation regex expects `0000` at positions
   [1:5], while our serializer writes `DDMM` (per the Febelfin spec). The round-trip tests
   bypass this regex; full pycoda compatibility cannot be claimed.

3. **Verification with actual accounting software** — The CODA file should be imported into Exact,
   Yuki, BOB50, or another Belgian accounting package and the resulting journal entries should be
   checked manually against the source transactions.

4. **Review by someone familiar with Belgian banking regulations** — Transaction codes, company
   identification numbers, BIC formats, and structured communication rules should be reviewed by
   a domain expert.
