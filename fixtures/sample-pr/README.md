# Sample migration PR — GitHub-intake demo

Two sample migrations for exercising Migration Sentinel's **From GitHub PR**
intake end-to-end:

| File | Gate |
|---|---|
| `0001_index_orders_amount.sql` | 🟢 green — `CREATE INDEX CONCURRENTLY`, the approve-&-apply beat |
| `0002_drop_legacy_notes.sql` | 🔴 red — irreversible `DROP COLUMN`, the typed-confirm hero beat |

## Open the PR

You need a scratch repo **you own** with at least one commit (a default branch),
and `GITHUB_TOKEN` (repo scope) set in `.env` — the same token the app uses for
the PR intake, so if this succeeds the intake will too.

```bash
pnpm sample:pr <owner/repo>            # e.g. pnpm sample:pr me/sentinel-scratch
# or: SAMPLE_PR_REPO=me/sentinel-scratch pnpm sample:pr
```

It commits both files under `migrations/` on a fresh branch and opens **one PR
carrying both a green and a red migration**, then prints the PR number + URL.

## Use it in the app

**New migration → From GitHub PR** → enter the `owner/repo` and PR number →
**Load PR** → pick a file. Sentinel re-reads the file **server-side at the PR
head SHA** — what gets analyzed is exactly what's on GitHub, never SQL the
browser sends.
