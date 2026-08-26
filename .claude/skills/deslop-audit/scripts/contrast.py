#!/usr/bin/env python3
"""Contrast checker for token-based CSS.

A tell-list can only find what is spelled out in the source. Contrast is not
spelled out anywhere - it is a property of a *pair* of resolved colors - so it
has to be computed. This does that.

Two modes:

  # every rule block that sets both a color and a background
  python contrast.py FILE [FILE ...]

  # one explicit pair, for a surface the CSS does not state in the same block
  python contrast.py --pair "#984727" "#f1d8c8" [--label "badge.manual"]

Rules that set `color` with no background in the same block are reported under
UNRESOLVED rather than guessed at - an inherited background is not knowable
from a single block, and a wrong guess is worse than a listed gap.

Thresholds (WCAG 2.2):
  4.5  normal text
  3.0  large text (>=24px, or >=18.66px bold), UI components, graphics,
       and focus indicators
"""

import argparse
import re
import sys

AA_TEXT = 4.5
AA_LARGE = 3.0


def _lin(c):
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(rgb):
    r, g, b = rgb
    return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)


def contrast(fg, bg):
    """fg/bg are (r,g,b) or (r,g,b,a). Alpha on fg is composited over bg."""
    if len(fg) == 4 and fg[3] < 1:
        fg = tuple(round(fg[i] * fg[3] + bg[i] * (1 - fg[3])) for i in range(3))
    fg, bg = fg[:3], bg[:3]
    a, b = luminance(fg), luminance(bg)
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)


NAMED = {"white": (255, 255, 255), "black": (0, 0, 0)}


def parse_color(v):
    """-> (r,g,b) | (r,g,b,a) | None if not a literal color."""
    v = v.strip().lower()
    if v in NAMED:
        return NAMED[v]
    m = re.fullmatch(r"#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})", v)
    if m:
        h = m.group(1)
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        vals = tuple(int(h[i : i + 2], 16) for i in range(0, len(h), 2))
        return vals if len(vals) == 3 else vals[:3] + (vals[3] / 255,)
    m = re.fullmatch(r"rgba?\(([^)]+)\)", v)
    if m:
        parts = [p.strip() for p in re.split(r"[,\s/]+", m.group(1)) if p.strip()]
        try:
            nums = [float(p.rstrip("%")) for p in parts[:4]]
        except ValueError:
            return None
        rgb = tuple(round(n) for n in nums[:3])
        return rgb + (nums[3],) if len(nums) == 4 else rgb
    return None


def load_tokens(text):
    """Custom properties from any :root block, var() references resolved."""
    raw = {}
    for block in re.findall(r":root\s*\{(.*?)\}", text, re.S):
        for name, val in re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", block):
            raw[name] = val.strip()

    def resolve(val, seen=()):
        m = re.fullmatch(r"var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)", val.strip())
        if not m:
            return val
        name, fallback = m.group(1), m.group(2)
        if name in seen or name not in raw:
            return fallback.strip() if fallback else val
        return resolve(raw[name], seen + (name,))

    return {k: resolve(v) for k, v in raw.items()}


def color_of(val, tokens):
    return parse_color(val) or parse_color(tokens.get(_varname(val) or "", ""))


def _varname(val):
    m = re.fullmatch(r"var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)", val.strip())
    return m.group(1) if m else None


BG_SHORTHAND = re.compile(r"(#[0-9a-f]{3,8}|rgba?\([^)]*\)|var\(--[\w-]+\))", re.I)


def scan(path):
    text = open(path, encoding="utf-8").read()
    tokens = load_tokens(text)
    findings, unresolved = [], []

    # Selector + body of every rule block, skipping :root itself.
    for sel, body in re.findall(r"([^{}@/]+?)\{([^{}]*)\}", text, re.S):
        sel = " ".join(sel.split())
        if not sel or sel.startswith(":root"):
            continue
        decls = dict(
            (k.strip(), v.strip())
            for k, v in re.findall(r"([\w-]+)\s*:\s*([^;]+)", body)
        )
        if "color" not in decls:
            continue
        fg = color_of(decls["color"], tokens)
        if fg is None:
            continue

        bg_decl = decls.get("background-color") or decls.get("background")
        bg = None
        if bg_decl:
            if "gradient" in bg_decl.lower():
                bg_decl = None
            else:
                m = BG_SHORTHAND.search(bg_decl)
                if m:
                    bg = color_of(m.group(1), tokens)
                    if bg is not None and len(bg) == 4 and bg[3] < 1:
                        bg = None  # translucent surface: real backdrop unknown
        if bg is None or (bg_decl and bg_decl.strip().lower() == "transparent"):
            unresolved.append((path, sel, decls["color"]))
            continue

        ratio = contrast(fg, bg)
        if ratio < AA_TEXT:
            findings.append((path, sel, decls["color"], bg_decl, ratio))
    return findings, unresolved


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="*")
    ap.add_argument("--pair", nargs=2, metavar=("FG", "BG"))
    ap.add_argument("--label", default="pair")
    ap.add_argument(
        "--large",
        action="store_true",
        help="score against the 3:1 bar (large text, UI, focus ring)",
    )
    args = ap.parse_args()
    bar = AA_LARGE if args.large else AA_TEXT

    if args.pair:
        fg, bg = parse_color(args.pair[0]), parse_color(args.pair[1])
        if not fg or not bg:
            sys.exit("could not parse one of the colors")
        r = contrast(fg, bg)
        print(
            "%-28s %s on %s = %.2f  %s"
            % (
                args.label,
                args.pair[0],
                args.pair[1],
                r,
                "PASS" if r >= bar else "FAIL (need %.1f)" % bar,
            )
        )
        return 0 if r >= bar else 1

    if not args.files:
        ap.error("give files, or --pair FG BG")

    fails, gaps = [], []
    for p in args.files:
        f, u = scan(p)
        fails += f
        gaps += u

    for path, sel, fg, bg, r in sorted(fails, key=lambda x: x[4]):
        print("FAIL %.2f  %s\n       %s  color:%s  on %s" % (r, path, sel, fg, bg))
    if gaps:
        print(
            "\nUNRESOLVED (color set, surface not stated in the same block - "
            "check these by hand with --pair):"
        )
        for path, sel, fg in gaps:
            print("  %s  %s  color:%s" % (path, sel, fg))
    print(
        "\n%d failing pair(s) below %.1f, %d unresolved." % (len(fails), bar, len(gaps))
    )
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
