/**
 * Sandbox feasibility spike — answers ONE question: can TrueForge's sandbox
 * (Daytona-backed, config.sandbox.enabled) run OUR workload — a live Postgres
 * server + pg_dump, not a short self-contained script — well enough to host
 * shadow-DB verification there instead of our own Docker infra?
 *
 * Prereq (one-time, manual, cannot be scripted from here):
 *   1. Sign up free at https://app.daytona.io (no card required).
 *   2. Create an API key with Sandboxes access + Snapshots write permission.
 *   3. In the running local TrueForge server's UI: Settings → Sandbox
 *      providers → Daytona preset → paste the key.
 *
 * Run:
 *   pnpm spike:sandbox            # ask the agent to run the probe script
 *   pnpm spike:sandbox --dump     # also print every raw event
 *
 * This is a probe, not a permanent module — expect to edit it once you see
 * the real event shapes and sandbox OS, same spirit as spike.ts.
 */
import { TrueForge } from "@truefoundry/trueforge-sdk";

const BASE_URL = process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790";
const MODEL = process.env.SENTINEL_MODEL ?? "anthropic/claude-sonnet-4-6";
const DUMP = process.argv.includes("--dump");

// The actual thing we need to know, run as ONE script so the sandbox's
// lifecycle (does it survive across the whole sequence?) is exercised too.
// Every step is independently observable in the output so a partial failure
// still tells us something (e.g. "apt works but no route to hold a bg proc").
const PROBE_SCRIPT = String.raw`
set -uo pipefail
echo "== 1. platform =="; uname -a
echo "== 2. network egress =="; (curl -s -m 5 -o /dev/null -w "http_code=%{http_code}\n" https://icanhazip.com) || echo "NO_EGRESS"
echo "== 3. root / apt =="; id -u; command -v apt-get || echo "NO_APT"
echo "== 4. install postgres (timed) =="
T0=$(date +%s)
(apt-get update -qq && apt-get install -y -qq postgresql >/tmp/pg_install.log 2>&1) && echo "INSTALL_OK" || echo "INSTALL_FAILED (see /tmp/pg_install.log tail below)"
tail -n 20 /tmp/pg_install.log 2>/dev/null
echo "install_seconds=$(( $(date +%s) - T0 ))"
echo "== 5. find binaries =="
PG_BIN=$(dirname "$(find / -maxdepth 6 -name pg_ctl -type f 2>/dev/null | head -n1)")
echo "PG_BIN=$PG_BIN"
echo "== 6. init + start cluster (background/long-lived process) =="
useradd -m pguser 2>/dev/null || true
mkdir -p /tmp/pgdata /tmp/pgsock && chown -R pguser /tmp/pgdata /tmp/pgsock 2>/dev/null || true
T1=$(date +%s)
su - pguser -c "$PG_BIN/initdb -D /tmp/pgdata" >/tmp/pg_initdb.log 2>&1 && echo "INITDB_OK" || { echo "INITDB_FAILED"; tail -n 20 /tmp/pg_initdb.log; }
su - pguser -c "$PG_BIN/pg_ctl -D /tmp/pgdata -l /tmp/pg_log.log -o '-p 5599 -k /tmp/pgsock -h 127.0.0.1' start" && echo "START_OK" || { echo "START_FAILED"; echo "-- postgres log --"; tail -n 40 /tmp/pg_log.log 2>/dev/null; }
sleep 2
echo "startup_seconds=$(( $(date +%s) - T1 ))"
echo "== 7. connect + real DDL/DML through the SAME session (long-lived proc still up?) =="
su - pguser -c "$PG_BIN/psql -h 127.0.0.1 -p 5599 -d postgres -c \"CREATE TABLE probe(id int); INSERT INTO probe VALUES (1); SELECT * FROM probe; DROP TABLE probe;\"" && echo "SQL_OK" || echo "SQL_FAILED"
echo "== 8. pg_dump against it =="
su - pguser -c "$PG_BIN/pg_dump -h 127.0.0.1 -p 5599 -d postgres --schema-only" >/tmp/dump.out 2>/tmp/dump.err && echo "PGDUMP_OK ($(wc -l < /tmp/dump.out) lines)" || { echo "PGDUMP_FAILED"; cat /tmp/dump.err; }
echo "== 9. cleanup =="
su - pguser -c "$PG_BIN/pg_ctl -D /tmp/pgdata stop" && echo "STOP_OK" || echo "STOP_FAILED"
echo "== DONE =="
`.trim();

const INSTRUCTIONS = [
  "You are a diagnostic runner. You have a sandbox (Code Mode) available.",
  "You MUST execute the exact bash script the user gives you inside the sandbox — do NOT summarize, simulate, or predict its output.",
  "Paste back the COMPLETE raw stdout/stderr verbatim, in full, even if it is long. Do not truncate or paraphrase any line.",
  "If the sandbox or a tool is unavailable, say exactly which step failed and why — do not guess at what it would have printed.",
].join(" ");

function shallow(o: any): any {
  if (!o || typeof o !== "object") return o;
  const out: any = {};
  for (const k of Object.keys(o)) {
    const v = (o as any)[k];
    out[k] =
      typeof v === "string" ? v.slice(0, 120) : Array.isArray(v) ? `[${v.length}]` : typeof v === "object" ? "{…}" : v;
  }
  return out;
}

async function main() {
  console.log(`\nSandbox feasibility spike → ${BASE_URL} (model ${MODEL})${DUMP ? "  [dump]" : ""}\n`);
  const client = new TrueForge({ baseUrl: BASE_URL, timeoutInSeconds: 900 });

  const { data: session } = await client.sessions.create({
    agent: {
      spec: {
        model: { name: MODEL },
        instructions: INSTRUCTIONS,
        config: { sandbox: { enabled: true } },
      },
    },
  });

  const stream = await client.sessions.createTurnStream(session.id, {
    input: [
      {
        type: "user.message",
        content: `Run this script in your sandbox via Code Mode and report the full raw output:\n\n\`\`\`bash\n${PROBE_SCRIPT}\n\`\`\``,
      },
    ],
  });

  let text = "";
  let status = "unknown";
  const codeEvents: any[] = [];
  for await (const { data: event } of stream.withMetadata()) {
    const type = event?.type as string | undefined;
    if (DUMP) console.log("   ·", type, JSON.stringify(shallow(event)));
    if (type === "model.message.delta") {
      text += event?.content ?? "";
      process.stdout.write(event?.content ?? "");
    }
    if (type?.startsWith("code_execution") || type?.includes("sandbox") || type?.includes("code.")) {
      codeEvents.push(event);
    }
    if (type === "turn.done") status = event?.state?.status ?? event?.status ?? "done";
  }

  console.log("\n\n── verdict ──");
  console.log(`turn status: ${status}`);
  console.log(`code/sandbox-related events seen: ${codeEvents.length}${codeEvents.length === 0 ? " (⚠ Code Mode may not have fired — check --dump and Settings → Sandbox providers)" : ""}`);
  for (const marker of ["INSTALL_OK", "INSTALL_FAILED", "INITDB_OK", "INITDB_FAILED", "START_OK", "START_FAILED", "SQL_OK", "SQL_FAILED", "PGDUMP_OK", "PGDUMP_FAILED", "NO_EGRESS", "NO_APT"]) {
    if (text.includes(marker)) console.log(`  ${text.includes(marker) ? "✓ seen:" : ""} ${marker}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("spike-sandbox crashed:", e);
  process.exit(1);
});
