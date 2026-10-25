# Claude Agent SDK (Sonnet 5.5) factory bench - 2026-10-25: BUDGET-STOPPED (FAIL)

CHANGED CONDITIONS vs the Oct-20 gpt-5 baseline: non-code stages (triage/plan/
repro/review) ran as deterministic stubs (FACTORY_STUB_STAGES=1, zero paid
OpenAI calls). NOT apples-to-apples with the full-pipeline baseline; this
measures only the Claude code engine inside the factory harness.

## Outcome
FAIL - no fix produced. Three edit rounds, all stopped by the budget proxy's
hard cap during exploration (~3 forwarded API requests each). No source diff.

## Exact costs (recovered from SDK session transcripts; Sonnet 5.5 rates
## $2/$2.50/$0.20/$10 per MTok input/cache-write/cache-read/output)
| stage | in | cache-w | cache-r | out | cost |
|---|---|---|---|---|---|
| proxy API check (connectivity) | 23 | 0 | 0 | 8 | $0.000126 |
| smoke (SANDBOX_SMOKE_OK, 1 turn, 2.7s SDK) | 2 | 12014 | 0 | 17 | $0.030209 (SDK-reported) |
| bench round 1 (stopped, ~3min) | 2 | 12515 | 0 | 58 | $0.031871 (session-derived) |
| bench round 2 (stopped, 187s, 2 turns) | 2 | 3471 | 9103 | 77 | $0.010362 (SDK) / $0.011272 (session) |
| bench round 3 (killed, ~3min) | 2 | 0 | 12574 | 77 | $0.003289 (session-derived) |
| **TOTAL confirmed actual** | | | | | **$0.0759** |

count_tokens billing status: undocumented (no statement in the owning API
reference); the proxy bound prices input twice to cover it either way.

## Reservation (conservative bound charged pre-forward)
proxy check $0.000146 + smoke $0.3498 (3 forwarded, 2 fast-failed retries) +
bench rounds <= 3 x $0.55 = worst case $2.00, inside the $2.00 user authority.

## Root cause of the bench failure (design issue, now fixed in pipeline)
The hard pre-request bound reserves worst case per request: 8192-token
provider-enforced output ceiling ($0.082) + doubled, padded, cache-write-rated
input (~$0.07 at 12k context) = ~$0.15/request, 15-45x the actual (~$0.01).
A real fix loop needs 10-20 requests; a $0.55 round cap died after ~3.
Two compounding gaps, both fixed:
1. The per-round proxy reset cumulative reservation each round; the pipeline
   gate tracked only ACTUALS across rounds. Now the round's proxy cap carries
   prior rounds' reservation (min(round budget, total - bound so far)).
2. Round caps must be sized against the BOUND structure (~$0.15/request at
   12k context, growing with context), not against expected actuals.
