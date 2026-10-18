# Incident response runbook (demo document)

First stabilize, then understand. Confirm the blast radius before touching
code: which service, which deploy, which customers.

For a TypeError in the checkout path, the last change to the throwing file
is the prime suspect. Revert first when customers are impacted; a careful
fix can follow in a draft PR that a human reviews.

Every incident gets a timeline in the incident channel: alert, triage
findings, suspect commit, action taken, verification.
