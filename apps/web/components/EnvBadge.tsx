import type { DbEnvironment } from "@sentinel/core";

/** Per-environment accent. prod is magenta — loud without reading as "error";
 *  the ladder gets warmer as changes climb toward production. */
const COLOR: Record<DbEnvironment, string> = {
  local: "var(--faint)",
  dev: "var(--cyan)",
  staging: "var(--warn)",
  prod: "var(--magenta)",
};

/** Compact environment tag shown wherever a target database is named. Pure
 *  presentational (renders in server components too). */
export function EnvBadge({ env, size = 10 }: { env: DbEnvironment; size?: number }) {
  return (
    <span
      className="mono"
      title={`Environment: ${env}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: size,
        textTransform: "uppercase",
        letterSpacing: ".08em",
        color: COLOR[env],
        border: `1px solid color-mix(in srgb, ${COLOR[env]} 35%, transparent)`,
        borderRadius: 999,
        padding: "1px 8px",
        lineHeight: 1.6,
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 5, height: 5, borderRadius: "50%", background: COLOR[env] }}
      />
      {env}
    </span>
  );
}
