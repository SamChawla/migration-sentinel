"use client";

interface Column {
  name: string;
  type: string;
  affected: "none" | "drop" | "add" | "alter" | "row" | "table";
  severity?: "green" | "amber" | "red";
  /** explicit operation label for the callout (overrides the affect map). */
  opLabel?: string;
}

interface Db3DProps {
  table: string;
  columns: Column[];
}

const BG_NORMAL = [
  "linear-gradient(135deg, rgba(226,232,240,0.95), rgba(203,213,225,0.95))",
  "linear-gradient(135deg, rgba(230,236,244,0.95), rgba(210,218,228,0.95))",
  "linear-gradient(135deg, rgba(234,240,248,0.95), rgba(216,224,234,0.95))",
  "linear-gradient(135deg, rgba(238,244,252,0.95), rgba(222,230,240,0.95))",
  "linear-gradient(135deg, rgba(242,248,255,0.95), rgba(228,236,246,0.95))",
];

const SEV_BG: Record<string, string> = {
  red: "linear-gradient(135deg, rgba(254,226,226,0.96), rgba(254,202,202,0.96))",
  amber: "linear-gradient(135deg, rgba(254,243,199,0.96), rgba(253,230,138,0.96))",
  green: "linear-gradient(135deg, rgba(209,250,229,0.96), rgba(167,243,208,0.96))",
};
const SEV_BORDER: Record<string, string> = {
  red: "rgba(220,38,38,0.45)",
  amber: "rgba(217,119,6,0.4)",
  green: "rgba(5,150,105,0.4)",
};
const SEV_GLOW: Record<string, string> = {
  red: "0 4px 20px rgba(220,38,38,0.2), inset 0 1px 0 rgba(255,255,255,0.6)",
  amber: "0 4px 20px rgba(217,119,6,0.18), inset 0 1px 0 rgba(255,255,255,0.6)",
  green: "0 4px 20px rgba(5,150,105,0.18), inset 0 1px 0 rgba(255,255,255,0.6)",
};
const SEV_TEXT: Record<string, string> = {
  red: "#991b1b", amber: "#92400e", green: "#065f46",
};
const SEV_LABEL: Record<string, string> = {
  drop: "DROP COLUMN", add: "ADD COLUMN", alter: "ALTER COLUMN",
  row: "ROW MUTATION", table: "WHOLE TABLE",
};
const SEV_LABEL_COLOR: Record<string, string> = {
  red: "#dc2626", amber: "#d97706", green: "#059669",
};

export function Db3D({ table, columns }: Db3DProps) {
  const affected = columns.find((c) => c.affected !== "none");

  return (
    <div style={{
      position: "relative", minHeight: 340, overflow: "hidden", borderRadius: "var(--r-md)",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      padding: "16px 24px",
    }}>
      {/* HUD label */}
      <div style={{
        position: "absolute", top: 12, left: 16, zIndex: 2,
        fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".16em",
        color: "var(--muted)", textTransform: "uppercase",
      }}>
        LIVE SCHEMA · {table}
      </div>

      {/* Callout — top right */}
      {affected && (
        <div style={{
          position: "absolute", top: 12, right: 16, textAlign: "right", zIndex: 2,
        }}>
          <div style={{
            fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600,
            color: affected.severity ? SEV_LABEL_COLOR[affected.severity] : "var(--cyan)",
            letterSpacing: ".06em",
          }}>
            ▲ {affected.opLabel ?? SEV_LABEL[affected.affected] ?? "AFFECTED"}
          </div>
          <div style={{
            fontFamily: "var(--font-mono)", fontSize: 10,
            color: "var(--faint)", marginTop: 2,
          }}>
            {affected.affected === "table"
              ? "entire table"
              : affected.affected === "row"
                ? "matched rows"
                : affected.name}
          </div>
        </div>
      )}

      {/* 3D scene — centered */}
      <div className="scene" style={{
        perspective: 1200, width: 260, height: 260,
        position: "relative", marginTop: 20,
      }}>
        <div className="db" style={{
          transformStyle: "preserve-3d",
          transform: "rotateX(58deg) rotateZ(-38deg)",
          animation: "float 7s ease-in-out infinite alternate",
          position: "absolute",
          left: "50%", top: "50%",
          marginLeft: -90, marginTop: -90,
          width: 180, height: 180,
        }}>
          {columns.map((col, i) => {
            const isAffected = col.affected !== "none";
            // "lift" only single-column ops; whole-table/row ops just tint.
            const isColumnOp = col.affected === "drop" || col.affected === "add" || col.affected === "alter";
            const z = i * 26;
            return (
              <div key={col.name} className={isColumnOp ? "plate extract shimmer" : "plate"} style={{
                position: "absolute", width: 180, height: 180, left: 0, top: 0,
                borderRadius: 12,
                background: isAffected && col.severity ? SEV_BG[col.severity] : BG_NORMAL[i % BG_NORMAL.length],
                border: `1px solid ${isAffected && col.severity ? SEV_BORDER[col.severity] : "rgba(148,163,184,0.35)"}`,
                boxShadow: isAffected && col.severity
                  ? SEV_GLOW[col.severity]
                  : "var(--shadow-sm), inset 0 1px 0 rgba(255,255,255,0.6)",
                transform: `translateZ(${z}px)`,
              }}>
                {/* Every plate is labeled → the whole table is always visible,
                    even for decided (applied/rejected/blocked) requests. */}
                <div style={{
                  position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: "var(--font-mono)", fontSize: 12.5,
                  fontWeight: isAffected ? 600 : 500,
                  color: isAffected && col.severity ? SEV_TEXT[col.severity] : "rgba(71,85,105,0.72)",
                  letterSpacing: ".04em",
                }}>
                  {col.name}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
