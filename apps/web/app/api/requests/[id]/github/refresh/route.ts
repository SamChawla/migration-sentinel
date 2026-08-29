import { NextResponse } from "next/server";
import { getGithubLink, updateGithubLinkSync, markExportMerged } from "@sentinel/db/queries";
import { createGithubClient, GithubApiError } from "@sentinel/agent";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

/** Re-read the linked PR live and refresh the cached metadata the console
 *  chips render (title / state / head SHA / checks). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { id } = await params;

  const link = await getGithubLink(id);
  if (!link) return NextResponse.json({ error: "No GitHub PR is linked to this request." }, { status: 404 });

  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    return NextResponse.json(
      { error: "GITHUB_TOKEN is not configured.", code: "github_token_missing" },
      { status: 409 },
    );
  }

  try {
    const gh = createGithubClient({ token });
    const pr = await gh.getPr(link.repo, link.prNumber);
    const checksState = pr.headSha ? await gh.getChecks(link.repo, pr.headSha).catch(() => "none" as const) : "none";
    await updateGithubLinkSync(id, {
      prTitle: pr.title,
      prState: pr.merged ? "merged" : pr.state,
      headSha: pr.headSha,
      checksState,
      htmlUrl: pr.htmlUrl,
    });
    // Also refresh the EXPORT PR's cached merge state (PR4) — cosmetic for the
    // "Apply now" button; the apply route re-verifies live before releasing.
    if (link.exportPrNumber != null && link.exportPrState !== "merged") {
      const merged = await gh.isMerged(link.repo, link.exportPrNumber).catch(() => false);
      if (merged) await markExportMerged(id);
    }
    const fresh = await getGithubLink(id);
    return NextResponse.json({ link: fresh });
  } catch (e) {
    if (e instanceof GithubApiError) {
      return NextResponse.json({ error: e.message, code: "github_error" }, { status: e.status === 404 ? 404 : 502 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
