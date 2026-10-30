// Renders Bug2PR pipeline events (SSE from /api/events) into the run view.
export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Each stage card explains the product on the start view and tracks progress during a run.
export const STAGES = [
  ['understand', 'Understand', 'SAM 3.1 + Muse Spark', 'Tracks the cursor to find every click, then turns the video into repro steps.'],
  ['replay', 'Reproduce live', 'Muse Spark computer use', 'Drives a real browser until the bug shows up, recording stable locators.'],
  ['test', 'Failing test', 'Verification gate', 'Generates a Playwright test that must fail on the bug 3/3 times.'],
  ['fix', 'Fix', 'Muse Wonder or Spark Open', 'Edits the code until the test passes and the repo’s own checks stay green.'],
  ['pr', 'Pull request', 'Human sign-off', 'Prepares a small, reviewable PR on a local branch. You decide to push.'],
];

const GATE_LABEL = {
  'failed-at-assertion': ['fails on bug', 'ok'],
  passed: ['passes on bug', 'bad'],
  'failed-before-assertion': ['broke before assertion', 'bad'],
  error: ['error', 'bad'],
};

/** Puts every panel back to its empty state (new run, or SSE reconnect before history replay). */
export function resetRunView() {
  $('stages').innerHTML = STAGES.map(([id, name, model, what], i) => `
    <div class="stage" id="st-${id}">
      <div class="st-top"><span class="st-icon">${i + 1}</span><b>${name}</b></div>
      <span class="st-model">${model}</span>
      <small class="st-what">${what}</small>
      <small class="st-detail" hidden></small>
    </div>`).join('');
  const empties = {
    interactions: 'Tracking the cursor through every frame…',
    steps: 'Steps appear once the video is understood.',
    gate: 'The test must fail on the buggy app 3/3 times.',
    fix: 'Accepted only if the test passes and the repo’s own checks stay green.',
    pr: 'Prepared locally, waiting for your sign-off.',
  };
  for (const [id, text] of Object.entries(empties)) { $(id).className = 'empty'; $(id).textContent = text; }
  $('actions').innerHTML = '';
  $('shot').removeAttribute('src'); $('shotEmpty').hidden = false;
  $('turn').textContent = 'waiting';
  $('specBox').hidden = true; $('diff').hidden = true; $('model').hidden = true; $('banner').hidden = true;
}

/** Clears an empty-state placeholder the first time real content arrives. */
function fill(id) {
  const el = $(id);
  if (el.classList.contains('empty')) { el.className = ''; el.innerHTML = ''; }
  return el;
}

function describe(a) {
  if (a.kind === 'click') {
    const l = a.locator;
    return `click ${l.by === 'role' ? `${l.role} "${l.name}"` : `${l.by} "${l.value}"`}${l.within?.hasText ? ` in row "${l.within.hasText}"` : ''}`;
  }
  if (a.kind === 'type') return `type "${a.text}"`;
  if (a.kind === 'press') return `press ${a.key}`;
  return a.kind;
}

export function showOutcome(kind, title, detail) {
  const icon = { ok: '✓', warn: '!', bad: '✕' }[kind];
  $('banner').className = `outcome ${kind}`;
  $('banner').innerHTML = `<span class="big">${icon}</span><div><b>${esc(title)}</b><small>${esc(detail)}</small></div>`;
  $('banner').hidden = false;
}

/** Applies one pipeline event; `onDone` lets the app stop its timer and re-enable controls. */
export function renderEvent(e, onDone) {
  switch (e.type) {
    case 'stage': {
      const el = $(`st-${e.stage}`); if (!el) break;
      el.className = `stage ${e.status}`;
      el.querySelector('.st-icon').textContent = { done: '✓', failed: '✕', escalated: '!' }[e.status] ?? el.querySelector('.st-icon').textContent;
      if (e.detail) { const d = el.querySelector('.st-detail'); d.hidden = false; d.textContent = e.detail; }
      if (e.stage === 'fix' && e.status === 'running' && e.detail) { $('model').hidden = false; $('model').textContent = e.detail; }
      break;
    }
    case 'interactions':
      fill('interactions').innerHTML = e.items.length
        ? `<div class="chips">${e.items.map((i, n) => `<span class="pill">#${n} <span class="t" data-t="${i.start}">${i.start}</span> at ${i.x},${i.y}</span>`).join('')}</div>`
        : '<div class="empty">No cursor interactions detected; steps come from the video alone.</div>';
      break;
    case 'steps':
      fill('steps').innerHTML = `<ol class="steps">${e.repro.steps.map((s) => `<li><span><span class="t" data-t="${esc(s.t)}">${esc(s.t)}</span> ${esc(s.action)} <b>${esc(s.target)}</b>${s.value ? ` → <code>${esc(s.value)}</code>` : ''}</span></li>`).join('')}</ol>
        <div class="kv"><span>Expected</span><span>${esc(e.repro.expected)}</span><span>Actual</span><span>${esc(e.repro.actual)}</span></div>`;
      break;
    case 'turn':
      $('shot').src = e.screenshot; $('shotEmpty').hidden = true;
      $('turn').textContent = `turn ${e.turn} · ${e.note}`;
      for (const a of e.actions) $('actions').insertAdjacentHTML('beforeend', `<li>${esc(describe(a))}</li>`);
      $('actions').scrollTop = 1e9;
      break;
    case 'gate': {
      // A good regression test FAILS on the buggy app, at the expected-behaviour assertion.
      const [label, kind] = GATE_LABEL[e.status] ?? [e.status, 'bad'];
      fill('gate').insertAdjacentHTML('beforeend', `<div class="attempt"><div><span class="n">Assertion ${e.attempt}</span><p>${esc(e.description)}</p></div><span class="pill ${kind}">${esc(label)}</span></div>`);
      $('specBox').hidden = false; $('spec').textContent = e.spec;
      break;
    }
    case 'fixAttempt':
      fill('fix').insertAdjacentHTML('beforeend', `<div class="attempt"><div><span class="n">Attempt ${e.n}</span><p>${esc(e.rootCause)}</p>${e.problems.length ? `<p>${esc(e.problems[0].slice(0, 220))}</p>` : ''}</div>
        <span class="pill ${e.problems.length ? 'bad' : 'ok'}">${e.problems.length ? 'rejected' : 'all checks green'}</span></div>`);
      break;
    case 'diff':
      $('diff').hidden = false;
      $('diff').innerHTML = e.diff.split('\n').map((l) => `<span class="${/^\+(?!\+)/.test(l) ? 'add' : /^-(?!-)/.test(l) ? 'del' : ''}">${esc(l)}</span>`).join('\n');
      break;
    case 'pr':
      fill('pr').innerHTML = e.branch
        ? `<div class="pr-card"><b>${esc(e.title)}</b><div class="meta"><span class="pill">⎇ ${esc(e.branch)}</span><span class="pill">${esc(e.commit)}</span><span class="pill warn">awaiting sign-off</span></div>
           <details><summary>PR description</summary><pre>${esc(e.body)}</pre></details></div>`
        : `<div class="attempt"><p>${esc(e.reason)}</p><span class="pill warn">escalated</span></div>`;
      break;
    case 'log':
      console.log(e.message);
      if (e.message.startsWith('Error')) showOutcome('bad', 'Run failed', e.message.slice(0, 300));
      break;
    case 'done': {
      if (e.status === 'pr-ready') showOutcome('ok', `Verified fix ready for review in ${e.seconds}s`, 'The test fails on the bug and passes on the fix, repo checks are green. Review the branch below; nothing has been pushed.');
      else if (e.status === 'escalated') showOutcome('warn', `Escalated to a human after ${e.seconds}s`, 'The agent could not prove its work, so it stopped instead of guessing.');
      else if ($('banner').hidden) showOutcome('bad', `Run failed after ${e.seconds}s`, 'See the stage marked in red.');
      onDone?.(e);
      break;
    }
  }
}
