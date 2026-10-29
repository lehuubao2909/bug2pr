/**
 * Narrows the repository down to the few source files most likely to hold
 * the bug. Strings the failing test interacts with (button names,
 * placeholders, test ids, asserted text) are grepped in the source dirs;
 * files are ranked by how many distinct strings they contain, and the
 * localize model (Meta API or open weights, see text-completion-providers)
 * picks the final shortlist from those hits.
 */
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { completeText } from '../lib/text-completion-providers.js';
import type { ScopedLocator, SpecAction } from '../lib/spec-actions.js';
import type { TargetApp } from '../targets/target-apps.js';
import type { ExpectedAssertion } from './propose-expected-assertion.js';
import { parseModelJson, type Repro } from './repro-steps-schema.js';

const TEST_FILE = /(\.test\.|\.spec\.|__tests__|\/e2e\/|\/locale|\.stories\.)/;

function locatorTerms(l: ScopedLocator | ExpectedAssertion['locator']): string[] {
  const loc = l as { name?: string; value?: string; within?: { locator: { name?: string; value?: string } } };
  return [loc.name, loc.value, loc.within?.locator.name, loc.within?.locator.value].filter((t): t is string => !!t && t.length >= 3);
}

export function searchTerms(actions: SpecAction[], assertion: ExpectedAssertion): string[] {
  const terms = actions.flatMap((a) => (a.kind === 'click' || a.kind === 'waitFor' ? locatorTerms(a.locator) : []));
  terms.push(...locatorTerms(assertion.locator));
  // Strip trailing counts like "In Progress 24" and generic CSS selectors.
  return [...new Set(terms.map((t) => t.replace(/\s+\d+$/, '').trim()).filter((t) => t.length >= 3 && !/^(table|tbody|tr)$/.test(t)))];
}

function grepFiles(app: TargetApp, term: string): string[] {
  try {
    return execFileSync('git', ['-C', app.repoDir, 'grep', '-l', '-F', '-i', term, '--', ...app.sourceDirs], { stdio: 'pipe' })
      .toString().split('\n').filter((f) => f && !TEST_FILE.test(f));
  } catch {
    return []; // git grep exits 1 when nothing matches
  }
}

function hitLines(app: TargetApp, file: string, terms: string[]): string {
  const args = ['-C', app.repoDir, 'grep', '-n', '-F', '-i', ...terms.flatMap((t) => ['-e', t]), '--', file];
  try {
    return execFileSync('git', args, { stdio: 'pipe' }).toString().split('\n').slice(0, 6).join('\n');
  } catch {
    return '';
  }
}

export async function localizeBugFiles(app: TargetApp, repro: Repro, terms: string[], max = 4): Promise<string[]> {
  const score = new Map<string, number>();
  for (const term of terms) for (const f of grepFiles(app, term)) score.set(f, (score.get(f) ?? 0) + 1);
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([f]) => f);
  if (ranked.length <= max) return ranked;

  const listing = ranked.map((f) => `### ${f}\n${hitLines(app, f, terms)}`).join('\n');
  const response = await completeText('localize', [
    `Bug: expected "${repro.expected}", actual "${repro.actual}".\nUI strings involved: ${terms.join(' | ')}\n` +
      `Candidate files with matching lines:\n${listing}\n\nReturn ONLY JSON {"files":["path", ...]} with at most ${max} files most likely to contain the faulty logic (prefer logic/components over pure markup or translations).`,
  ]);
  const picked = z.object({ files: z.array(z.string()) }).parse(parseModelJson(response.text)).files;
  const valid = picked.filter((f) => ranked.includes(f));
  return valid.length ? valid.slice(0, max) : ranked.slice(0, max);
}
