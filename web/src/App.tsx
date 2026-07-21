import { useEffect, useState } from 'react';
import { Picker } from './pages/Picker';
import { Replay } from './pages/Replay';

interface Route {
  sessionId?: string;
  agentId?: string;
}

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean);
  if (parts[0] === 's' && parts[1]) {
    if (parts[2] === 'agent' && parts[3]) return { sessionId: parts[1], agentId: parts[3] };
    return { sessionId: parts[1] };
  }
  return {};
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('mnemosync-theme') as 'dark' | 'light') ?? 'dark',
  );

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('mnemosync-theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  return route.sessionId ? (
    <Replay
      key={`${route.sessionId}/${route.agentId ?? ''}`}
      sessionId={route.sessionId}
      agentId={route.agentId}
      theme={theme}
      onToggleTheme={toggleTheme}
    />
  ) : (
    <Picker theme={theme} onToggleTheme={toggleTheme} />
  );
}
