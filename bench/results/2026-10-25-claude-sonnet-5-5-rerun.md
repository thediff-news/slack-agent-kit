# Claude Agent SDK (Sonnet 5.5) factory bench RERUN - 2026-10-25: FIX PRODUCED + INDEPENDENTLY VERIFIED

Rerun of the morning's budget-stopped bench after config fixes (7474415 env
output ceiling + edit rounds; 2d24383 stub-repro socket teardown). Same task
as the Oct-20 gpt-5 baseline and the opencode spike: HttpPlanner fetch has no
timeout. Same PASS standard: suite green + independent fix check. Non-code
stages still deterministic stubs (changed conditions vs full-pipeline
baseline).

## Outcome
The Claude code stage produced the fix inside two edit rounds; both rounds
were then terminated by the budget proxy's reservation 429 (the bound, not
actual spend). The diff in the factory worktree:

  src/browse/planner.ts +13/-1 - wrap the planner fetch in an AbortController
  driven by BROWSE_MODEL_TIMEOUT_MS (default 60000); on abort return
  { kind: "fail", reason: "planner request timeout: timed out after <ms>ms" }
  instead of hanging forever.

## Independent verification (outside the agent loop)
- repro RED on base: "plan() hung past 5s despite BROWSE_MODEL_TIMEOUT_MS=400"
  (caught by the test's own 5s watchdog at 5.016s; no harness kill needed)
- repro GREEN on fixed: 414 ms
- full suite on fixed tree: 77/77 pass, 0 fail, 30.4s
  (`npx tsx --test tests/*.test.ts`, repro included as test #53), exit 0

## Round terminations (reservation bound, not actuals)
- round 1 (session 18e035ed): 7 tool turns, stopped by proxy 429
  "bound $0.1831 would exceed cumulative cap $1.5 (bound so far $1.4186)"
- round 2 (session 1bade2eb): 7 tool turns, stopped by proxy 429 while
  re-running the suite to inspect one failing test

## Exact costs (session-derived; Sonnet 5.5 rates $2/$2.50/$0.20/$10 per MTok)
| round | in | cache-w | cache-r | out | cost |
|---|---|---|---|---|---|
| round 1 (18e035ed) | 20 | 21409 | 128761 | 2156 | $0.100875 |
| round 2 (1bade2eb) | 20 | 53383 | 99940 | 1605 | $0.169536 |
| **rerun total actual** | | | | | **$0.270411** |
| first bench (budget-stopped FAIL, earlier same day) | | | | | $0.0759 |
| **bench total actual** | | | | | **$0.3463** |

Session transcripts archived: .bench-evidence/factory-IfNiWT/*.jsonl

## Structural finding (measured twice now)
The hard pre-request bound reserves ~15-45x actual spend per request. Both
rounds died on reservation with only ~$0.10-0.17 actual spent. Any real fix
loop (10-20 requests) needs its cap sized against the bound structure, not
expected actuals - or a proxy that reconciles bound->actual after each
response instead of accumulating worst case per request.
