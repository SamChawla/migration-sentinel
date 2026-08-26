interface SqlWellProps {
  sql: string;
  label?: string;
  danger?: boolean;
  banner?: string;
}

export function SqlWell({ sql, label, danger, banner }: SqlWellProps) {
  return (
    <div>
      {label && <div className="hud-label" style={{ marginBottom: 4 }}>{label}</div>}
      <div className={`sql-well${danger ? " sql-well-danger" : ""}`}>
        {banner && <span className="sql-well-banner">{banner}</span>}
        {sql}
      </div>
    </div>
  );
}
