# demo-coda-export

**Free yourself from overpriced Belgian bank CODA exports.**

If you've started a company in Belgium, you know the drill: your accountant needs CODA files — the Belgian standard for coded bank statements. Traditional banks charge up to ~5 EUR/month per account just for this file format conversion. Worse, this dependency locks you into banks with outdated digital infrastructure, when modern neobanks like Revolut, N26, Qonto, and Wise offer far better banking experiences but simply don't generate CODA files.

This tool breaks that loop. Export your transactions as CSV from any supported neobank, run this converter, and hand your accountant a valid CODA file. No legacy bank required.

## Why did we build this

At [Enobase](https://github.com/enobase), we want to shake up how things are done and be on the side of progress — where things ship fast, work reliably, and use the latest tools. We believe people should be free to start their business with a wider choice of banks without being held back by a file format from the 1990s.

This is a **clean-room implementation** based on the [Febelfin CODA 2.6 specification](https://febelfin.be/media/pages/publicaties/2021/gecodeerde-berichtgeving-coda/fd115cfb8b-1694763197/standard-coda-2.6-nl-1.pdf) (the latest published version) and the [EPBF format description](https://www.epbf.be/sites/default/themes/custom/zen_epbf/images/pdf_doc/format_description_CODA.pdf). We independently validated the output using [pycoda](https://github.com/acsone/pycoda) (a Python CODA parser), tested against real CODA exports from Belfius to confirm structural compatibility, and verified the results with an accountant.

**It comes with no guarantees.** This is MIT-licensed open source software. See [SCOPE.md](SCOPE.md) for exactly what is tested and what is best-effort. Contributions welcome.

## What it does

Reads transaction exports (CSV) from 5 neobanks and produces CODA 2.6 files — the fixed-width 128-character-per-line format defined by [Febelfin](https://febelfin.be/en/themes/digitalization-innovation/regulations/a-coda-file-what-is-it-and-what-can-you-use-it-for) and accepted by Belgian accounting software (Exact, Yuki, BOB50, etc.). It is a **writer only**: it does not parse existing CODA files.

## Supported input formats

| Format | Detection key | Columns used |
|---|---|---|
| Revolut Personal CSV | `Started Date`, `Completed Date`, `State`, `Balance` (no `Beneficiary IBAN`) | Type, Completed Date, Description, Amount, Fee, Currency, State, Balance |
| Revolut Business CSV | `Beneficiary IBAN` in header | Date completed (UTC), Type, Description, Reference, Amount, Fee, Currency, Beneficiary IBAN, Beneficiary BIC |
| Qonto CSV (full export) | `Settlement date (UTC)` + `Total amount (incl. VAT)` | Status, Settlement date (UTC), Operation date (UTC), Total amount (incl. VAT), Currency, Counterparty name, Payment method, IBAN, Reference, Category |
| N26 CSV | `Partner Iban` + `Account Name` + `Amount (EUR)` in header | Booking Date, Value Date, Partner Name, Partner Iban, Type, Payment Reference, Amount (EUR) |
| Wise CSV | `TransferWise ID` in header | Date, Amount, Currency, Description, Payment Reference, Running Balance, Payer Name, Payee Name, Payee Account Number, Merchant, Total Fees |

Only settled/completed rows are imported. Pending or failed rows are skipped.

## Quick start

```bash
bun install

# 1. Create a config file (one-time setup)
bun run src/cli.ts init
# → Prompts for IBAN, holder name, currency
# → Auto-derives bank ID and BIC from your IBAN
# → Saves to coda-export.json

# 2. Convert your CSV to CODA
bun run src/cli.ts convert --input transactions.csv --opening-balance 1234.56
# → Auto-loads coda-export.json
# → Infers opening date from CSV
# → Writes transactions.cod

# 3. Validate the output
bun run src/cli.ts validate --input transactions.cod
```

That's it. If you skip step 1, the convert command will interactively prompt for any missing information.

## Getting started

### Config file

Run `coda-export init` to create a config file interactively. It will prompt for your account details and auto-derive what it can from your IBAN.

The config file is automatically discovered at:
1. `./coda-export.json` (project-local, checked first)
2. `~/.coda-export.json` (user-global fallback)

You can also specify a path explicitly with `--config path/to/config.json`.

Example config:
```json
{
  "accountIban": "BE68539007547034",
  "accountHolderName": "ACME BVBA",
  "accountCurrency": "EUR",
  "bankId": "539",
  "bic": "KREDBEBB"
}
```

Note: `openingBalance` and `openingBalanceDate` are **not** stored in the config because they change with every conversion.

### What you need to provide per conversion

| Parameter | Required? | Notes |
|---|---|---|
| `--input` | Yes | Path to your CSV export |
| `--opening-balance` | Yes | Your account balance before the first transaction |
| `--opening-date` | No | Defaults to the day before the earliest transaction |
| `--output` | No | Defaults to `<input-name>.cod` |
| `--bank-id` | No | Auto-derived from Belgian IBANs |
| `--bic` | No | Auto-derived from bank ID |

### Interactive mode

When running in a terminal and required values are missing, the CLI will prompt you instead of erroring:

```
$ bun run src/cli.ts convert --input transactions.csv
  ✓ Bank ID: 539 (derived from IBAN)
  ✓ BIC: KREDBEBB (derived from IBAN)
  Opening balance (e.g. 1234.56): 5000.00
  ✓ Opening date: 2026-02-28 (day before earliest transaction)

  Ready to convert 42 transactions → transactions.cod
```

## Library API

```typescript
import { parseTransactions } from "./src/parsers/index.ts"
import { mapToCoda } from "./src/mapper.ts"
import { serializeCoda } from "./src/serializer.ts"
import type { CodaConfig } from "./src/mapper.ts"

const csvContent = await Bun.file("transactions.csv").text()

const config: CodaConfig = {
  bankId: "539",
  accountIban: "BE68539007547034",
  accountCurrency: "EUR",
  accountHolderName: "ACME BVBA",
  openingBalance: 1234.56,
  openingBalanceDate: new Date("2026-01-01"),
}

const transactions = parseTransactions(csvContent)   // auto-detects format
const statement = mapToCoda(transactions, config)
const coda = serializeCoda(statement)

await Bun.write("statement.cod", coda)
```

For programmatic use via the main entry point:

```typescript
import {
  parseTransactions,
  detectFormat,
  mapToCoda,
  serializeCoda,
  validate,
} from "./src/index.ts"
import type { CodaConfig, BankTransaction, InputParser } from "./src/index.ts"
```

## CODA transaction code mapping

CODA encodes each transaction with an 8-digit code: `type(1) + family(2) + operation(2) + category(3)`.
The `type` field is always `1` (individual transaction). The `category` field is always `000` (unspecified).
Family and operation codes are mapped from the source transaction type as follows:

**Revolut Personal / Revolut Business**

| Source `Type` | Direction | CODA family | CODA operation | Meaning |
|---|---|---|---|---|
| `CARD_PAYMENT` | debit | `43` | `01` | Card payment |
| `TRANSFER` | credit | `01` | `01` | Credit transfer received |
| `TRANSFER` | debit | `01` | `37` | Credit transfer sent |
| `TOPUP` | credit | `01` | `01` | Credit transfer received |
| `EXCHANGE` | any | `41` | `01` | Foreign exchange |
| `FEE` | debit | `35` | `01` | Bank charges / fees |
| _(other)_ | any | `01` | `01` | Credit transfer (fallback) |

**Qonto**

| Source `Payment method` | Direction | CODA family | CODA operation | Meaning |
|---|---|---|---|---|
| `card` | debit | `43` | `01` | Card payment |
| `transfer` | credit | `01` | `01` | Credit transfer received |
| `transfer` | debit | `01` | `37` | Credit transfer sent |
| `direct_debit` | debit | `05` | `01` | Direct debit |
| _(other)_ | any | `01` | `01` | Credit transfer (fallback) |

**N26**

| Source `Type` | Direction | CODA family | CODA operation | Meaning |
|---|---|---|---|---|
| `MasterCard Payment` | debit | `43` | `01` | Card payment |
| `Direct Debit` | debit | `05` | `01` | Direct debit |
| `Credit Transfer` / `Income` | credit | `01` | `01` | Credit transfer received |
| `Outgoing Transfer` | debit | `01` | `37` | Credit transfer sent |
| _(other)_ | any | `01` | `01` | Credit transfer (fallback) |

**Wise**

Wise is primarily a transfer service. All transactions map to family `01`: credits use operation
`01` (transfer received), debits use operation `37` (transfer sent). No card or direct-debit
operations are distinguished.

These mappings are best-effort approximations. See [SCOPE.md](SCOPE.md) for details on what is
and is not guaranteed.

## Adding a new input format

Implement the `InputParser` interface from `src/parsers/types.ts`:

```typescript
import type { InputParser, BankTransaction } from "./types.ts"

export const myBankParser: InputParser = {
  name: "MyBank",
  format: "mybank",        // must be added to the InputFormat union in types.ts

  detect(headerLine: string): boolean {
    // Return true if this header line looks like your format
    return headerLine.includes("MyBank-specific-column")
  },

  parse(content: string): BankTransaction[] {
    // Parse CSV content and return normalised transactions
    // - amount: negative for debits, positive for credits
    // - date: UTC midnight Date objects
    // - source: your format identifier
  },
}
```

Then register it in `src/parsers/index.ts`:

```typescript
import { myBankParser } from "./mybank.ts"

const PARSERS: InputParser[] = [
  wiseParser,
  n26Parser,
  revolutBusinessParser,
  revolutPersonalParser,
  qontoParser,
  myBankParser,   // add here
]
```

Also extend the `InputFormat` type and `BankTransaction.source` union in `src/parsers/types.ts`.

## Output encoding

CODA output is **Latin-1 (ISO-8859-1)** by default. This matches real Belgian CODA files.
Characters outside the Latin-1 range (e.g. emoji, CJK) are replaced with `?` before the
128-character line constraint is enforced. Pass `encoding: 'utf-8'` to `serializeCoda()` to
suppress this sanitization.

## Running tests

```bash
bun test
```

680 tests across 13 files in `src/__tests__/` and `src/parsers/__tests__/`.

## Validation

The `validate` CLI command checks structural correctness (line length, record type sequence,
field positions) of any CODA file.

For pycoda round-trip validation (requires Python and `pip install pycoda`):

```bash
bash scripts/setup-roundtrip.sh   # install pycoda
bun test                          # round-trip tests run automatically when pycoda is available
```

The round-trip tests generate a CODA file from the Revolut Personal fixture, parse it back with
pycoda, and verify that account number, balances, transaction count, amounts, and dates are
preserved. The tests are skipped gracefully when `python3` or `pycoda` is not found.

Note: pycoda's `is_valid_coda()` regex requires positions [1:5] of the header to be `0000`.
Our serializer writes `DDMM` there (per the Febelfin CODA 2.6 spec). The round-trip tests
bypass this regex and call `parse()` directly; see [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) for
details.

## License

MIT — see [LICENSE](LICENSE).

Built with Bun + TypeScript. Zero runtime dependencies.
