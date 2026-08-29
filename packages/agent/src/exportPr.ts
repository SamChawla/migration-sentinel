/**
 * Export an approved prod migration as a GitHub PR (PR4, doc 11 §5): branch
 * `sentinel/migration-<id8>`, folder `migrations/<ts>_<slug>/` holding
 * {up.sql, down.sql, report.md}, then a pull request against the base branch.
 * The MERGE of that PR — a human action on GitHub — is gate 2; nothing here
 * touches the target database.
 */
import { GithubApiError, type GithubClient } from "./github";

/** Windows-safe, URL-safe slug: lowercase, [a-z0-9-] only, bounded, never empty. */
export function migrationSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "migration";
}

/** migrations/<UTC yyyymmddhhmmss>_<slug> — no path-hostile characters. */
export function migrationFolder(now: Date, title: string): string {
  const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `migrations/${ts}_${migrationSlug(title)}`;
}

export interface ExportMigrationOptions {
  repo: string;
  requestId: string;
  title: string;
  upSql: string;
  downSql: string;
  /** The safety report markdown committed alongside the SQL. */
  report: string;
  /** Defaults to the repository's default branch. */
  baseBranch?: string;
  /** Injectable clock (tests / deterministic folders). */
  now?: Date;
}

export interface ExportMigrationResult {
  branch: string;
  folder: string;
  prNumber: number;
  prUrl: string;
}

export async function exportMigrationPr(
  gh: GithubClient,
  opts: ExportMigrationOptions,
): Promise<ExportMigrationResult> {
  const base =
    opts.baseBranch ??
    String((await gh.getRepo(opts.repo)).default_branch ?? "main");
  const { sha: baseSha } = await gh.getRef(opts.repo, `heads/${base}`);

  const branch = `sentinel/migration-${opts.requestId.replace(/-/g, "").slice(0, 8)}`;
  try {
    await gh.createRef(opts.repo, `refs/heads/${branch}`, baseSha);
  } catch (e) {
    // 422 = the branch already exists (a previous export attempt) — reuse it
    // rather than failing; the timestamped folder keeps file paths fresh.
    if (!(e instanceof GithubApiError && e.status === 422)) throw e;
  }

  const folder = migrationFolder(opts.now ?? new Date(), opts.title);
  const message = `sentinel: export migration ${opts.requestId.slice(0, 8)} (${migrationSlug(opts.title)})`;
  await gh.putFile(opts.repo, `${folder}/up.sql`, { branch, message, content: opts.upSql });
  await gh.putFile(opts.repo, `${folder}/down.sql`, { branch, message, content: opts.downSql });
  await gh.putFile(opts.repo, `${folder}/report.md`, { branch, message, content: opts.report });

  const pr = await gh.createPull(opts.repo, {
    title: `Sentinel migration: ${opts.title}`,
    head: branch,
    base,
    body:
      `Migration \`${opts.requestId}\` was approved at the Sentinel gate. ` +
      `Merging this PR is the second, source-of-truth approval — the guarded apply unlocks only after the merge.\n\n` +
      `Contents: \`${folder}/{up.sql, down.sql, report.md}\`.`,
  });

  return { branch, folder, prNumber: pr.number, prUrl: pr.htmlUrl };
}
