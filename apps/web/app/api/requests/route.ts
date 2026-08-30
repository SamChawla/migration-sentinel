import { NextResponse, after } from "next/server";
import {
  listRequests,
  listTargetDatabases,
  createRequest,
  createGithubLink,
  getRequest,
  setRequestStatus,
  insertAuditEvent,
  findOpenDuplicatePrRequest,
  DuplicatePrError,
} from "@sentinel/db/queries";
import { runAgentPipeline, createGithubClient, GithubApiError } from "@sentinel/agent";
// splitUpDownSql is the SQL-aware splitter: it splits a one-file migration into
// up/down at a `-- sentinel:down` / `-- migrate:down` / `-- +goose Down` marker
// while ignoring marker-looking text inside strings, dollar-quoted PL/pgSQL
// bodies, quoted identifiers, and block comments (shares splitStatements' lexer).
import { splitUpDownSql } from "@sentinel/shadow";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET() {
  // Migration SQL + target details are not public — require an approver session.
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const records = await listRequests();
  return NextResponse.json(records);
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const targetDb = typeof body.targetDb === "string" ? body.targetDb.trim() : "";
  const upSql = typeof body.upSql === "string" ? body.upSql : "";
  const downSql = typeof body.downSql === "string" ? body.downSql : "";
  const intent = typeof body.intent === "string" ? body.intent.trim() : "";
  const isPrIntake = body.intakeKind === "github_pr";
  if (!targetDb || (!title && !isPrIntake)) {
    return NextResponse.json({ error: "title and targetDb are required." }, { status: 400 });
  }
  // EXACTLY one of the three intakes. NL is generated into a {up,down} pair by
  // the agent and never executed verbatim; PR-sourced SQL is read SERVER-SIDE
  // at the PR's head SHA below — client-supplied SQL is ignored on that path.
  if (!isPrIntake && !upSql.trim() && !intent) {
    return NextResponse.json({ error: "Provide either SQL (upSql) or a natural-language intent." }, { status: 400 });
  }
  if (!isPrIntake && upSql.trim() && intent) {
    return NextResponse.json({ error: "Provide SQL or intent, not both." }, { status: 400 });
  }

  // The alias must resolve to a REGISTERED connection with a stored URL.
  // createRequest would otherwise auto-create a URL-less target row, and the
  // pipeline/apply path throws on it much later — fail honestly at intake.
  const targets = await listTargetDatabases();
  const target = targets.find((t) => t.alias === targetDb);
  if (!target) {
    return NextResponse.json(
      { error: `Unknown target "${targetDb}" — register the connection in Settings first.` },
      { status: 400 },
    );
  }
  if (!target.hasUrl) {
    return NextResponse.json(
      { error: `Target "${targetDb}" has no stored connection URL — re-add it with a URL in Settings.` },
      { status: 400 },
    );
  }

  // ── GitHub-PR intake (PR3): the server reads the migration file at the
  // PR's head SHA — never trusting SQL the client sends alongside. ──
  let prMeta: {
    repo: string; prNumber: number; filePath: string; headSha: string;
    prTitle: string; prState: string; htmlUrl: string;
  } | null = null;
  let effectiveTitle = title;
  let effectiveUpSql = upSql;
  let effectiveDownSql = "";
  if (isPrIntake) {
    const token = process.env.GITHUB_TOKEN?.trim();
    if (!token) {
      return NextResponse.json(
        { error: "GITHUB_TOKEN is not configured — the PR intake is unavailable.", code: "github_token_missing" },
        { status: 409 },
      );
    }
    // GitHub owner/repo names are case-insensitive; normalize to a canonical
    // lowercase so "Owner/Repo" and "owner/repo" are the same PR for de-dup and
    // storage (GitHub's API accepts either casing).
    const repo = typeof body.repo === "string" ? body.repo.trim().toLowerCase() : "";
    const prNumber = Number(body.prNumber);
    const filePath = typeof body.filePath === "string" ? body.filePath.trim() : "";
    if (!repo || !Number.isInteger(prNumber) || prNumber <= 0 || !filePath) {
      return NextResponse.json({ error: "repo, prNumber and filePath are required for a PR intake." }, { status: 400 });
    }
    if (!filePath.toLowerCase().endsWith(".sql")) {
      return NextResponse.json({ error: "The PR intake only accepts .sql files." }, { status: 400 });
    }
    try {
      const gh = createGithubClient({ token });
      const pr = await gh.getPr(repo, prNumber);
      // The file must actually be part of the PR's change set — an arbitrary
      // repo path is not a PR intake.
      const files = await gh.getPrFiles(repo, prNumber);
      if (!files.some((f) => f.filename === filePath && f.status !== "removed")) {
        return NextResponse.json(
          { error: `"${filePath}" is not a changed file on ${repo}#${prNumber}.` },
          { status: 400 },
        );
      }
      const fileSql = await gh.getFileContents(repo, filePath, pr.headSha);
      if (!fileSql.trim()) {
        return NextResponse.json({ error: `"${filePath}" is empty at the PR head.` }, { status: 400 });
      }
      // A PR file MAY carry both halves via a `-- migrate:down` / `-- +goose Down`
      // / `-- sentinel:down` marker; split so the down is analyzed for the
      // rollback proof. No marker → down stays empty (down-less behavior).
      ({ up: effectiveUpSql, down: effectiveDownSql } = splitUpDownSql(fileSql));
      if (!effectiveUpSql.trim()) {
        return NextResponse.json({ error: `"${filePath}" has no up migration at the PR head.` }, { status: 400 });
      }
      effectiveTitle = title || `${pr.title} — ${filePath.split("/").pop()}`;
      prMeta = {
        repo, prNumber, filePath,
        headSha: pr.headSha, prTitle: pr.title, prState: pr.state, htmlUrl: pr.htmlUrl,
      };
    } catch (e) {
      if (e instanceof GithubApiError) {
        return NextResponse.json({ error: e.message, code: "github_error" }, { status: e.status === 404 ? 404 : 502 });
      }
      throw e;
    }

    // De-dup: refuse a second copy of the SAME PR file @ same head, same target,
    // while an earlier one is still open. Promotion across targets (dev → prod)
    // stays allowed because this is scoped to `targetDb`.
    const dup = await findOpenDuplicatePrRequest({
      targetDb, repo, prNumber, filePath, headSha: prMeta.headSha,
    });
    if (dup) {
      return NextResponse.json(
        {
          error: `${repo}#${prNumber} (${filePath}) @ ${prMeta.headSha.slice(0, 8)} is already queued for ${targetDb} as "${dup.title}" (${dup.status}). Open that request instead of adding it again.`,
          code: "duplicate",
          existingId: dup.id,
        },
        { status: 409 },
      );
    }
  }

  let rec: Awaited<ReturnType<typeof createRequest>>;
  try {
    rec = await createRequest({
      title: effectiveTitle,
      targetDb,
      upSql: effectiveUpSql,
      // PR intake: the down parsed from the file's `-- sentinel:down` section
      // (empty when absent). Non-PR intake keeps the client-supplied downSql.
      downSql: prMeta ? effectiveDownSql : downSql,
      intent,
      pr: prMeta
        ? { url: prMeta.htmlUrl, repo: prMeta.repo, file: prMeta.filePath, prNumber: prMeta.prNumber, headSha: prMeta.headSha }
        : undefined,
      requestedBy: session.user,
    });
  } catch (e) {
    // The advisory-locked de-dup inside createRequest lost the race to an
    // identical concurrent submission — surface the same 409 as the pre-check.
    if (e instanceof DuplicatePrError) {
      return NextResponse.json(
        { error: e.message + " Open that request instead of adding it again.", code: "duplicate", existingId: e.existingId },
        { status: 409 },
      );
    }
    throw e;
  }

  if (prMeta) {
    try {
      await createGithubLink({
        migrationRequestId: rec.id,
        repo: prMeta.repo,
        prNumber: prMeta.prNumber,
        commitSha: prMeta.headSha,
        filePath: prMeta.filePath,
        prTitle: prMeta.prTitle,
        prState: prMeta.prState,
        headSha: prMeta.headSha,
        htmlUrl: prMeta.htmlUrl,
      });
      await insertAuditEvent({
        migrationRequestId: rec.id,
        actor: session.user,
        action: "github.linked",
        detail: `Linked to ${prMeta.repo}#${prMeta.prNumber} (${prMeta.filePath} @ ${prMeta.headSha.slice(0, 8)}).`,
        tone: "info",
      });
    } catch (e) {
      // The request exists but its link write failed — land it failed with an
      // audit rather than leaving a PR intake silently unlinked.
      await setRequestStatus(rec.id, "failed").catch(() => {});
      await insertAuditEvent({
        migrationRequestId: rec.id,
        actor: "sentinel.agent",
        action: "github.link_failed",
        detail: `Could not record the GitHub link: ${(e as Error).message}`,
        tone: "red",
      }).catch(() => {});
      return NextResponse.json({ error: "Could not record the GitHub link." }, { status: 500 });
    }
  }

  // Run the safety pipeline as tracked post-response work (Next `after`), not a
  // detached floating promise that can be dropped — it advances the request
  // status in the DB, which the console reads + streams.
  after(async () => {
    try {
      await runAgentPipeline(rec.id);
    } catch (e) {
      console.error(`[agent] pipeline failed for ${rec.id}:`, e);
      // Backstop against a strand: runAgentPipeline lands its own failures in
      // 'failed', but if it threw before that handler engaged, make sure the
      // request can't be left stuck mid-flight (received/generating/dry_running)
      // with no failure audit and no way to reclaim it.
      try {
        const cur = await getRequest(rec.id);
        if (cur && ["received", "generating", "dry_running"].includes(cur.status)) {
          await setRequestStatus(rec.id, "failed");
          await insertAuditEvent({
            migrationRequestId: rec.id,
            actor: "sentinel.agent",
            action: "pipeline.failed",
            detail: `Pipeline crashed before completing: ${(e as Error).message}`,
            tone: "red",
          });
        }
      } catch (inner) {
        console.error(`[agent] failed to mark ${rec.id} failed:`, inner);
      }
    }
  });

  return NextResponse.json({ id: rec.id });
}
