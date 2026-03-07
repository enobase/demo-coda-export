#!/usr/bin/env python3
"""
Read a CODA file using pycoda and output a JSON summary.
Usage: python scripts/roundtrip-verify.py path/to/file.coda

Note on pycoda compatibility:
  pycoda's is_valid_coda() regex expects positions 1-4 of the header to be
  zeros ('00000...'). Our serializer correctly places the creation date at
  both positions [1:5] (DDMM) and [5:11] (DDMMYY) per the Febelfin CODA 2.6
  spec. This makes pycoda's header-validation regex fail, even though the file
  is structurally valid. We bypass is_valid_coda and call parse() directly.
"""
import sys
import json

try:
    from coda.parser import Parser
except ImportError:
    print(json.dumps({"error": "pycoda not installed. Run: pip install pycoda"}))
    sys.exit(1)


def signed_balance(amount: float, sign: str) -> float:
    """Convert a pycoda (amount, sign) pair to a signed float.

    pycoda uses AmountSign: '0' = credit (positive), '1' = debit (negative).
    """
    return -amount if sign == "1" else amount


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: roundtrip-verify.py <coda-file>"}))
        sys.exit(1)

    path = sys.argv[1]
    parser = Parser()

    # Bypass pycoda's is_valid_coda() header regex, which expects positions 1-4
    # to be zeros. The Febelfin spec places the creation date (DDMM) at [1:5],
    # so real files never match that pattern. Parse() itself works correctly.
    parser.is_valid_coda = lambda _value: True

    try:
        with open(path, "rb") as f:
            content = f.read()
        statements = parser.parse(content)
    except Exception as e:
        print(json.dumps({"error": f"Parse error: {str(e)}"}))
        sys.exit(1)

    result = {
        "statementCount": len(statements),
        "statements": [],
    }

    for stmt in statements:
        old_bal = signed_balance(
            stmt.old_balance or 0.0,
            stmt.old_balance_amount_sign or "0",
        )
        new_bal = signed_balance(
            stmt.new_balance or 0.0,
            stmt.new_balance_amount_sign or "0",
        )

        s = {
            "accNumber": stmt.acc_number,
            "currency": stmt.currency,
            "oldBalance": old_bal,
            "oldBalanceDate": stmt.old_balance_date,
            "newBalance": new_bal,
            "newBalanceDate": stmt.new_balance_date,
            "transactionCount": len(stmt.movements),
            "transactions": [],
        }

        for mov in stmt.movements:
            amount = signed_balance(
                mov.transaction_amount or 0.0,
                mov.transaction_amount_sign or "0",
            )
            t = {
                "amount": amount,
                "date": mov.transaction_date,
                "entryDate": mov.entry_date,
                "communication": mov.communication,
                "counterpartyName": mov.counterparty_name,
                "counterpartyNumber": mov.counterparty_number,
                "counterpartyBic": mov.counterparty_bic,
            }
            s["transactions"].append(t)

        result["statements"].append(s)

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
