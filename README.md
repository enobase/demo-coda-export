# demo-coda-export

Convert neobank CSV exports to Belgian CODA bank statement format.

This tool reads transaction exports from Revolut Personal, Revolut Business, and Qonto and
produces CODA 2.6 files — the fixed-width 128-character-per-line format defined by Febelfin and
accepted by Belgian accounting software (Exact, Yuki, BOB50, etc.). It is a **writer only**: it
does not parse existing CODA files.

## Supported input formats

| Format | Detection key | Columns used |
|---|---|---|
| Revolut Personal CSV | `Started Date`, `Completed Date`, `State`, `Balance` (no `Beneficiary IBAN`) | Type, Completed Date, Description, Amount, Fee, Currency, State, Balance |
| Revolut Business CSV | `Beneficiary IBAN` in header | Date completed (UTC), Type, Description, Reference, Amount, Fee, Currency, Beneficiary IBAN, Beneficiary BIC |
| Qonto CSV (full export) | `Settlement date (UTC)` + `Total amount (incl. VAT)` | Status, Settlement date (UTC), Operation date (UTC), Total amount (incl. VAT), Currency, Counterparty name, Payment method, IBAN, Reference, Category |

Only settled/completed rows are imported. Pending or failed rows are skipped.

## Quick start

```bash
# Install dependencies
bun install

# Convert with a config file
bun run src/cli.ts convert --input transactions.csv --config account.json

# Convert with CLI flags
bun run src/cli.ts convert --input transactions.csv \
  --account-iban BE68539007547034 \
  --account-holder "ACME BVBA" \
  --bank-id 539 \
  --opening-balance 1234.56 \
  --opening-date 2026-01-01 \
  --output statement.cod

# Validate a CODA file
bun run src/cli.ts validate --input statement.cod

# Show all options
bun run src/cli.ts --help
bun run src/cli.ts convert --help
```

## Config file format

Pass `--config account.json` to avoid repeating flags. CLI flags override config file values.

```json
{
  "bankId": "539",
  "accountIban": "BE68539007547034",
  "accountCurrency": "EUR",
  "accountHolderName": "ACME BVBA",
  "accountDescription": "Business current account",
  "bic": "KREDBEBB",
  "companyId": "0123456789",
  "statementSequence": 1,
  "openingBalance": 1234.56,
  "openingBalanceDate": "2026-01-01"
}
```

All fields except `openingBalance` and `openingBalanceDate` are optional when the
corresponding CLI flags are provided. `accountCurrency` defaults to `"EUR"` if omitted.

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
  revolutBusinessParser,
  revolutPersonalParser,
  qontoParser,
  myBankParser,   // add here
]
```

Also extend the `InputFormat` type and `BankTransaction.source` union in `src/parsers/types.ts`.

## Running tests

```bash
bun test
```

428 tests, all in `src/__tests__/` and `src/parsers/__tests__/`.

## License

MIT
