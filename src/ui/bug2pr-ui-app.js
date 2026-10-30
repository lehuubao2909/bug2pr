// Bug2PR demo UI: start view (pick a video, target app, model mode) and live run view.
import { $, esc, renderEvent, resetRunView } from './bug2pr-ui-render-events.js';

const state = { video: '', title: '', bugs: [], apps: [], runStartedAt: 0, timer: 0, liveRunId: 0 };
const seconds = (t) => { const [m, s] = t.split(':'); return Number(m) * 60 + Number(s); };
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Stage cards live in the "How it works" section on the start view and under the run header on the run view. */
function setView(view) {
  document.body.dataset.view = view;
  const stages = $('stages');
  if (view === 'run') $('runView').insertBefore(stages, $('banner'));
  else $('howItWorks').appendChild(stages);
  $('crumb').textContent = view === 'run' ? state.title || 'Run' : 'New run';
  $('newRun').hidden = view !== 'run';
  $('lastRun').hidden = view === 'run' || !state.liveRunId;
  // A video loaded while hidden is not painted until it seeks again.
  const v = $('video');
  if (view === 'run' && v.readyState) v.currentTime = v.currentTime || 1;
  window.scrollTo({ top: 0 });
}

function selectVideo(video, title, app) {
  state.video = video; state.title = title;
  for (const el of document.querySelectorAll('.bug-card, .drop')) el.classList.toggle('selected', el.dataset.video === video);
  if (app) { $('app').value = app; showAppUrl(); }
}

function showAppUrl() {
  const app = state.apps.find((a) => a.name === $('app').value);
  $('appUrl').textContent = app ? `Must be running at ${app.url}` : '';
}

async function loadChoices() {
  [state.bugs, state.apps] = await Promise.all([fetch('/api/bugs').then((r) => r.json()), fetch('/api/apps').then((r) => r.json())]);
  $('app').innerHTML = state.apps.map((a) => `<option value="${esc(a.name)}">${esc(a.name === 'actual' ? 'Actual Budget' : a.name)}</option>`).join('');
  $('app').onchange = showAppUrl;
  $('bugGrid').insertAdjacentHTML('afterbegin', state.bugs.map((b) => `
    <button class="bug-card" data-bug="${esc(b.id)}" data-video="${esc(b.video)}">
      <video src="/media?path=${encodeURIComponent(b.video)}" muted loop playsinline preload="metadata"></video>
      <div><b>${esc(b.title)}</b><span class="pill">${esc(b.app === 'actual' ? 'Actual Budget' : b.app)}</span> ${b.kind === 'real' ? '<span class="pill violet">real issue</span>' : ''}</div>
    </button>`).join(''));
  for (const card of document.querySelectorAll('.bug-card')) {
    const bug = state.bugs.find((b) => b.id === card.dataset.bug);
    card.onclick = () => selectVideo(bug.video, bug.title, bug.app);
    // Poster frame from the middle of the recording (the first frames are often a blank page); preview on hover.
    const v = card.querySelector('video');
    v.onloadedmetadata = () => { v.currentTime = v.duration * 0.55; };
    card.onmouseenter = () => v.play().catch(() => {});
    card.onmouseleave = () => v.pause();
  }
  const first = state.bugs.find((b) => b.id === 'shadcn-search-by-id') ?? state.bugs[0];
  if (first) selectVideo(first.video, first.title, first.app);
}

async function upload(file) {
  if (!file || !file.name.endsWith('.mp4')) return alert('Please choose an .mp4 screen recording');
  const drop = $('drop');
  drop.querySelector('b').textContent = `Uploading ${file.name}…`;
  const r = await (await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: 'PUT', body: file })).json();
  drop.dataset.video = r.video;
  drop.querySelector('b').textContent = file.name;
  drop.querySelector('small').textContent = 'your recording · pick its app below';
  selectVideo(r.video, file.name);
}

const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); upload(e.dataTransfer.files[0]); };
$('fileInput').onchange = (e) => upload(e.target.files[0]);

$('run').onclick = async () => {
  $('run').disabled = true;
  const r = await fetch('/api/run', { method: 'POST', body: JSON.stringify({ video: state.video, app: $('app').value, privateMode: $('private').checked }) });
  if (!r.ok) { alert((await r.json()).error); $('run').disabled = false; }
};
$('newRun').onclick = () => setView('start');
$('lastRun').onclick = () => setView('run');

function tick() { $('timer').textContent = clock((Date.now() - state.runStartedAt) / 1000); }

/** A `start` event resets the run view and mirrors the run's choices, so the page never mixes two runs. */
function onStart(e, live) {
  resetRunView();
  state.liveRunId = e.runId;
  const bug = state.bugs.find((b) => b.video === e.video);
  state.title = bug?.title ?? e.bugId;
  $('runTitle').textContent = state.title;
  const app = state.apps.find((a) => a.name === e.app);
  $('runMeta').innerHTML = `<span class="pill">${esc(e.app === 'actual' ? 'Actual Budget' : e.app)}</span>
    <span class="pill ${e.privateMode ? 'violet' : ''}">${e.privateMode ? 'Private mode · open weights' : 'Meta Model API'}</span>`;
  $('browserUrl').textContent = app?.url ?? 'localhost';
  $('video').src = `/media?path=${encodeURIComponent(e.video)}#t=1`;
  clearInterval(state.timer);
  state.runStartedAt = Date.now(); $('timer').textContent = '0:00';
  if (live) { state.timer = setInterval(tick, 500); $('run').disabled = true; setView('run'); }
}

async function connect() {
  const status = await fetch('/api/status').then((r) => r.json());
  const events = new EventSource('/api/events');
  events.onmessage = (m) => {
    const e = JSON.parse(m.data);
    // Replayed history of a finished run renders in the background; only live runs take over the screen.
    const live = !(e.type === 'start' && e.runId === status.runId && !status.running);
    if (e.type === 'start') return onStart(e, live || document.body.dataset.view === 'run');
    renderEvent(e, (done) => {
      clearInterval(state.timer);
      $('timer').textContent = clock(done.seconds);
      $('run').disabled = false;
      $('lastRun').hidden = document.body.dataset.view === 'run';
    });
  };
  // On reconnect the server replays the whole run from `start`, which resets the view.
  events.onerror = () => { status.running = true; };
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-t]');
  if (t) { $('video').currentTime = seconds(t.dataset.t); $('video').play(); }
});
resetRunView();
setView('start');
await loadChoices();
connect();
