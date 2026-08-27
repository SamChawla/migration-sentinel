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
  for (const line of contents.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
