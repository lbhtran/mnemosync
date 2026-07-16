// Defensive JSONL → raw record parsing. Never crashes on bad input:
// unknown types are passed through for normalize.ts to skip-and-log,
// malformed lines (including a truncated final line) become warnings.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface RawRecord {
  type: string;
  [key: string]: unknown;
}

export interface ParseResult {
  records: RawRecord[];
  warnings: string[];
}

function parseLine(
  line: string,
  lineNum: number,
  isLast: boolean,
  records: RawRecord[],
  warnings: string[],
): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    warnings.push(
      isLast
        ? `line ${lineNum}: unparseable final line (session likely killed mid-write), skipped`
        : `line ${lineNum}: malformed JSON, skipped`,
    );
    return;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    warnings.push(`line ${lineNum}: not a JSON object, skipped`);
    return;
  }
  const rec = obj as Record<string, unknown>;
  if (typeof rec.type !== 'string') {
    warnings.push(`line ${lineNum}: record has no "type" field, skipped`);
    return;
  }
  records.push(rec as RawRecord);
}

export function parseJsonlText(text: string): ParseResult {
  const records: RawRecord[] = [];
  const warnings: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    parseLine(lines[i], i + 1, i >= lines.length - 2, records, warnings);
  }
  return { records, warnings };
}

/** Streams the transcript line-by-line rather than loading the whole file
 *  (which can be a few hundred MB) into memory as both a string and a line
 *  array — the pattern discover.ts's cheap scan already uses. */
export async function parseJsonlFile(filePath: string): Promise<ParseResult> {
  const records: RawRecord[] = [];
  const warnings: string[] = [];
  const rl = createInterface({ input: createReadStream(filePath, 'utf8'), crlfDelay: Infinity });

  // One-line lookahead so the true final line (and only it — readline never
  // hands us the trailing empty entry text.split('\n') would) gets flagged
  // as a possible mid-write truncation rather than plain "malformed JSON".
  let pending: { line: string; num: number } | undefined;
  let lineNum = 0;
  for await (const line of rl) {
    lineNum++;
    if (pending) parseLine(pending.line, pending.num, false, records, warnings);
    pending = { line, num: lineNum };
  }
  if (pending) parseLine(pending.line, pending.num, true, records, warnings);

  return { records, warnings };
}
