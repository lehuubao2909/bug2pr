/**
 * Evaluates video -> repro-steps extraction on every bug in eval/bugs.
 * Runs each bug in both modes ("video" only vs SAM-"grounded"), several
 * times, judges each result against truth.json and prints a summary table.
 * SAM cursor tracks are cached per video (runs/cursor-cache) to save cost.
 *
 * Usage: npm run eval:extract [-- --runs 2] [-- <bug-id> ...]
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { judgeExtraction, type Truth, type Verdict } from '../src/eval/judge-repro-extraction.js';
import { extractReproSteps, type ExtractMode } from '../src/pipeline/extract-repro-steps.js';
import type { CursorSample } from '../src/pipeline/track-cursor-with-sam.js';
import { runDir, writeJson } from '../src/lib/write-run-artifact.js';

const MODES: ExtractMode[] = ['video', 'grounded'];

function parseArgs(argv: string[]): { runs: number; ids: string[] } {
  const runsAt = argv.indexOf('--runs');
  const runs = runsAt >= 0 ? Number(argv[runsAt + 1]) : 1;
  const ids = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--runs');
  return { runs, ids };
}

/** Cursor track cache keyed by the video's mtime, so re-recorded videos are re-tracked. */
async function cachedTrack(id: string, video: string): Promise<CursorSample[] | undefined> {
  try {
    const cache = JSON.parse(await readFile(path.join('runs/cursor-cache', `${id}.json`), 'utf8')) as { mtimeMs?: number; track?: CursorSample[] };
    return cache.mtimeMs === (await stat(video)).mtimeMs ? cache.track : undefined;
  } catch {
    return undefined;
  }
}

type Row = { id: string; mode: ExtractMode; run: number; verdict?: Verdict; error?: string; interactions: number; ms?: unknown };

async function main(): Promise<void> {
  const { runs, ids: wanted } = parseArgs(process.argv.slice(2));
  const ids = wanted.length ? wanted : (await readdir('eval/bugs')).sort();
  const outDir = await runDir('eval-extraction');
  const cacheDir = await runDir('cursor-cache');
  const rows: Row[] = [];

  for (const id of ids) {
    const video = path.join('eval/bugs', id, 'video.mp4');
    const truth = JSON.parse(await readFile(path.join('eval/bugs', id, 'truth.json'), 'utf8')) as Truth;
    for (const mode of MODES) {
      for (let run = 1; run <= runs; run++) {
        try {
          const result = await extractReproSteps(video, mode, { cachedTrack: mode === 'grounded' ? await cachedTrack(id, video) : undefined });
          if (mode === 'grounded') await writeJson(cacheDir, `${id}.json`, { mtimeMs: (await stat(video)).mtimeMs, track: result.track });
          const verdict = await judgeExtraction(truth, result.repro);
          rows.push({ id, mode, run, verdict, interactions: result.interactions.length, ms: result.ms });
          await writeJson(outDir, `${id}.${mode}.${run}.json`, { repro: result.repro, interactions: result.interactions, verdict, ms: result.ms, usage: result.usage });
          console.log(`${id} [${mode} #${run}] steps ${verdict.stepsMatched}/${verdict.stepsTotal} extra ${verdict.extraSteps} diagnosis ${verdict.diagnosisCorrect ? 'OK' : 'WRONG'} - ${verdict.notes}`);
        } catch (err) {
          rows.push({ id, mode, run, error: String(err).slice(0, 300), interactions: 0 });
          console.log(`${id} [${mode} #${run}] ERROR ${String(err).slice(0, 200)}`);
        }
      }
    }
  }

  // Summary per mode: step recall, extra steps per run, diagnosis accuracy.
  const summary = MODES.map((mode) => {
    const ok = rows.filter((r) => r.mode === mode && r.verdict).map((r) => r.verdict!);
    const matched = ok.reduce((s, v) => s + v.stepsMatched, 0);
    const total = ok.reduce((s, v) => s + v.stepsTotal, 0);
    return {
      mode,
      runs: rows.filter((r) => r.mode === mode).length,
      errors: rows.filter((r) => r.mode === mode && r.error).length,
      stepRecall: total ? +(matched / total).toFixed(3) : 0,
      extraStepsPerRun: ok.length ? +(ok.reduce((s, v) => s + v.extraSteps, 0) / ok.length).toFixed(2) : 0,
      diagnosisAccuracy: ok.length ? +(ok.filter((v) => v.diagnosisCorrect).length / ok.length).toFixed(3) : 0,
    };
  });
  console.table(summary);
  await writeJson(outDir, 'summary.json', { runs, ids, summary, rows });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
