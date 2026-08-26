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
import { readFileSync } from "node:fs";
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

const REVIEW_TIMEOUT_MS = Number(process.env.QODO_TIMEOUT_MS ?? 120_000);

/** Resolve the Qodo CLI's JS entrypoint from the installed @qodo/command package. */
function resolveQodoEntry(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve("@qodo/command/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin?: string | Record<string, string> };
    const binRel =
      typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.qodo ?? Object.values(pkg.bin ?? {})[0];
    if (!binRel) return null;
    return resolvePath(dirname(pkgPath), binRel);
  } catch {
    return null;
  }
}

function buildPrompt(input: QodoReviewInput): string {
  return [
    "You are reviewing a PostgreSQL migration for safety before it is applied to a production database.",
    "Assess: correctness, reversibility, lock/blocking risk, and any risk of data loss.",
    input.context ? `Context: ${input.context}` : "",
    "",
    "-- UP migration --",
    input.upSql || "(none)",
    "",
    "-- DOWN migration --",
    input.downSql || "(none)",
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
  let depth = 0;
  let inStr = false;
  let esc = false;
  let start = -1;
  let last: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) last = text.slice(start, i + 1);
    }
  }
  if (last === null) return null;
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
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
