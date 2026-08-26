---
name: humanize-ui
description: Use to fix UI that looks AI-generated and make it feel like a person with taste made it. Applies concrete corrections — real typography, tinted neutrals, intentional asymmetry, one committed accent, human copy — driven by the VARIANCE/MOTION/DENSITY dials from DESIGN.md. Trigger after deslop-audit finds issues, when asked to "make this less generic / more human / more polished," or when redesigning existing UI. This is the fix pass; deslop-audit is the diagnosis pass.
---

# Humanize UI

"Human" here does not mean decorative. It means **intentional** — every choice looks decided, not defaulted. A person with taste commits to specifics, introduces deliberate asymmetry, and leaves the small optical adjustments a template never makes.

Read `DESIGN.md` first (run `design-language-detector` if it doesn't exist). Its dials set how far to push each change. Don't invent a new direction here — execute the one already decided.

## The moves

### Typography — commit and contrast
- Replace default sans with a font that fits the domain and is stated in DESIGN.md. Pairing a distinctive display face with a clean body is the fastest way to stop looking generic.
- Build real hierarchy: a heading should differ from body by weight AND size AND often color/tracking, not size alone. Big jumps between levels, not a smooth ramp.
- Set body measure to 60–75ch. Left-align body. Tighten heading letter-spacing slightly; loosen small-caps/labels.
- Use tabular figures for anything numeric in tables.

### Color — tint the neutrals, commit the accent
- **Never pure black or pure white.** Tint neutrals toward the brand hue (e.g. text `hsl(220 15% 12%)` not `#000`, surfaces `hsl(220 20% 98%)` not `#fff`). This one change removes a huge amount of AI feel.
- Define shades in OKLCH (or HSL) so steps are perceptually even, not muddy in the mids.
- Pick ONE accent and give it a job: it marks the primary action and the one thing you want seen first, and mostly stays absent. Restraint makes it read as intentional.
- Kill unmotivated gradients. If a gradient stays, make it subtle and same-hue, not purple→blue.
- **Re-check contrast after every color change.** Tinting neutrals and committing an accent both move pairs across the 4.5:1 line, in either direction. Run `.claude/skills/deslop-audit/scripts/contrast.py` over the files you touched before you call the color pass done. A prettier palette that no one can read is a regression, not a fix.

### Layout — break the symmetry on purpose
- Push VARIANCE toward the dial value. Even at low variance, avoid the centered-hero-plus-three-cards template: give the hero an off-center focal point, unequal columns, or an asymmetric split.
- Establish spacing rhythm, don't apply uniform gaps. Related things tight, sections far apart. Vary it intentionally.
- Stop wrapping everything in cards. Use space, dividers, and alignment to group. Never nest a card in a card.
- Drop the icon-tile-above-every-heading motif. If icons earn their place, integrate them inline, not as identical decorative tiles.
- Create one clear focal point per view. If everything is emphasized, nothing is.

### Borders, shadows, shape
- Prefer a soft, semi-transparent shadow over a solid 1px gray border for separating surfaces — it reads more crafted (per emil's rule).
- Commit to one radius convention across the UI. Consistency signals intent.
- Optical fixes a template skips: nudge icons to optical center, align text to cap-height not bounding box, adjust for the fact equal numeric spacing isn't equal perceived spacing.

### The signature
- Make sure the DESIGN.md signature element is actually present and doing work. One recognizable, slightly unexpected idea (a type treatment, a grid quirk, an accent behavior) is the difference between "clean" and "clearly this product." Without it you've made a nicer template.

### Copy — write like a person
- Cut filler verbs (Elevate, Unlock, Seamlessly, Supercharge, Effortlessly). Say the specific thing the product does.
- Reduce em-dashes to near zero in UI copy; use periods and commas.
- Replace generic value props with concrete, product-specific ones. Real content beats lorem ipsum for judging layout — use realistic copy.
- Drop emoji-as-bullets.

## Process
1. Read DESIGN.md and the deslop-audit findings (if any).
2. Fix in this order — cheapest, highest-impact first: **neutrals/color → type → layout/asymmetry → borders/shadows → copy → signature.**
3. Apply changes across the whole target consistently; don't fix one component and leave siblings generic.
4. Hand motion work to `motion-taste`.
5. Re-run `deslop-audit` - **all four passes**, not just the source scan. The fix pass changes colors, spacing and structure, which is exactly what the computed and render passes exist to check. Anything remaining should be an intentional, DESIGN.md-consistent choice, not a leftover default.
6. Look at the result rendered, at more than one width, in more than one state. If you never saw it, you did not finish it.

## Don't overcorrect
Humanizing is not "add more stuff." Distinctive and restrained beat busy. If a change adds decoration without adding intent, cut it. Low-variance domains (clinical, fintech, dev infra) get quieter, more precise fixes — not asymmetry for its own sake.

## Reference
Synthesized from:
- **taste-skill** by Leonxlnx — https://github.com/leonxlnx/taste-skill (dials, anti-slop fixes, variance)
- **impeccable** by Paul Bakaus — https://github.com/pbakaus/impeccable (tinted neutrals, no cards-in-cards, commit to type/accent)
- **emil/skills** by Emil Kowalski — https://github.com/emilkowalski/skills (semi-transparent shadow over solid border, optical detail)