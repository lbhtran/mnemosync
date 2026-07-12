// Monaco is served as pre-built static files from /vs (copied from
// node_modules/monaco-editor/min/vs at build time — see the prebuild
// script). No CDN: the app must work fully offline, and bundling Monaco
// through Rollup OOMs on low-memory machines (e.g. a Raspberry Pi).
import { loader } from '@monaco-editor/react';

loader.config({ paths: { vs: '/vs' } });

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript', json: 'json', jsonl: 'json',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', swift: 'swift',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', markdown: 'markdown', yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', sh: 'shell', bash: 'shell', zsh: 'shell',
  sql: 'sql', xml: 'xml', svg: 'xml', php: 'php', lua: 'lua', r: 'r',
  dockerfile: 'dockerfile', tf: 'hcl', vue: 'html', graphql: 'graphql',
};

export function languageFor(path: string): string {
  const base = path.split('/').pop() ?? '';
  if (/^dockerfile$/i.test(base)) return 'dockerfile';
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
  return EXT_LANG[ext] ?? 'plaintext';
}

/** Binary-ish content guard: don't feed junk to the editor. */
export function looksBinary(content: string): boolean {
  if (!content) return false;
  const sample = content.slice(0, 4000);
  let weird = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0) return true;
    if (c < 9 || (c > 13 && c < 32)) weird++;
  }
  return weird / sample.length > 0.05;
}
