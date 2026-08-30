/**
 * Qodo review client (ADR-005, Phase 6.1). Advisory review of the generated
 * migration SQL, run through the real Qodo Command CLI (`@qodo/command`).
 *
 * How it runs live: we resolve the Qodo CLI's JS entrypoint from the installed
 * package and invoke it with `node` (so there is no shell-quoting or PATH/.cmd
 * issue on Windows). The CLI runs a Qodo agent in `--ci` mode, authenticated by
 * QODO_API_KEY, and we ask it to return a single JSON verdict which we parse.
 *
 * Degradation contract:
 *   - QODO_API_KEY unset          → verdict "skipped" (pipeline still runs).
 *   - CLI missing / errors / non-JSON → verdict "skipped" with the reason in
 *     `summary`. Qodo is ADVISORY: it never blocks the gate, so a Qodo outage
 *     must not tank a migration review. The deterministic classifier + shadow
 *     dry-run + gate remain authoritative.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

const execFileAsync = promisify(execFile);

export type QodoVerdict = "passed" | "passed_with_warnings" | "failed" | "skipped";

export interface QodoFinding {
  severity: "info" | "warning" | "error";
  message: string;
  line?: number;
}

export interface QodoReviewResult {
  verdict: QodoVerdict;
  summary: string;
  findings: QodoFinding[];
  raw?: unknown;
}

export interface QodoReviewInput {
  upSql: string;
  downSql: string;
  context?: string;
}

// Positive integer only — a NaN/0/negative env value must not disable the
// timeout (which would let a hung CLI run forever).
const REVIEW_TIMEOUT_MS = (() => {
  const n = Number(process.env.QODO_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 120_000;
})();
// Cap the SQL embedded in the prompt so a large migration can't exceed the OS
// argv length limit (which would make execFile reject before Qodo runs).
const MAX_SQL_CHARS = 8000;
const capSql = (s: string): string =>
  s.length > MAX_SQL_CHARS ? `${s.slice(0, MAX_SQL_CHARS)}\n-- …(truncated ${s.length - MAX_SQL_CHARS} chars for review)` : s;

/**
 * Resolve the Qodo CLI's JS entrypoint from the installed @qodo/command package.
 *
 * We cannot `require.resolve("@qodo/command/package.json")` — @qodo/command ships
 * an `exports` map that does NOT expose the `./package.json` subpath, so that
 * throws `Package subpath './package.json' is not defined by "exports"` and the
 * review silently degrades to "skipped". Instead resolve the package's `.`
 * export (which IS allowed), then walk up to the nearest package.json that
 * belongs to @qodo/command and read its `bin` from disk.
 *
 * Resolution is also anchored to a few bases: the module's own url first, then
 * `<cwd>/packages/qodo` (the workspace package that declares the dep — where the
 * bundled Next server can't see its own source location), then the cwd. The
 * first base that resolves wins.
 */
function resolveQodoEntry(): string | null {
  const bases: NodeJS.Require[] = [];
  const addBase = (from: string) => {
    try {
      bases.push(createRequire(from));
    } catch {
      /* non-resolvable base — skip */
    }
  };
  try {
    addBase(import.meta.url);
  } catch {
    /* import.meta unavailable in some bundlers — fall through to cwd anchors */
  }
  addBase(resolvePath(process.cwd(), "packages/qodo/package.json"));
  addBase(resolvePath(process.cwd(), "package.json"));

  for (const req of bases) {
    try {
      // The `.` export resolves; package.json subpath does not (exports map).
      const mainEntry = req.resolve("@qodo/command");
      let dir = dirname(mainEntry);
      for (let i = 0; i < 8; i++) {
        const pkgPath = resolvePath(dir, "package.json");
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
            name?: string;
            bin?: string | Record<string, string>;
          };
          if (pkg.name === "@qodo/command") {
            const binRel =
              typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.qodo ?? Object.values(pkg.bin ?? {})[0];
            return binRel ? resolvePath(dir, binRel) : null;
          }
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      /* try the next base */
    }
  }
  return null;
}

function buildPrompt(input: QodoReviewInput): string {
  return [
    "You are reviewing a PostgreSQL migration for safety before it is applied to a production database.",
    "Assess: correctness, reversibility, lock/blocking risk, and any risk of data loss.",
    input.context ? `Context: ${input.context}` : "",
    "",
    "-- UP migration --",
    input.upSql ? capSql(input.upSql) : "(none)",
    "",
    "-- DOWN migration --",
    input.downSql ? capSql(input.downSql) : "(none)",
    "",
    "Respond with ONLY a single minified JSON object and no other text, of the exact shape:",
    '{"verdict":"passed|passed_with_warnings|failed","summary":"<one sentence>","findings":[{"severity":"info|warning|error","message":"<text>"}]}',
    "Use verdict 'failed' only for a migration that is unsafe or destructive; 'passed_with_warnings' for lock/perf concerns; 'passed' when clean.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Pull the LAST balanced top-level JSON object out of arbitrary CLI stdout
 *  (the final verdict follows any reasoning), tracking string state so braces
 *  inside a JSON string value don't skew the depth count. */
export function extractJson(text: string): unknown | null {
  // Collect every top-level {...} object, then try them LAST-to-first (the qodo
  // verdict is the final object). Crucially, string state is tracked ONLY while
  // inside an object (depth > 0): an unmatched quote in a CLI warning or log line
  // that precedes the JSON must NOT flip us into "string mode" and cause the
  // verdict object to be skipped.
  const candidates: string[] = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (depth === 0) {
      // Outside any object, only an opening brace matters — ignore log quotes.
      if (ch === "{") {
        start = i;
        depth = 1;
      }
      continue;
    }
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) candidates.push(text.slice(start, i + 1));
    }
  }
  for (let j = candidates.length - 1; j >= 0; j--) {
    try {
      return JSON.parse(candidates[j]);
    } catch {
      /* try the previous candidate */
    }
  }
  return null;
}

export function normalizeVerdict(v: unknown): QodoVerdict {
  return v === "passed" || v === "passed_with_warnings" || v === "failed" ? v : "passed_with_warnings";
}

export function normalizeFindings(f: unknown): QodoFinding[] {
  if (!Array.isArray(f)) return [];
  return f
    .map((x): QodoFinding | null => {
      if (!x || typeof x !== "object") return null;
      const o = x as Record<string, unknown>;
      const sev = o.severity === "info" || o.severity === "warning" || o.severity === "error" ? o.severity : "info";
      const message = typeof o.message === "string" ? o.message : typeof o.text === "string" ? o.text : "";
      if (!message) return null;
      return { severity: sev, message, line: typeof o.line === "number" ? o.line : undefined };
    })
    .filter((x): x is QodoFinding => x !== null);
}

export async function reviewMigration(input: QodoReviewInput): Promise<QodoReviewResult> {
  const apiKey = process.env.QODO_API_KEY;
  if (!apiKey) {
    return { verdict: "skipped", summary: "Qodo review skipped (QODO_API_KEY not set).", findings: [] };
  }

  const entry = resolveQodoEntry();
  if (!entry) {
    return {
      verdict: "skipped",
      summary: "Qodo review skipped — @qodo/command CLI not resolvable (run `pnpm install`).",
      findings: [],
    };
  }

  const args = [entry, "--ci", "-q", "-y", "--no-builtin", buildPrompt(input)];
  try {
    const { stdout } = await execFileAsync(process.execPath, args, {
      timeout: REVIEW_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, QODO_API_KEY: apiKey },
    });
    // Qodo discontinued the Command CLI (2026): it now prints a notice and
    // exits 0 instead of reviewing. Detect that so the UI shows an honest,
    // actionable message rather than "no parseable verdict". PR review moved to
    // the Qodo GitHub App (https://app.qodo.ai) — see README "Qodo review".
    if (/qodo\s+command\s+has\s+been\s+discontinued/i.test(stdout)) {
      return {
        verdict: "skipped",
        summary:
          "Qodo Command CLI has been discontinued — in-app SQL review is unavailable. Use the Qodo GitHub App (app.qodo.ai) for automatic PR reviews.",
        findings: [],
      };
    }
    const parsed = extractJson(stdout) as Record<string, unknown> | null;
    if (!parsed) {
      return {
        verdict: "skipped",
        summary: "Qodo ran but returned no parseable verdict.",
        findings: [],
        raw: stdout.slice(0, 4000),
      };
    }
    return {
      verdict: normalizeVerdict(parsed.verdict),
      summary: typeof parsed.summary === "string" ? parsed.summary : "Qodo review complete.",
      findings: normalizeFindings(parsed.findings),
      raw: parsed,
    };
  } catch (e) {
    return {
      verdict: "skipped",
      summary: `Qodo review unavailable: ${(e as Error).message}`,
      findings: [],
    };
  }
}
