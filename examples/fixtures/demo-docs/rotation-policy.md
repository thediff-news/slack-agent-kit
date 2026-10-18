# Credential rotation policy (demo document)

When a credential is leaked, assume it is already being used. Revocation at
the provider comes first, before any code change: removing the key from
source does not disable it.

Order of operations:

1. Revoke the leaked key at the provider console.
2. Issue a replacement and store it in the secret manager, never in git.
3. Remove the literal from source and reference the environment instead.
4. Deploy and verify the service works with the replacement.
5. Close the alert with a link to the rotation PR and the deploy log.

Rotation PRs are always drafts. A human who owns the affected service
approves; the agent that prepared the PR never merges it.
