export function ThemeToggle({
  theme,
  onToggleTheme,
  compact = false,
}: {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  compact?: boolean;
}) {
  return (
    <button className="theme-toggle" onClick={onToggleTheme} aria-label="toggle theme">
      {theme === 'dark' ? (compact ? '☀' : '☀ light') : compact ? '☾' : '☾ dark'}
    </button>
  );
}
