import { readFileSync } from "node:fs";

/**
 * Load the repo-root .env into process.env for standalone scripts (tsx does not
 * do this automatically). Explicit environment variables win: a key already set
 * in the process environment is never overwritten.
 */
export function loadDotenv(path = ".env"): void {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* no .env file — rely on the inherited environment */
  }
}
