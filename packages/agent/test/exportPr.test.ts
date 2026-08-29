import { describe, it, expect, vi } from "vitest";
import { exportMigrationPr, migrationSlug, migrationFolder } from "../src/exportPr";
import { GithubApiError } from "../src/github";

/**
 * PR4 (doc 11 §7) — exporting an approved prod migration as a GitHub PR:
 * branch `sentinel/migration-<id8>`, folder `migrations/<ts>_<slug>/` holding
 * {up.sql, down.sql, report.md}, then a PR against the base branch. Driven
 * entirely through a mocked client — no network.
 */

const REQUEST_ID = "abcdef12-3456-7890-abcd-ef1234567890";
const NOW = new Date("2026-08-30T10:20:30Z");

function makeGh(overrides: Partial<Record<string, unknown>> = {}) {
  const gh = {
    getRepo: vi.fn(async () => ({ default_branch: "main" })),
    getRef: vi.fn(async () => ({ sha: "basesha123" })),
    createRef: vi.fn(async () => ({})),
    updateRef: vi.fn(async () => ({})),
    putFile: vi.fn(async () => ({})),
    createPull: vi.fn(async () => ({ number: 55, htmlUrl: "https://github.com/o/r/pull/55" })),
    ...overrides,
  };
  return gh;
}

describe("slug/timestamp helpers — pure + Windows-safe", () => {
  it("slug lowercases, strips anything outside [a-z0-9-], collapses runs", () => {
    expect(migrationSlug("Drop legacy_notes from users!")).toBe("drop-legacy-notes-from-users");
    expect(migrationSlug("  ALTER: users/orders \\ § ")).toBe("alter-users-orders");
  });
  it("slug is bounded and never empty", () => {
    expect(migrationSlug("x".repeat(200)).length).toBeLessThanOrEqual(48);
    expect(migrationSlug("§§§")).toBe("migration");
  });
  it("folder is migrations/<UTC ts>_<slug> with no path-hostile characters", () => {
    const folder = migrationFolder(NOW, "Drop legacy_notes");
    expect(folder).toBe("migrations/20260830102030_drop-legacy-notes");
    expect(folder).not.toMatch(/[:\\*?"<>|\s]/);
  });
});

describe("exportMigrationPr", () => {
  const OPTS = {
    repo: "o/r",
    requestId: REQUEST_ID,
    title: "Drop legacy_notes",
    upSql: "ALTER TABLE users DROP COLUMN legacy_notes;",
    downSql: "ALTER TABLE users ADD COLUMN legacy_notes text;",
    report: "# verdict",
    now: NOW,
  };

  it("happy path: ref from base → create branch → three files → PR", async () => {
    const gh = makeGh();
    const result = await exportMigrationPr(gh as never, OPTS);

    expect(result.branch).toBe("sentinel/migration-abcdef12");
    expect(result.prNumber).toBe(55);
    expect(result.prUrl).toBe("https://github.com/o/r/pull/55");

    expect(gh.getRef).toHaveBeenCalledWith("o/r", "heads/main");
    expect(gh.createRef).toHaveBeenCalledWith("o/r", "refs/heads/sentinel/migration-abcdef12", "basesha123");

    const paths = gh.putFile.mock.calls.map((c: unknown[]) => c[1]);
    expect(paths).toEqual([
      "migrations/20260830102030_drop-legacy-notes/up.sql",
      "migrations/20260830102030_drop-legacy-notes/down.sql",
      "migrations/20260830102030_drop-legacy-notes/report.md",
    ]);
    for (const c of gh.putFile.mock.calls) {
      expect((c as unknown[])[2]).toMatchObject({ branch: "sentinel/migration-abcdef12" });
    }

    expect(gh.createPull).toHaveBeenCalledWith(
      "o/r",
      expect.objectContaining({ head: "sentinel/migration-abcdef12", base: "main" }),
    );
  });

  it("branch already exists (422) → reused, export continues", async () => {
    const gh = makeGh({
      createRef: vi.fn(async () => {
        throw new GithubApiError("Reference already exists", 422, "/git/refs");
      }),
    });
    const result = await exportMigrationPr(gh as never, OPTS);
    expect(result.prNumber).toBe(55);
    expect(gh.putFile).toHaveBeenCalledTimes(3);
  });

  it("any other API failure surfaces the typed error — nothing is swallowed", async () => {
    const gh = makeGh({
      putFile: vi.fn(async () => {
        throw new GithubApiError("Forbidden", 403, "/contents");
      }),
    });
    await expect(exportMigrationPr(gh as never, OPTS)).rejects.toBeInstanceOf(GithubApiError);
  });

  it("honours an explicit base branch without calling getRepo", async () => {
    const gh = makeGh();
    await exportMigrationPr(gh as never, { ...OPTS, baseBranch: "develop" });
    expect(gh.getRepo).not.toHaveBeenCalled();
    expect(gh.getRef).toHaveBeenCalledWith("o/r", "heads/develop");
  });
});
