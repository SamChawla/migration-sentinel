# Skills in this project

Agent Skills are instructions that get loaded into a coding session, so they are
executable input, not documentation. Anything here is vendored deliberately,
read in full before it landed, and pinned to a source you can diff against.

## Where each one came from

| Skill | Source | Pinned at |
| --- | --- | --- |
| `design-language-detector` | written here; synthesized from the three repos credited below | — |
| `deslop-audit` | written here (plus `scripts/contrast.py`); same sources | — |
| `humanize-ui` | written here; same sources | — |
| `motion-taste` | written here; same sources | — |
| `postgres-patterns` | [affaan-m/ECC](https://github.com/affaan-m/ECC) `skills/postgres-patterns` (MIT, itself derived from Supabase's skills) | `06c5e11` · 2026-08-16 |
| `database-migrations` | [affaan-m/ECC](https://github.com/affaan-m/ECC) `skills/database-migrations` (MIT) | `06c5e11` · 2026-08-16 |

## The four design-taste skills

These are the canonical copies. An earlier snapshot lived under
`docs/design-taste-skills/`; it was removed because the two drifted (this set
gained the render and contrast passes and the `contrast.py` script) and a
second copy that Claude Code never loads is only a place for instructions to go
stale. They chain as: `design-language-detector` writes `DESIGN.md`, the UI is
built, `deslop-audit` reports, `humanize-ui` fixes, `motion-taste` handles
transitions, then `deslop-audit` runs again.

They are a distilled synthesis, in original wording, of three projects. If you
want the fullest and best-maintained version of this capability, install the
originals:

- **impeccable** — Paul Bakaus — https://github.com/pbakaus/impeccable
  (Apache-2.0). Source of the DESIGN.md setup flow, the concrete AI-tell list,
  and the diagnosis/fix separation.
- **taste-skill** — Leonxlnx — https://github.com/leonxlnx/taste-skill (MIT).
  Source of the VARIANCE / MOTION / DENSITY dials, brief inference, and
  anti-repetition rules.
- **skills (for designers & engineers)** — Emil Kowalski —
  https://github.com/emilkowalski/skills (MIT). Source of all motion guidance:
  easing direction, duration, what not to animate.

## The two vendored from ECC

They were copied as files rather than installed through `npm i -g ecc-universal`.
The skills are plain markdown, so the global package buys nothing here and would
add a dependency whose install surface is larger than the thing being used.

Both carry an **`# Otahque overrides`** section appended at the end. That is a
local addition and not upstream. It exists because neither skill knows this is a
multi-tenant install, and each contains at least one instruction that is wrong
here — `postgres-patterns` would have you revoke on the `public` schema, which
is the shared schema, and `database-migrations` would have you use
`AddIndexConcurrently`, which breaks community provisioning. The override
section always wins over the text above it.

**When updating either skill,** re-fetch the upstream file, re-read it, and
re-apply the override section. Do not let an update silently drop it.

## What was evaluated and rejected

From the same catalogue, and left out on purpose:

- `python-patterns` — mandates `black`, `isort` and `mypy`; this project is
  ruff-only per `.claude/rules/code-standards.md`.
- `django-patterns` — assumes an `apps/` package layout and `django-environ`.
  Apps live at the repo root here and settings read through `python-decouple`.
- `django-security` — same `apps/` and `django-environ` assumptions, and
  `.claude/rules/guardrails.md` is both stricter and tenancy-aware.
- `django-celery` — `apps/` layout and `pip`; tasks here take a `schema_name`
  and run under `schema_context()`, which the skill has no concept of.
- `django-tdd` — restates the testing section of `code-standards.md` with less
  specificity about this suite.
- `security-review` — name-collides with the built-in `/security-review`, and
  its examples are TypeScript.

The common failure is that none of them know about django-tenants, which is the
constraint that decides most decisions in this codebase. A skill that gives
confident Django advice with no notion of schemas is a liability here, not a
help, which is why only the two most mechanical ones were taken.
