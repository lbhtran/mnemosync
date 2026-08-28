// Tape-reel mark from docs/brand/lockup.svg, redrawn with theme variables
// so it follows light/dark instead of the lockup's fixed brand colors. The
// bright spoke through the reel doubles as a nod to the scrubber's playhead.
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg
      className="logo-mark"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-hidden="true"
    >
      <line x1="8" y1="32" x2="56" y2="32" stroke="var(--border)" strokeWidth="2.5" />
      <line x1="19" y1="24" x2="19" y2="40" stroke="var(--text-dim)" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="30" y1="18" x2="30" y2="46" stroke="var(--text-dim)" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="40" y1="14" x2="40" y2="50" stroke="var(--accent)" strokeWidth="2.5" />
      <circle cx="40" cy="32" r="9" fill="var(--bg-inset)" stroke="var(--accent)" strokeWidth="2.5" />
      <circle cx="40" cy="32" r="3.5" fill="var(--accent)" />
    </svg>
  );
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <span className="logo">
      <LogoMark size={size} />
      <span className="logo-word">mnemosync</span>
    </span>
  );
}
