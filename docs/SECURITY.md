# Execution security

Apollo treats model output as untrusted. File operations are jailed to the selected workspace,
deterministic checks run against that workspace, and side-effecting tools pass through an execution
policy before they run.

## Project policy

Create `.apollo/policy.json` inside a workspace:

```json
{
  "schemaVersion": 1,
  "write": "ask",
  "shell": "ask",
  "critical": "deny"
}
```

Each class accepts `allow`, `ask`, or `deny`:

- `write`: `write_file` and `edit_file`.
- `shell`: ordinary workspace commands such as tests and formatters.
- `critical`: destructive Git/filesystem commands, publishing, deployments, `sudo`, and download-to-shell patterns.

Mission approval (`--yes` or the Desktop checkbox) satisfies `ask`; it never overrides `deny`.
Critical access therefore requires an explicit project-policy change made outside the model run.
Every evaluated side effect emits `permission.decided` with the tool, risk, decision, and reason.

One-shot file output is validated as an untrusted batch. Absolute/traversal paths, duplicates and
any existing symbolic-link segment are rejected before commit. Exact patches must match once.
Outputs and backups are staged on the same workspace filesystem; if a later replacement fails,
already committed files are restored before the error reaches the fallback agent.

Incremental context snapshots live below Apollo's state directory, not inside source control. Cache
files use mode `0600`, exclude the same secret/dotfile paths as live context selection, are keyed by
the resolved workspace, and prune deleted files. Cache failure only disables reuse; it cannot skip
verification or grant write authority.

## Audit redaction

The JSONL sink redacts common API-key, bearer-token, and GitHub-token shapes before appending an
event. Values under credential-like keys are also replaced with `[REDACTED]`. Redaction is defense
in depth, not a reason to place secrets in goals or source files; config stores environment-variable
names rather than secret values.

The dashboard write API binds to loopback and rejects foreign browser origins. It accepts workspace
paths because choosing a local project is its purpose; operating-system access remains limited to
the user running Apollo.
