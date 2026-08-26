export function SvgDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <linearGradient id="metal" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e2e8f0" /><stop offset=".5" stopColor="#cbd5e1" /><stop offset="1" stopColor="#94a3b8" />
        </linearGradient>
        <linearGradient id="grad-cyan" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c4b5fd" /><stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
        <linearGradient id="bezel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#94a3b8" /><stop offset="1" stopColor="#64748b" />
        </linearGradient>
        <radialGradient id="lamp" cx=".5" cy=".35" r=".7">
          <stop offset="0" stopColor="#fecaca" /><stop offset=".4" stopColor="#ef4444" /><stop offset="1" stopColor="#991b1b" />
        </radialGradient>
        <filter id="emboss" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="1" stdDeviation="1" floodColor="#000" floodOpacity=".15" />
        </filter>
      </defs>
    </svg>
  );
}
