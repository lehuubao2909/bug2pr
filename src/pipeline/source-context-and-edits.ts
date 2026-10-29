/**
 * File I/O for the fix loop:
 * - sourceContext: shows the model candidate files with line numbers; large
 *   files are cut to windows around lines that mention the bug's UI strings;
 * - applyEdits: applies search/replace edits, each search text must match
 *   exactly once, and test files may never be touched.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_FULL_LINES = 450;
const WINDOW = 70;
const PROTECTED = /(\.test\.|\.spec\.|__tests__|\/e2e\/)/;

export type Edit = { file: string; search: string; replace: string };

export async function sourceContext(repoDir: string, files: string[], terms: string[]): Promise<string> {
  const parts: string[] = [];
  for (const file of files) {
    const lines = (await readFile(path.join(repoDir, file), 'utf8')).split('\n');
    const numbered = (from: number, to: number) => lines.slice(from, to).map((l, i) => `${String(from + i + 1).padStart(5)}| ${l}`).join('\n');
    if (lines.length <= MAX_FULL_LINES) {
      parts.push(`=== ${file} (${lines.length} lines)\n${numbered(0, lines.length)}`);
      continue;
    }
    // Merge windows around lines that mention any term.
    const needles = terms.map((t) => t.toLowerCase());
    const ranges: [number, number][] = [];
    lines.forEach((l, i) => {
      if (needles.some((n) => l.toLowerCase().includes(n))) ranges.push([Math.max(0, i - WINDOW), Math.min(lines.length, i + WINDOW)]);
    });
    const merged = ranges.sort((a, b) => a[0] - b[0]).reduce<[number, number][]>((acc, r) => {
      const last = acc.at(-1);
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else acc.push([...r]);
      return acc;
    }, []);
    const windows = (merged.length ? merged : [[0, MAX_FULL_LINES] as [number, number]]).map(([a, b]) => numbered(a, b));
    parts.push(`=== ${file} (${lines.length} lines, excerpts)\n${windows.join('\n   ...\n')}`);
  }
  return parts.join('\n\n');
}

/** Applies all edits or none; returns problems for the model when any edit is invalid. */
export async function applyEdits(repoDir: string, allowed: string[], edits: Edit[]): Promise<string[]> {
  const problems: string[] = [];
  const next = new Map<string, string>();
  for (const e of edits) {
    if (PROTECTED.test(e.file)) problems.push(`${e.file}: test files must not be edited`);
    else if (!allowed.includes(e.file)) problems.push(`${e.file}: not one of the provided files (${allowed.join(', ')})`);
    if (problems.length) continue;
    const current = next.get(e.file) ?? (await readFile(path.join(repoDir, e.file), 'utf8'));
    const count = current.split(e.search).length - 1;
    if (count !== 1) {
      problems.push(`${e.file}: search text found ${count} times (must be exactly once; copy it verbatim without line numbers)`);
      continue;
    }
    next.set(e.file, current.replace(e.search, () => e.replace));
  }
  if (problems.length) return problems;
  for (const [file, text] of next) await writeFile(path.join(repoDir, file), text);
  return [];
}
