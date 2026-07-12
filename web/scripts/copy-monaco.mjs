// Copy Monaco's pre-built AMD distribution into public/vs so it is served
// locally (no CDN) without being part of the Rollup bundle.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'node_modules', 'monaco-editor', 'min', 'vs');
const dest = join(root, 'public', 'vs');

if (!existsSync(src)) {
  console.error('monaco-editor not installed; run npm install first');
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log('copied monaco →', dest);
