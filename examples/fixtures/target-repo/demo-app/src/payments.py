"""Demo payments client for the fictional PayDemo provider.

This file intentionally contains a FAKE leaked API key so the triage-agent
demo has something to find. PayDemo does not exist and the key is not real.
"""


# LEAK: a live-looking key hardcoded in source. This is what a secret
# scanner would flag. The triage agent starts from here.
PAYDEMO_API_KEY = "paydemo_live_f4k3d3m0_1a2b3c4d5e6f7g8h9i0"


def charge_card(amount_cents: int, currency: str = "usd") -> dict:
    """Charge a card through PayDemo (demo: no real request is made)."""
    return {
        "status": "ok",
        "amount_cents": amount_cents,
        "currency": currency,
        "auth_header": f"Bearer {PAYDEMO_API_KEY}",
    }
