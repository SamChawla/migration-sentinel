---
name: design-language-detector
description: Use BEFORE building or redesigning any UI. Reads the project's domain, audience, brand cues, and existing code, then decides on a concrete design language (type, color, spacing, density, motion) and writes it to DESIGN.md so every later UI decision is consistent instead of defaulting to generic SaaS templates. Trigger when starting a new frontend, a new page/section, a redesign, or whenever there is no agreed design direction yet.
---

# Design Language Detector

Most AI-built UIs look the same because the model skips this step: it starts styling before deciding what the thing should *feel* like, so it falls back to the average of its training data (centered hero, Inter, purple gradient, three feature cards). This skill forces a decision first.

**Do not write UI code until this produces a `DESIGN.md`.** If one already exists, read it and follow it instead of re-deriving.

## Process

### 1. Read the situation
Gather, in order, and stop early if you already have enough signal:
- **Domain / what the product does** — the single biggest driver of the right look.
- **Audience** — developers, consumers, enterprise buyers, kids, clinicians, creatives. Determines tone, density, contrast, playfulness.
- **Existing code** — scan for an established palette, font stack, spacing scale, component library, `tailwind.config`, CSS variables. If there's a real system already, extend it; don't reinvent it.
- **Brand cues** — logo, existing marketing site, product name, any stated voice.
- **Anti-references** — what it must NOT look like. Ask for one if unclear ("what's a site in your space that looks generic/bad to you?"). Anti-references are more useful than references.

### 2. Map domain → design language
These are starting heuristics, not rules. Adjust to the specific brand.

| Domain | Leans toward |
| --- | --- |
| Dev tool / infra | Dense, monospace accents, dark-mode-first, low chroma, sharp corners, restraint (Linear/Vercel lineage) |
| Fintech / banking | High trust, tight grid, conservative color, real numbers/tables, generous but not playful spacing |
| Community / social / CMS | Warmer, higher personality, avatar-heavy, denser feeds, clear hierarchy for user-generated content |
| Healthcare / clinical | Calm, high legibility, high contrast for accessibility, minimal decoration, no gimmicks |
| E-commerce | Product-forward, image-led, strong CTAs, fast scan, price/legibility discipline |
| Editorial / content | Typography IS the design — real type scale, long-form measure (60–75ch), minimal chrome |
| B2B SaaS dashboard | Information density, data viz discipline, muted UI so data pops, keyboard-friendly |
| Creative / portfolio / agency | High variance permitted, expressive type, motion, asymmetry, one bold idea |

### 3. Set the three dials
Borrowed from taste-skill. Record an explicit 1–10 value for each so later skills (`humanize-ui`, `motion-taste`) have a target:
- **VARIANCE** — layout experimentation. Low = centered, symmetric, safe. High = asymmetric, editorial, off-grid. Dev tools and clinical: low–mid. Portfolios/agencies: high.
- **MOTION** — animation depth. Low = hover states only. High = scroll-driven, magnetic, orchestrated. Default low–mid unless the brand is expressive.
- **DENSITY** — information per viewport. Low = spacious marketing. High = dashboards, feeds, tables.

### 4. Write DESIGN.md
Keep it short enough to actually be followed. Template:

```markdown
# Design Language

**Product:** <what it is, one line>
**Audience:** <who>
**Feels like:** <3 adjectives, e.g. "precise, quiet, fast">
**Anti-references:** <what to avoid looking like>

## Dials
VARIANCE: n/10 · MOTION: n/10 · DENSITY: n/10

## Type
- Display/heading: <font + why it fits the domain, NOT Inter/Arial by default>
- Body: <font>
- Scale: <e.g. 1.25 ratio, base 16px>
- Mono (if used): <font>

## Color
- Neutrals: <tinted, never pure #000/#fff — state the hue tint>
- Primary/accent: <one committed accent, when it's allowed to appear>
- Semantic: success/warn/error
- Note: define in OKLCH or HSL so shades stay perceptually even
- Contrast: <every pair below checked, bars stated>

## Spacing & shape
- Scale: <4px or 8px base>
- Radius: <committed value, consistent>
- Border/shadow convention: <e.g. "semi-transparent shadows, no solid 1px gray borders">

## Signature
<ONE element that makes this product recognizable — a specific type treatment,
a grid quirk, an accent behavior. Without this it's a template.>

## Component sources
<UI library if any (see pick-ui-library thinking), or "hand-built">
```

## Check the palette before you commit it

A palette is a set of *pairs*, and a pair's contrast is not visible in the hex
values. Pick the colors, then run every pair you intend to ship through
`.claude/skills/deslop-audit/scripts/contrast.py --pair FG BG` before writing
them into DESIGN.md. Bars: 4.5:1 text, 3:1 large text / UI / graphics / focus ring.

The three that catch people out, every time:
- **The accent as a button fill.** A mid-tone brand accent that reads beautifully
  as a bar or a rail usually fails 4.5:1 under a light label. If it does, keep the
  accent for graphics and commit a darker step for anything text-bearing. Say so
  in DESIGN.md, or the next pass will "restore" the pretty value.
- **One focus ring for two grounds.** A page with a dark chrome and light panels
  needs two ring colors. A single one is invisible on one of them.
- **Text on its own tint.** Badges and pills set the hue on its `-soft` variant,
  which is darker than the page - the tightest pair in the palette, and the one
  nobody checks.

Fix these here, at palette-definition time. Retrofitting contrast after the UI is
built means touching every surface at once.

## Self-check before finishing
- Could this DESIGN.md describe any generic SaaS product? If yes, it's too vague — the domain and signature aren't specific enough.
- Did you commit to actual fonts and an actual accent, or hedge with "modern sans" and "a blue"? Commit.
- Is there exactly one signature idea? Zero = template. Three = incoherent.
- Did every color pair pass the contrast script, or did you just eyeball it?

## Reference
Synthesized from the setup/brief-inference ideas in:
- **impeccable** by Paul Bakaus — https://github.com/pbakaus/impeccable (`init` → PRODUCT.md/DESIGN.md flow)
- **taste-skill** by Leonxlnx — https://github.com/leonxlnx/taste-skill (the three dials, brief inference)