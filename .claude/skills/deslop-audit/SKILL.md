---
name: deslop-audit
description: Use to review a UI for the tells that make it look AI-generated AND for the defects that only exist once it renders. Runs three passes - a source scan for the known tells, a computed pass for contrast and measure, and a render pass over screenshots - then asks what is wrong that no pass covered. Reports findings with location and severity; it does not fix them. Trigger when reviewing UI, before shipping, or when something "looks AI-made" but the reason isn't obvious. Pair with humanize-ui to fix what this finds.
---

# De-Slop Audit

This skill only diagnoses. It produces a findings report; fixing is `humanize-ui`'s job. Keeping them separate stops the model from quietly "fixing" things by making them blander.

**Run all four passes. Do not stop after Pass 1.** Pass 1 is a text scan against a fixed list, and a text scan can only find what someone already thought to name. Everything that only exists at render time - real contrast, real measure, real overflow, whether the thing actually looks good - is invisible to it. Skipping passes 2-4 is how an audit returns "clean" on a screen with an unreadable primary button.

For each finding, output: **file:line · what · why it's wrong · severity (high/med/low) · fix**.

---

## Pass 1 - source scan (the known tells)

Grep the target for these. They are real, they are common, and they are all findable in text.

### Typography
- **Inter, Arial, Helvetica, or the system stack used with no intent.** Inter isn't wrong, but Inter-by-default on everything is the single most common tell.
- Only one font weight/size doing all the work - no real hierarchy, just size bumps.
- Line length beyond ~75ch for body copy, or headings set at body measure.
- Centered body paragraphs.

### Color
- **Purple→blue (or purple→pink) gradients**, especially on hero backgrounds and CTA buttons.
- **Pure black (#000) and pure gray text** on colored or tinted backgrounds - untinted neutrals read as machine defaults.
- An accent color with no logic to when it appears - everything mildly colored, nothing owns emphasis.
- More than ~2 accent hues competing.
- Hardcoded hex outside the token system.

### Layout & structure
- **Cards wrapping everything, and cards nested inside cards.** The reflexive "put it in a rounded box with a shadow."
- **Rounded-square icon tile above every heading.**
- Perfectly symmetric hero: centered headline + subhead + two buttons + three equal feature cards below.
- Everything on the same visual weight - no focal point, no rhythm, uniform spacing everywhere.
- 3-column "features" grid with icon + bold title + one gray sentence, repeated.
- Equal-width, equal-height everything; no intentional asymmetry.

### Motion (flag for motion-taste to fix)
- **Bounce / elastic / spring-overshoot easing** on functional UI.
- Enter animations using `ease-in` (should be `ease-out`).
- Everything animating, or nothing animating.
- No `prefers-reduced-motion` block.

### Copy & content
- **Em-dash overuse** as the default connective.
- Marketing filler verbs: "Elevate," "Unlock," "Seamlessly," "Supercharge," "Effortlessly," "Empower," "in seconds."
- Vague value props that could describe any product.
- Emoji used as bullet points or section markers.
- Lorem ipsum, or fake-but-generic placeholder content left in.
- Perfectly parallel, tricolon-heavy phrasing ("Build faster. Ship smarter. Scale further.").

### Component defaults
- Untouched shadcn/MUI/Chakra look - recognizably the library's demo.
- Default border-radius and default shadow everywhere with no chosen convention.
- Solid 1px gray borders where a soft shadow or subtle tint would read better.
- `alert()` / `confirm()` / `prompt()` inside a designed UI.

---

## Pass 2 - computed checks (what reading cannot see)

These are properties of *pairs* and *measurements*. They never appear in a diff and no amount of staring at CSS finds them. Compute them.

### Contrast - always run this
```bash
python .claude/skills/deslop-audit/scripts/contrast.py <files...>          # every stated pair
python .claude/skills/deslop-audit/scripts/contrast.py --pair FG BG        # one pair by hand
python .claude/skills/deslop-audit/scripts/contrast.py --pair FG BG --large  # 3:1 bar
```
WCAG 2.2 bars: **4.5:1** normal text · **3:1** large text (>=24px, or >=18.66px bold), UI components, graphics, and focus indicators.

The script lists an UNRESOLVED set - rules that set a `color` with no background in the same block. Those are not passes. Work out the real surface for each and re-check it with `--pair`. Pay particular attention to:
- **A brand accent used as a button fill.** A mid-tone accent that looks right as a rail or a bar routinely fails 4.5:1 the moment a label sits on it. Hue and fill can pass while text on it does not.
- **A single focus-ring color on a page with both a dark and a light ground.** One of the two will be invisible. Check the ring against every surface it can land on.
- **Text on its own `-soft`/tinted variant** (badges, pills, chips). The tint is darker than the page, so the pair is tighter than it looks.
- **Hover states.** A pass at rest can fail on hover when the background changes.

### Measure, size, and target
- Body copy measure at each breakpoint - flag anything past ~75ch.
- Interactive targets below 24×24 CSS px (WCAG 2.2 minimum) or below ~44px where touch matters.
- Text set below ~12px.

### Behavior under real data
- What the layout does at 0 items, 1 item, and several hundred.
- What long unbroken strings do to it (no `min-width: 0`, no wrapping → overflow).

---

## Pass 3 - render pass (look at it)

Passes 1 and 2 still never see the page. Get it on screen.

1. **Launch it.** Use the `run` skill, or the project's own start command.
2. **Screenshot every primary surface** - and every *state*, not just the default: empty, loading, error, populated, and any modal or overlay. A screen you never rendered is a screen you never reviewed.
3. **Screenshot at ~1440, ~1100, and ~760 wide.** Most layout defects are breakpoint defects.
4. **Read the screenshots** and report what only the render shows:
   - The actual focal point. Is the eye pulled where the design intended, or nowhere?
   - Spacing rhythm as seen, not as declared - grouping that reads wrong despite correct tokens.
   - Optical alignment: things that are mathematically aligned but look off.
   - Crowding, collisions, orphaned words, text that overflows or clips.
   - Whether the DESIGN.md signature element is actually visible and doing work.
   - Anything that simply looks bad, whether or not it has a name.

If the app genuinely cannot be launched, say so explicitly in the report and mark it **RENDER PASS NOT RUN**. Do not let a skipped pass read as a clean pass.

---

## Pass 4 - the open question

The three passes above are closed lists, and a closed list converges: once each named item is addressed, it returns clean forever - including on a redesign that got worse. So finish by answering, in prose, outside the list:

> **What is the weakest thing about this UI that none of the passes above would catch?**

Answer it honestly even when everything else came back green. If the honest answer is "nothing significant," say that - but say it as a judgment you formed from looking at the render, not as the byproduct of an empty findings array.

---

## Output format
```
DE-SLOP AUDIT — <target>
Dials context (from DESIGN.md, if present): VARIANCE n · MOTION n · DENSITY n
Passes run: source ✓ · computed ✓ · render ✓ (1440/1100/760, 6 states) · open question ✓

HIGH
- src/Hero.tsx:12 · Purple→blue gradient on hero bg · signature AI-landing tell · fix: commit to DESIGN.md accent
- tokens.css:8 · Primary button label 3.6:1 on the accent fill · below 4.5:1, unreadable for low-vision users · fix: darken the fill, keep the accent for graphics

MED
- src/Features.tsx:8 · Icon-tile-above-heading pattern ×3 · overused motif · ...

LOW
- copy.ts:4 · "Seamlessly" / "Unlock" filler verbs · generic voice · ...

SUMMARY: n high, n med, n low. Biggest single giveaway: <one line>.
OPEN QUESTION: <the weakest thing no pass covered, in prose>
```

## Waivers
If a flagged pattern is a deliberate, brand-consistent choice recorded in DESIGN.md, note it as **intentional (waived)** rather than a finding. Don't flag a mono font in a dev tool, or high density in a dashboard, as slop - context from `design-language-detector` decides.

**Contrast failures are never waivable.** A documented decision to be unreadable is still unreadable. Everything else in Pass 1 is taste; Pass 2's contrast bars are not.

## Reference
Tell list synthesized from:
- **impeccable** by Paul Bakaus — https://github.com/pbakaus/impeccable (deterministic detector rules and anti-patterns list)
- **taste-skill** by Leonxlnx — https://github.com/leonxlnx/taste-skill (anti-repetition rules, em-dash ban)
- **emil/skills** by Emil Kowalski — https://github.com/emilkowalski/skills (easing tells)

Passes 2-4 are not from those repos. They exist because a source-only audit ran twice over this project, reported every item closed, and missed an unreadable primary button, an invisible focus ring, and six of seven category label pairs below 4.5:1.
