/**
 * Local demo server for the Bug2PR UI (no framework, node:http only).
 *   GET  /                      demo page
 *   GET  /ui/<file>             page scripts and styles (whitelisted)
 *   GET  /api/apps              target apps (name, url)
 *   GET  /api/status            {runId, running} of the latest run
 *   GET  /api/bugs              eval bugs (id, title, app, kind, video)
 *   GET  /media?path=...        serves an mp4 from eval/bugs or runs/uploads
 *   PUT  /api/upload?name=x.mp4 raw mp4 body -> runs/uploads/
 *   POST /api/run               {video, app, privateMode} -> starts a run
 *   GET  /api/events            SSE stream of the current run (replays history; first event is `start`)
 * One run at a time; it is a local tool, so there is no auth.
 *
 * Usage: npm run ui   (http://localhost:4100)
 */
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { runBug2Pr, type Bug2PrEvent } from '../pipeline/run-bug2pr.js';
import { targetApp, targetApps } from '../targets/target-apps.js';

const PORT = Number(process.env.UI_PORT ?? 4100);
const MEDIA_ROOTS = [path.resolve('eval/bugs'), path.resolve('runs/uploads')];
const UI_ASSETS: Record<string, string> = {
  'bug2pr-ui-styles.css': 'text/css; charset=utf-8',
  'bug2pr-ui-app.js': 'text/javascript; charset=utf-8',
  'bug2pr-ui-render-events.js': 'text/javascript; charset=utf-8',
};

/** `start` opens every run so a client (or a reconnect) can reset its view before the replayed history. */
type UiEvent = Bug2PrEvent | { type: 'start'; runId: number; bugId: string; video: string; app: string; privateMode: boolean };

let history: UiEvent[] = [];
let running = false;
let runId = 0;
const clients = new Set<ServerResponse>();

function broadcast(event: UiEvent): void {
  history.push(event);
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) c.write(line);
}

const body = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};
const json = (res: ServerResponse, code: number, data: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(data));
};

/** Resolves a media path and refuses anything outside the allowed folders. */
function safeMedia(p: string): string | undefined {
  const abs = path.resolve(p);
  return MEDIA_ROOTS.some((root) => abs.startsWith(root + path.sep)) && abs.endsWith('.mp4') ? abs : undefined;
}

async function listBugs() {
  const ids = (await readdir('eval/bugs')).sort();
  return Promise.all(ids.map(async (id) => {
    const truth = JSON.parse(await readFile(path.join('eval/bugs', id, 'truth.json'), 'utf8')) as { title?: string; app: string; branch: string; kind: string };
    return { id, title: truth.title ?? id, app: truth.app, branch: truth.branch, kind: truth.kind, video: path.join('eval/bugs', id, 'video.mp4') };
  }));
}

async function startRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (running) return json(res, 409, { error: 'a run is already in progress' });
  const { video, app, privateMode } = JSON.parse((await body(req)).toString()) as { video: string; app: string; privateMode: boolean };
  const file = safeMedia(video);
  if (!file) return json(res, 400, { error: 'unknown video' });
  // Private mode routes the code-touching steps to open weights on Baseten.
  process.env.FIX_PROVIDER = privateMode ? 'baseten' : 'meta';
  process.env.LOCALIZE_PROVIDER = privateMode ? 'baseten' : 'meta';
  // A sample recording runs against its seeded bug branch (a previous run leaves the repo on its PR branch).
  const sample = (await listBugs()).find((b) => path.resolve(b.video) === file && b.app === app);
  if (sample) {
    try { execFileSync('git', ['-C', targetApp(app).repoDir, 'checkout', '-q', sample.branch], { stdio: 'pipe' }); }
    catch (err) { return json(res, 409, { error: `could not check out ${sample.branch}: ${String(err).slice(0, 200)}` }); }
  }
  const bugId = `${path.basename(path.dirname(file)) === 'uploads' ? path.basename(file, '.mp4') : path.basename(path.dirname(file))}-ui`;
  history = [];
  running = true;
  const started = performance.now();
  json(res, 202, { bugId });
  broadcast({ type: 'start', runId: ++runId, bugId, video: path.relative(process.cwd(), file), app, privateMode });
  runBug2Pr(bugId, file, targetApp(app), broadcast)
    .catch((err) => {
      broadcast({ type: 'log', stage: 'understand', message: `Error: ${String(err).slice(0, 400)}` });
      broadcast({ type: 'done', status: 'failed', seconds: Math.round((performance.now() - started) / 1000) });
    })
    .finally(() => (running = false));
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await readFile(path.resolve('src/ui/index.html')));
      return;
    }
    const asset = url.pathname.startsWith('/ui/') ? url.pathname.slice(4) : '';
    if (req.method === 'GET' && UI_ASSETS[asset]) {
      res.writeHead(200, { 'content-type': UI_ASSETS[asset] }).end(await readFile(path.resolve('src/ui', asset)));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/apps') {
      return json(res, 200, Object.values(targetApps).map((a) => ({ name: a.name, url: a.url })));
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { runId, running });
    if (req.method === 'GET' && url.pathname === '/api/bugs') return json(res, 200, await listBugs());
    if (req.method === 'GET' && url.pathname === '/media') {
      const file = safeMedia(url.searchParams.get('path') ?? '');
      if (!file) return json(res, 404, { error: 'not found' });
      // Range support lets the browser seek (timestamp links, poster frames).
      const size = (await stat(file)).size;
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
      if (!range) {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': size, 'accept-ranges': 'bytes' });
        return void createReadStream(file).pipe(res);
      }
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, { 'content-type': 'video/mp4', 'content-length': end - start + 1, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}` });
      return void createReadStream(file, { start, end }).pipe(res);
    }
    if (req.method === 'PUT' && url.pathname === '/api/upload') {
      const name = (url.searchParams.get('name') ?? 'upload.mp4').replace(/[^\w.-]/g, '_');
      if (!name.endsWith('.mp4')) return json(res, 400, { error: 'mp4 only' });
      await mkdir('runs/uploads', { recursive: true });
      const target = path.join('runs/uploads', name);
      await writeFile(target, await body(req));
      return json(res, 201, { video: target });
    }
    if (req.method === 'POST' && url.pathname === '/api/run') return startRun(req, res);
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      for (const e of history) res.write(`data: ${JSON.stringify(e)}\n\n`);
      clients.add(res);
      return void req.on('close', () => clients.delete(res));
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}).listen(PORT, () => console.log(`Bug2PR UI on http://localhost:${PORT}`));
