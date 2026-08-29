import { NextResponse } from "next/server";
import { createGithubClient, GithubApiError } from "@sentinel/agent";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PR lookup for the "From GitHub PR" intake tab (PR3): PR metadata + the
 * changed `.sql` files a migration can be read from. The token comes ONLY
 * from the server's environment; its absence is an honest 409, never a
 * silent fallback.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    return NextResponse.json(
      { error: "GITHUB_TOKEN is not configured — set it in .env to use the PR intake.", code: "github_token_missing" },
      { status: 409 },
    );
  }

  const url = new URL(req.url);
  const repo = url.searchParams.get("repo")?.trim() ?? "";
  const number = Number(url.searchParams.get("number"));
  if (!repo || !Number.isInteger(number) || number <= 0) {
    return NextResponse.json({ error: "repo and a positive PR number are required." }, { status: 400 });
  }

  try {
    const gh = createGithubClient({ token });
    const pr = await gh.getPr(repo, number);
    const [files, checksState] = await Promise.all([
      gh.getPrFiles(repo, number),
      pr.headSha ? gh.getChecks(repo, pr.headSha).catch(() => "none" as const) : Promise.resolve("none" as const),
    ]);
    const sqlFiles = files.filter((f) => f.filename.toLowerCase().endsWith(".sql") && f.status !== "removed");
    return NextResponse.json({
      pr: { ...pr, checksState },
      sqlFiles,
    });
  } catch (e) {
    if (e instanceof GithubApiError) {
      const status = e.status === 404 ? 404 : 502;
      return NextResponse.json({ error: e.message, code: "github_error" }, { status });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
