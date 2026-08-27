export function DatabaseIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} filter="url(#emboss)">
      <ellipse cx="12" cy="6" rx="8" ry="3" fill="url(#grad-cyan)" />
      <path d="M4 6v12c0 1.66 3.58 3 8 3s8-1.34 8-3V6" fill="url(#metal)" />
      <ellipse cx="12" cy="6" rx="8" ry="3" fill="url(#grad-cyan)" opacity=".6" />
      <path d="M4 10c0 1.66 3.58 3 8 3s8-1.34 8-3" stroke="url(#bezel)" strokeWidth=".7" opacity=".5" />
      <path d="M4 14c0 1.66 3.58 3 8 3s8-1.34 8-3" stroke="url(#bezel)" strokeWidth=".7" opacity=".5" />
    </svg>
  );
}

export function GaugeIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} filter="url(#emboss)">
      <circle cx="12" cy="12" r="10" fill="url(#metal)" />
      <circle cx="12" cy="12" r="9" fill="none" stroke="url(#bezel)" strokeWidth="1.5" />
      <path d="M12 12L16 7" stroke="url(#grad-cyan)" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="12" cy="12" r="2" fill="url(#grad-cyan)" />
    </svg>
  );
}

export function ShieldIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} filter="url(#emboss)">
      <path d="M12 2L4 6v5c0 5.55 3.84 10.74 8 12 4.16-1.26 8-6.45 8-12V6l-8-4z" fill="url(#metal)" />
      <path d="M12 3.5L5.5 6.8v4.5c0 4.7 3.2 9.1 6.5 10.2 3.3-1.1 6.5-5.5 6.5-10.2V6.8L12 3.5z" fill="none" stroke="url(#bezel)" strokeWidth=".8" />
      <path d="M10 12l2 2 4-4" stroke="url(#grad-cyan)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LeverIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} filter="url(#emboss)">
      <rect x="8" y="14" width="8" height="8" rx="2" fill="url(#metal)" />
      <rect x="9" y="15" width="6" height="6" rx="1" fill="url(#bezel)" opacity=".6" />
      <rect x="10" y="2" width="4" height="14" rx="2" fill="url(#metal)" />
      <circle cx="12" cy="5" r="3" fill="url(#lamp)" />
    </svg>
  );
}
