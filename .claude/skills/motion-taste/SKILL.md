---
name: motion-taste
description: Use when adding, reviewing, or fixing UI animation and transitions. Enforces correct easing (ease-out for enters, not ease-in), sane durations tied to travel distance, animating only cheap properties (transform/opacity), and knowing what NOT to animate. Trigger when building any transition, hover, modal, toast, page change, or when animation "feels off / cheap / janky." Based on Emil Kowalski's animation rules.
---

# Motion Taste

Bad motion is worse than no motion. The common failures are all fixable with a few rules: wrong easing direction, wrong duration for the distance, animating expensive properties, and animating things that shouldn't move. Fix those and motion goes from "cheap" to "invisible in the right way."

## Easing — direction matters
- **Enter animations use `ease-out`.** The element rushes in and settles. `ease-in` on an enter feels sluggish and wrong — this is the single most common animation mistake.
- **Exit animations use `ease-in`.** The element accelerates away.
- **Moves between two on-screen states use `ease-in-out`.**
- Avoid **bounce / elastic / overshoot** easing on functional UI — it reads dated and toylike. Reserve any spring feel for playful brands, and even then keep overshoot tiny.
- Reasonable defaults if you need exact curves:
  - ease-out: `cubic-bezier(0.16, 1, 0.3, 1)`
  - ease-in-out: `cubic-bezier(0.65, 0, 0.35, 1)`

## Duration — tie it to distance
- UI micro-interactions (hover, small fades, toggles): **~150–200ms.**
- Modals, popovers, larger enters: **~200–300ms.**
- Larger travel or full-screen transitions: longer, but rarely past ~500ms.
- Bigger distance → longer duration. A tooltip and a full-screen sheet should not share a duration. Short distance with a long duration feels laggy; long distance with a short duration feels abrupt.

## Animate cheap properties only
- Animate **`transform`** (translate/scale/rotate) and **`opacity`**. These are GPU-composited and stay smooth.
- **Do not animate** `width`, `height`, `top`/`left`, `margin`, or anything that triggers layout — it janks. Use transforms instead (e.g. `scale`, `translate`).
- Avoid animating `box-shadow`/`filter` directly on many elements; fade a pseudo-element or layered shadow instead.

## Spring vs tween
- Tweens (duration + easing) are the safe default and easier to get right.
- Springs (Framer Motion / spring configs) feel great for direct-manipulation and gesture-driven UI, but need tuning — a badly configured spring is just overshoot. If unsure, use a tween.

## What NOT to animate
- Don't animate everything. Motion should direct attention or explain a spatial relationship (where did this come from, where did it go). If it does neither, cut it.
- Don't animate content the user is trying to read or act on quickly (e.g. staggering every row of a data table on load) — it delays the task.
- Don't add scroll-driven / magnetic / parallax effects unless the MOTION dial in DESIGN.md is high and the brand is expressive.

## Accessibility — required
- Respect `prefers-reduced-motion`: reduce or remove non-essential motion, keep opacity fades, drop large translates/parallax.
```css
@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
```
Provide a real reduced variant for anything meaningful, not just a global kill switch, where the motion conveys state.

## Review checklist
- [ ] Enters are ease-out, exits ease-in?
- [ ] Duration matches travel distance (not one global value for everything)?
- [ ] Only transform/opacity animated? No layout-triggering properties?
- [ ] No bounce/elastic on functional UI?
- [ ] Every animation earns its place (attention or spatial clarity)?
- [ ] `prefers-reduced-motion` handled?

## Reference
Rules distilled from **Emil Kowalski's** work:
- **emil/skills** — https://github.com/emilkowalski/skills (`animate`, `review-animations`, `find-animation-opportunities`, `animation-vocabulary`)
- Easing-direction and "right easing" reasoning from his writing at emilkowal.ski/ui
- Bounce/easing tells also flagged in **impeccable** — https://github.com/pbakaus/impeccable