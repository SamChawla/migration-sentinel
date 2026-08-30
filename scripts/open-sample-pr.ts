/**
 * Open a sample migration PR on a scratch repo you own, so you can exercise
 * Migration Sentinel's "From GitHub PR" intake end-to-end.
 *
 *   pnpm tsx scripts/open-sample-pr.ts <owner/repo> [baseBranch]
 *   # or set SAMPLE_PR_REPO instead of the positional arg:
 *   SAMPLE_PR_REPO=me/sentinel-scratch pnpm tsx scripts/open-sample-pr.ts
 *
 * Requires GITHUB_TOKEN (repo scope) in .env — the SAME token the app uses for
 * the PR intake, so if this succeeds the intake will too. Commits the two
 * fixtures under fixtures/sample-pr/ into migrations/ on a fresh branch and
 * opens ONE pull request carrying both a GREEN (index) and a RED (drop column)
 * migration, so you can demo both gate colors from a single PR.
 *
 * The repo must already have at least one commit (a default branch). Create a
 * scratch repo with a README and point this at it.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createGithubClient, GithubApiError } from "../packages/agent/src/github.js";
import { loadDotenv } from "./load-env.js";

loadDotenv();

const FIXTURE_DIR = path.join("fixtures", "sample-pr");

async function main() {
  const repo = (process.argv[2] ?? process.env.SAMPLE_PR_REPO ?? "").trim();
  const baseArg = process.argv[3]?.trim() || undefined;

  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    console.error("✗ GITHUB_TOKEN is not set — add it to .env (a token with 'repo' scope).");
    process.exit(1);
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    console.error("✗ Pass the target repo as owner/repo:");
    console.error("    pnpm tsx scripts/open-sample-pr.ts <owner/repo> [baseBranch]");
    console.error("  (or set SAMPLE_PR_REPO). It must be a repo you own with at least one commit.");
    process.exit(1);
  }

  // Load the fixture .sql files (sorted, so 0001 before 0002).
  const files = readdirSync(FIXTURE_DIR)
    .filter((f) => f.toLowerCase().endsWith(".sql"))
    .sort()
    .map((name) => ({ name, content: readFileSync(path.join(FIXTURE_DIR, name), "utf8") }));
  if (files.length === 0) {
    console.error(`✗ No .sql fixtures found in ${FIXTURE_DIR}.`);
    process.exit(1);
  }

  const gh = createGithubClient({ token });

  try {
    console.log(`→ Resolving ${repo}…`);
    const base = baseArg ?? String((await gh.getRepo(repo)).default_branch ?? "main");
    const { sha: baseSha } = await gh.getRef(repo, `heads/${base}`);
    console.log(`  base branch: ${base} @ ${baseSha.slice(0, 8)}`);

    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const branch = `sentinel-sample/${stamp}`;
    console.log(`→ Creating branch ${branch}…`);
    try {
      await gh.createRef(repo, `refs/heads/${branch}`, baseSha);
    } catch (e) {
      if (!(e instanceof GithubApiError && e.status === 422)) throw e;
      await gh.updateRef(repo, `heads/${branch}`, baseSha, true);
    }

    const committed: string[] = [];
    for (const f of files) {
      const destPath = `migrations/${f.name}`;
      console.log(`→ Committing ${destPath}…`);
      await gh.putFile(repo, destPath, {
        branch,
        message: `sample migration: ${f.name}`,
        content: f.content,
      });
      committed.push(destPath);
    }

    console.log("→ Opening pull request…");
    const pr = await gh.createPull(repo, {
      title: "Sample migrations for Migration Sentinel",
      head: branch,
      base,
      body:
        "Two sample migrations to demo the Sentinel **From GitHub PR** intake:\n\n" +
        committed.map((p) => `- \`${p}\``).join("\n") +
        "\n\n`0001` is a GREEN, reversible index build; `0002` is a RED, irreversible " +
        "`DROP COLUMN` (the typed-confirm hero beat). Point Sentinel at this PR and pick a file.",
    });

    console.log("\n✓ Sample PR opened.");
    console.log(`  repo:  ${repo}`);
    console.log(`  PR:    #${pr.number} — ${pr.htmlUrl}`);
    console.log(`  files: ${committed.join(", ")}`);
    console.log("\nNext: New migration → From GitHub PR tab →");
    console.log(`  Repository = ${repo}   PR number = ${pr.number}   → Load PR → pick a file.`);
  } catch (e) {
    if (e instanceof GithubApiError) {
      console.error(`✗ GitHub API error (${e.status}): ${e.message}`);
      if (e.status === 404) console.error("  Check the repo name and that your token can access it.");
      if (e.status === 403) console.error("  The token likely lacks 'repo' write scope on this repo.");
      process.exit(1);
    }
    console.error("✗ Failed to open the sample PR:", (e as Error).message);
    process.exit(1);
  }
}

main();
