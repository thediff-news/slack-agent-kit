"""Refunds worker. Reads the PayDemo key from the environment, which is the
pattern the rotation PR moves the leaked client to."""
import os

PAYDEMO_API_KEY = os.environ.get("PAYDEMO_API_KEY", "")


def refund(transaction_id: str) -> dict:
    if not PAYDEMO_API_KEY:
        raise RuntimeError("PAYDEMO_API_KEY is not configured")
    return {"status": "refunded", "transaction_id": transaction_id}
