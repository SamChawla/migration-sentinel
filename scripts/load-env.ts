import { readFileSync } from "node:fs";

/**
 * Load the repo-root .env into process.env for standalone scripts (tsx does not
 * do this automatically). Explicit environment variables win: a key already set
 * in the process environment is never overwritten.
 */
export function loadDotenv(path = ".env"): void {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (e) {
    // A MISSING .env is fine — rely on the inherited environment. But a
    // permission error, a directory in place of the file, or any other I/O
    // failure must NOT be swallowed: silently discarding a configured DATABASE
    // URL lets a script fall back to a hard-coded default (e.g. seed-sentinel
    // running its destructive --reset against the wrong database).
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue; // blank or full-line comment
    // Accept an optional `export ` prefix (a common .env form previously ignored).
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (key in process.env) continue; // explicit env wins — never overwrite
    let value = m[2];
    const dq = value.match(/^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/);
    const sq = value.match(/^'([^']*)'\s*(?:#.*)?$/);
    if (dq) {
      // Double-quoted: honour a couple of common escapes; keep any '#' literally.
      value = dq[1].replace(/\\([nrt"\\])/g, (_, c: string) =>
        c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c,
      );
    } else if (sq) {
      value = sq[1]; // single-quoted: fully literal
    } else {
      // Unquoted: strip an inline comment (only when preceded by whitespace, so a
      // '#' inside a value like a URL fragment is preserved) and trim.
      value = value.replace(/\s+#.*$/, "").trim();
    }
    process.env[key] = value;
  }
}
