import { describe, it, expect } from "vitest";
import {
  createGithubClient,
  assertRepoName,
  reduceChecksState,
  GithubApiError,
} from "../src/github";

/**
 * PR3 (doc 11 §7) — the GitHub client. No octokit, no network: every test
 * drives an injected fetchImpl and asserts the exact requests + parsing.
 */

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function makeFetch(
  respond: (url: string, init: RequestInit) => { status: number; json: unknown },
) {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    calls.push({ url, method: init?.method ?? "GET", headers, body: init?.body as string | undefined });
    const { status, json } = respond(url, init ?? {});
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const TOKEN = "ghp_secret_token_value";

describe("assertRepoName", () => {
  it("accepts owner/repo with word chars, dots and dashes", () => {
    expect(() => assertRepoName("SamChawla/migration-sentinel")).not.toThrow();
    expect(() => assertRepoName("a.b/c-d_e")).not.toThrow();
  });
  it("rejects path traversal, extra segments and URL junk", () => {
    for (const bad of ["", "noslash", "a/b/c", "../etc/passwd", "a/b?x=1", "a b/c", "owner/re po"]) {
      expect(() => assertRepoName(bad), bad).toThrow();
    }
  });
});

describe("createGithubClient — request discipline", () => {
  it("sends Bearer token, Accept and API-version headers on every call", async () => {
    const { calls, fetchImpl } = makeFetch(() => ({ status: 200, json: {} }));
    const gh = createGithubClient({ token: TOKEN, fetchImpl });
    await gh.getRepo("o/r");
    await gh.getPr("o/r", 7);
    for (const c of calls) {
      expect(c.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
      expect(c.headers["Accept"]).toBe("application/vnd.github+json");
      expect(c.headers["X-GitHub-Api-Version"]).toBeTruthy();
    }
  });

  it("encodeURIComponent's the repo segments in the URL", async () => {
    const { calls, fetchImpl } = makeFetch(() => ({ status: 200, json: {} }));
    const gh = createGithubClient({ token: TOKEN, fetchImpl });
    await gh.getRepo("own.er/re-po");
    expect(calls[0].url).toContain("/repos/own.er/re-po");
    // and a hostile name never reaches the URL raw — assertRepoName refuses first
    await expect(gh.getRepo("../evil/x")).rejects.toThrow();
  });

  it("non-2xx → typed GithubApiError that never echoes the token", async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 404, json: { message: "Not Found" } }));
    const gh = createGithubClient({ token: TOKEN, fetchImpl });
    const err = await gh.getPr("o/r", 1).catch((e) => e);
    expect(err).toBeInstanceOf(GithubApiError);
    expect(err.status).toBe(404);
    expect(String(err.message)).not.toContain(TOKEN);
  });

  it("parses PR files into {filename, status, sha}", async () => {
    const { fetchImpl } = makeFetch((url) =>
      url.includes("/files")
        ? {
            status: 200,
            json: [
              { filename: "migrations/001_add.sql", status: "added", sha: "abc" },
              { filename: "README.md", status: "modified", sha: "def" },
            ],
          }
        : { status: 200, json: {} },
    );
    const gh = createGithubClient({ token: TOKEN, fetchImpl });
    const files = await gh.getPrFiles("o/r", 5);
    expect(files).toEqual([
      { filename: "migrations/001_add.sql", status: "added", sha: "abc" },
      { filename: "README.md", status: "modified", sha: "def" },
    ]);
  });

  it("getFileContents decodes base64 content at a ref", async () => {
    const sql = "ALTER TABLE users ADD COLUMN age int;\n";
    const { calls, fetchImpl } = makeFetch(() => ({
      status: 200,
      json: { content: Buffer.from(sql, "utf8").toString("base64"), encoding: "base64" },
    }));
    const gh = createGithubClient({ token: TOKEN, fetchImpl });
    const text = await gh.getFileContents("o/r", "migrations/001_add.sql", "headsha123");
    expect(text).toBe(sql);
    expect(calls[0].url).toContain("ref=headsha123");
  });

  it("createComment posts and returns the comment id; updateComment PATCHes it", async () => {
    const { calls, fetchImpl } = makeFetch((url, init) =>
      init.method === "POST" ? { status: 201, json: { id: 991 } } : { status: 200, json: { id: 991 } },
    );
    const gh = createGithubClient({ token: TOKEN, fetchImpl });
    const created = await gh.createComment("o/r", 7, "hello");
    expect(created.id).toBe(991);
    await gh.updateComment("o/r", 991, "updated");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/issues/7/comments");
    expect(calls[1].method).toBe("PATCH");
    expect(calls[1].url).toContain("/issues/comments/991");
  });
});

describe("reduceChecksState — the per-commit checks rollup", () => {
  it("empty → none", () => {
    expect(reduceChecksState([])).toBe("none");
  });
  it("any failing conclusion → failure", () => {
    expect(
      reduceChecksState([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "failure" },
      ]),
    ).toBe("failure");
    expect(reduceChecksState([{ status: "completed", conclusion: "timed_out" }])).toBe("failure");
  });
  it("anything not completed → pending", () => {
    expect(
      reduceChecksState([
        { status: "completed", conclusion: "success" },
        { status: "in_progress", conclusion: null },
      ]),
    ).toBe("pending");
  });
  it("all completed successfully (incl. neutral/skipped) → success", () => {
    expect(
      reduceChecksState([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "skipped" },
        { status: "completed", conclusion: "neutral" },
      ]),
    ).toBe("success");
  });
});
