// Defensive JSONL → raw record parsing. Never crashes on bad input:
// unknown types are passed through for normalize.ts to skip-and-log,
// malformed lines (including a truncated final line) become warnings.

import { readFileSync } from 'node:fs';

export interface RawRecord {
  type: string;
  [key: string]: unknown;
}

export interface ParseResult {
  records: RawRecord[];
  warnings: string[];
}

export function parseJsonlText(text: string): ParseResult {
  const records: RawRecord[] = [];
  const warnings: string[] = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      const isLast = i >= lines.length - 2;
      warnings.push(
        isLast
          ? `line ${i + 1}: unparseable final line (session likely killed mid-write), skipped`
          : `line ${i + 1}: malformed JSON, skipped`,
      );
      continue;
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      warnings.push(`line ${i + 1}: not a JSON object, skipped`);
      continue;
    }
    const rec = obj as Record<string, unknown>;
    if (typeof rec.type !== 'string') {
      warnings.push(`line ${i + 1}: record has no "type" field, skipped`);
      continue;
    }
    records.push(rec as RawRecord);
  }

  return { records, warnings };
}

export function parseJsonlFile(filePath: string): ParseResult {
  return parseJsonlText(readFileSync(filePath, 'utf8'));
}
