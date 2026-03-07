# Testing Guide

Real-world validation instructions for the `coda-export` CODA converter.

---

## Section 1: Validating with real Belfius CODA files

### Step-by-step

1. Log into BelfiusWeb (https://www.belfius.be), navigate to your account, and open the **Statements** or **CODA download** section.

2. Download CODA files for a known date range — choose a period where you know the exact opening balance, number of transactions, and closing balance. Save the files to a directory **outside** this repository, for example:

   ```
   ~/private-bank-data/belfius-2026-01.cod
   ```

   The directory must never be inside `demo-coda-export/`. This is enforced by `.gitignore` for common paths, but the safest approach is to keep the files entirely outside the repo.

3. Validate the structure of the real bank file:

   ```bash
   bun run src/cli.ts validate --input ~/private-bank-data/belfius-2026-01.cod
   ```

   A clean file will print a success message. Any errors or warnings indicate structural problems worth noting for comparison.

4. Generate your own CODA from a neobank CSV export covering a similar period:

   ```bash
   bun run src/cli.ts convert \
     --input ~/private-bank-data/revolut-jan.csv \
     --config account.json \
     --output ~/private-bank-data/our-output.cod
   ```

5. Compare the two files structurally:

   ```bash
   bun run src/cli.ts compare \
     --reference ~/private-bank-data/belfius-2026-01.cod \
     --generated ~/private-bank-data/our-output.cod
   ```

6. The comparison output is **safe to share** — it contains no PII, amounts, or account numbers. You can paste it into a bug report or GitHub issue without redaction.

7. What to look for in the comparison (see Section 3 for the full checklist).

---

## Section 2: Validating with neobank CSV exports

### Revolut (Personal and Business), Qonto, N26, Wise

For each neobank:

1. Export a CSV statement from the neobank dashboard for a period with a **known** number of transactions, opening balance, and closing balance.

2. Note down before converting:
   - The opening balance at the start of the period
   - The total number of transactions
   - The closing balance at the end of the period

3. Convert the CSV to CODA:

   ```bash
   bun run src/cli.ts convert \
     --input export.csv \
     --config account.json \
     --output test.cod
   ```

   Or with flags instead of a config file:

   ```bash
   bun run src/cli.ts convert \
     --input export.csv \
     --account-iban BE68539007547034 \
     --account-holder "My Name" \
     --bank-id 539 \
     --opening-balance 1234.56 \
     --opening-date 2026-01-01 \
     --output test.cod
   ```

4. Validate the generated CODA:

   ```bash
   bun run src/cli.ts validate --input test.cod
   ```

   The file must validate cleanly before proceeding.

5. Manual spot-checks — open `test.cod` in a text editor and verify:
   - The line count matches the expected record count (header + old balance + 3 records per transaction + new balance + trailer)
   - A few transaction amounts (positions 32-46 of Record 21 lines) match your known values
   - The closing balance (Record 8, positions 5-19) matches the expected closing balance

6. If you have a `pycoda` environment set up:

   ```bash
   python scripts/roundtrip-verify.py test.cod
   ```

   This parses the generated CODA with pycoda and cross-checks the amounts and record structure.

---

## Section 3: What the comparison reveals (without disclosing data)

Use this checklist when reviewing the output of `coda-export compare`:

- **Record 22 chain**: Does the real bank always include a Record 22 between every Record 21 and Record 23? Our tool always generates Record 22. If the bank sometimes skips it (direct 21 -> 23), we may need to make Record 22 optional.

- **Transaction code families**: Our tool maps neobank transaction types to a small set of CODA transaction families (01, 05, 35, 41, 43). Are there families used by the real bank that we do not generate? If so, those transaction types are not yet mapped and may need attention.

- **Communication types**: Does the real bank use structured communications (type `1`, e.g. Belgian payment references `+++xxx/xxxx/xxxxx+++`)? Our tool generates structured communications when the description matches the `+++` format. The comparison shows how often each type appears in each file.

- **Encoding**: CODA files from Belgian banks are expected to be Latin-1 (ISO-8859-1). If the comparison reports UTF-8 for the reference file, the bank may have changed encoding — which would affect accent handling in counterparty names.

- **Line endings**: Not shown in the comparison output, but verifiable with `xxd` or a hex editor. Belgian banks use LF (`\n`). Our tool also uses LF. CRLF would indicate a Windows-style export.

- **Record 0 positions [1:5]**: Our tool fills this with `DDMM` of the creation date. Some implementations use `0000`. If the real bank file uses a different pattern, note it for future consideration. The comparison does not currently expose this field directly.

- **Version code**: Should be `2` in both files. A mismatch indicates a format version discrepancy.

- **Account structure code**: Position [1] of Record 1. Belgian account structures use code `0` (Belgian account), `1` (foreign account), or `2` (IBAN). A mismatch may indicate a different account type convention.

---

## Section 4: Format landscape and generalizability

### Why CSV and not JSON/JSONL

CSV is the universal lowest-common-denominator export format across all neobanks studied (Revolut, Qonto, N26, Wise, Bunq). Every neobank dashboard offers a CSV download without requiring API access or developer credentials.

No neobank offers JSONL as a direct statement download format.

### APIs and JSON

Some neobanks expose APIs (Wise, Revolut Business, N26 unofficial) that return JSON. However:

- Using these APIs requires OAuth tokens or API keys — not file-based input
- The `InputParser` interface in `src/parsers/index.ts` is format-agnostic: a JSON parser could be added if someone writes an API integration layer that fetches transactions and writes them to a JSON/JSONL file
- The fundamental constraint is that neobank exports (whether CSV or JSON) do not contain CODA-specific metadata: bank identification numbers, precise CODA transaction codes, counterparty BIC/IBAN in CODA format, and so on. Mapping is always best-effort

### The mapping limitation

CODA is a Belgian interbank format with a rich taxonomy of transaction codes, counterparty identifiers, and structured references. Neobank exports contain a plain description field and a signed amount. The converter maps:

- Description -> CODA communication field (free or structured, depending on format)
- Amount sign -> CODA debit/credit indicator
- Transaction type (where available) -> CODA transaction family code
- Date -> CODA value date and entry date

Fields that cannot be reliably derived from neobank exports: exact CODA transaction sub-type, counterparty bank code, sequence numbers within a bank day.

---

## Section 5: Handling sensitive test data safely

### Golden rules

- **Never commit real bank data to this repository.** CODA files from real banks contain account numbers, transaction amounts, counterparty names, and communication references. These are PII and must be treated as confidential.

- Keep real bank files in a directory entirely outside the repository, such as `~/private-bank-data/` or a separately encrypted volume.

- The `.gitignore` in this repo excludes `*.cod` at the root level, but this is not a substitute for keeping files outside the repo.

### Safe sharing

- The output of `bun run src/cli.ts compare ...` contains **no PII**. It is safe to include in bug reports, GitHub issues, and team discussions.

- When filing a bug, include the `compare` output but **never** include the CODA file itself, a screenshot of the CODA file, or any hex dump of real bank data.

### Automated CI

- The CI pipeline (if configured) runs `bun test` against synthetic fixture files only. These are located in `src/parsers/__tests__/fixtures/` and `src/__tests__/fixtures/`. They are generated from fictitious data and contain no real account numbers or transaction amounts.

- Do not add real bank files to the `fixtures/` directories. Use `buildValidCoda()` or similar helpers from `src/__tests__/validator.test.ts` to generate synthetic test data programmatically.

### Revoking access

If real bank data is accidentally committed:

1. Remove it immediately with `git rm --cached <file>` and commit the removal
2. Rewrite history with `git filter-branch` or the BFG Repo Cleaner to purge the file from all commits
3. Force-push to all remotes (coordinate with the team first)
4. Consider rotating any credentials or account details that appeared in the file
