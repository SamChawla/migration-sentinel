/**
 * GitHub client (PR3, doc 11 §5) — plain fetch against api.github.com, no
 * octokit. Every call: Bearer token, `Accept: application/vnd.github+json`,
 * pinned API version, an 8s abort timeout, and encoded repo segments. Non-2xx
 * becomes a typed GithubApiError that NEVER carries the token.
 *
 * The token is supplied by the caller and read ONLY from
 * `process.env.GITHUB_TOKEN` at the call sites — never the DB, argv or a URL.
 */

export class GithubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** Refuse anything that isn't a plain `owner/repo` — no traversal, no URLs. */
export function assertRepoName(repo: string): void {
  if (!REPO_RE.test(repo) || repo.includes("..")) {
    throw new GithubApiError(`Invalid repository name.`, 400, repo);
  }
}

export type ChecksState = "none" | "pending" | "failure" | "success";

/** Roll a commit's check runs up to one state the UI can chip. */
export function reduceChecksState(
  runs: { status?: string | null; conclusion?: string | null }[],
): ChecksState {
  if (runs.length === 0) return "none";
  const SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
  if (runs.some((r) => r.status !== "completed")) return "pending";
  if (runs.every((r) => SUCCESS_CONCLUSIONS.has(r.conclusion ?? ""))) return "success";
  return "failure";
}

export interface PrFile {
  filename: string;
  status: string;
  sha: string;
}

export interface PrInfo {
  number: number;
  title: string;
  state: string;
  headSha: string;
  htmlUrl: string;
  merged: boolean;
}

export interface GithubClientOptions {
  token: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface GithubClient {
  getRepo(repo: string): Promise<Record<string, unknown>>;
  getPr(repo: string, number: number): Promise<PrInfo>;
  getPrFiles(repo: string, number: number): Promise<PrFile[]>;
  getFileContents(repo: string, path: string, ref: string): Promise<string>;
  getChecks(repo: string, ref: string): Promise<ChecksState>;
  createComment(repo: string, issueNumber: number, body: string): Promise<{ id: number }>;
  updateComment(repo: string, commentId: number, body: string): Promise<{ id: number }>;
  // ── export helpers (PR4) ──
  /** ref like "heads/main" → its object sha. */
  getRef(repo: string, ref: string): Promise<{ sha: string }>;
  /** ref like "refs/heads/x". 422 = already exists (caller may reuse). */
  createRef(repo: string, ref: string, sha: string): Promise<void>;
  /** Create (or update, when sha of the existing file is given) one file. */
  putFile(
    repo: string,
    path: string,
    input: { branch: string; message: string; content: string; sha?: string },
  ): Promise<void>;
  createPull(
    repo: string,
    input: { title: string; head: string; base: string; body?: string },
  ): Promise<{ number: number; htmlUrl: string }>;
  /** Live merge check — GET /pulls/{n}/merge (204 merged / 404 not). */
  isMerged(repo: string, number: number): Promise<boolean>;
}

/** owner/repo → "owner/repo" with each segment individually encoded. */
function encodeRepo(repo: string): string {
  assertRepoName(repo);
  const [owner, name] = repo.split("/");
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

export function createGithubClient(opts: GithubClientOptions): GithubClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 8000;

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "migration-sentinel",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      // The error surface carries only status + path + GitHub's message —
      // never the request headers, so the token can't leak into logs/audits.
      const detail = await res
        .json()
        .then((j) => (j as { message?: string }).message ?? "")
        .catch(() => "");
      throw new GithubApiError(
        `GitHub API ${res.status} on ${path}${detail ? ` — ${detail}` : ""}`,
        res.status,
        path,
      );
    }
    return (await res.json()) as T;
  }

  return {
    // async so a repo-name refusal REJECTS rather than throwing synchronously —
    // callers awaiting any method get one uniform failure mode.
    async getRepo(repo) {
      return call("GET", `/repos/${encodeRepo(repo)}`);
    },

    async getPr(repo, number) {
      const pr = await call<Record<string, any>>("GET", `/repos/${encodeRepo(repo)}/pulls/${Number(number)}`);
      return {
        number: Number(pr.number ?? number),
        title: String(pr.title ?? ""),
        state: String(pr.state ?? "unknown"),
        headSha: String(pr.head?.sha ?? ""),
        htmlUrl: String(pr.html_url ?? ""),
        merged: Boolean(pr.merged),
      };
    },

    async getPrFiles(repo, number) {
      const all: PrFile[] = [];
      let page = 1;
      while (page <= 30) {
        const files = await call<Record<string, any>[]>(
          "GET",
          `/repos/${encodeRepo(repo)}/pulls/${Number(number)}/files?per_page=100&page=${page}`,
        );
        if (!files || files.length === 0) break;
        for (const f of files) {
          all.push({
            filename: String(f.filename ?? ""),
            status: String(f.status ?? ""),
            sha: String(f.sha ?? ""),
          });
        }
        if (files.length < 100) break;
        page++;
      }
      return all;
    },

    async getFileContents(repo, path, ref) {
      const encPath = path.split("/").map(encodeURIComponent).join("/");
      const file = await call<Record<string, any>>(
        "GET",
        `/repos/${encodeRepo(repo)}/contents/${encPath}?ref=${encodeURIComponent(ref)}`,
      );
      if (file.encoding === "none" || typeof file.content !== "string") {
        const rawUrl = `${baseUrl}/repos/${encodeRepo(repo)}/contents/${encPath}?ref=${encodeURIComponent(ref)}`;
        const raw = await fetchImpl(rawUrl, {
          headers: {
            Authorization: `Bearer ${opts.token}`,
            Accept: "application/vnd.github.raw+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "migration-sentinel",
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!raw.ok) {
          throw new GithubApiError(`GitHub API ${raw.status} fetching raw ${path}`, raw.status, path);
        }
        return await raw.text();
      }
      return Buffer.from(file.content, "base64").toString("utf8");
    },

    async getChecks(repo, ref) {
      const data = await call<{ check_runs?: { status?: string; conclusion?: string | null }[] }>(
        "GET",
        `/repos/${encodeRepo(repo)}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
      );
      return reduceChecksState(data.check_runs ?? []);
    },

    async createComment(repo, issueNumber, body) {
      const c = await call<{ id: number }>(
        "POST",
        `/repos/${encodeRepo(repo)}/issues/${Number(issueNumber)}/comments`,
        { body },
      );
      return { id: Number(c.id) };
    },

    async updateComment(repo, commentId, body) {
      const c = await call<{ id: number }>(
        "PATCH",
        `/repos/${encodeRepo(repo)}/issues/comments/${Number(commentId)}`,
        { body },
      );
      return { id: Number(c.id) };
    },

    async getRef(repo, ref) {
      const encRef = ref.split("/").map(encodeURIComponent).join("/");
      const data = await call<{ object?: { sha?: string } }>(
        "GET",
        `/repos/${encodeRepo(repo)}/git/ref/${encRef}`,
      );
      const sha = data.object?.sha;
      if (!sha) throw new GithubApiError(`No sha for ref ${ref}.`, 502, ref);
      return { sha };
    },

    async createRef(repo, ref, sha) {
      await call("POST", `/repos/${encodeRepo(repo)}/git/refs`, { ref, sha });
    },

    async putFile(repo, path, input) {
      const encPath = path.split("/").map(encodeURIComponent).join("/");
      await call("PUT", `/repos/${encodeRepo(repo)}/contents/${encPath}`, {
        message: input.message,
        content: Buffer.from(input.content, "utf8").toString("base64"),
        branch: input.branch,
        ...(input.sha ? { sha: input.sha } : {}),
      });
    },

    async createPull(repo, input) {
      const pr = await call<{ number: number; html_url: string }>(
        "POST",
        `/repos/${encodeRepo(repo)}/pulls`,
        { title: input.title, head: input.head, base: input.base, body: input.body ?? "" },
      );
      return { number: Number(pr.number), htmlUrl: String(pr.html_url) };
    },

    async isMerged(repo, number) {
      // 204 (no body) = merged; 404 = not merged. Bypass call()'s JSON parse.
      const path = `/repos/${encodeRepo(repo)}/pulls/${Number(number)}/merge`;
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${opts.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "migration-sentinel",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 204) return true;
      if (res.status === 404) return false;
      throw new GithubApiError(`GitHub API ${res.status} on ${path}`, res.status, path);
    },
  };
}
