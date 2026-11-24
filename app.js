/* SSAT Climb — offline-first verbal trainer. State lives in localStorage and is saved after every action. */
(() => {
'use strict';
const KEY = 'climb.v1';
const TEST_DAY = new Date(2026, 11, 12);
const DAY = 86400000;
const INTERVALS = [0, 1, 2, 4, 7, 14]; // days per Leitner box
const SUMMITS = [[0,'Basecamp'],[1917,'Mt. Washington'],[4806,'Mont Blanc'],[5895,'Kilimanjaro'],[6190,'Denali'],[6961,'Aconcagua'],[8849,'Everest']];
const POS = {n:'noun', v:'verb', adj:'adjective', adv:'adverb'};
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = (a, n) => shuffle(a).slice(0, n);
const now = () => Date.now();
const todayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- state ----------
function fresh() {
  return { v: 1, words: {}, custom: {}, mine: {}, stats: { alt: 0, streak: 0, lastDay: null, days: {}, syn: [], ana: [], bridge: {} },
           sessions: {}, ui: { view: 'home' } };
}
let S;
try { S = JSON.parse(localStorage.getItem(KEY)) || fresh(); } catch (e) { S = fresh(); }
S = Object.assign(fresh(), S);
S.stats = Object.assign(fresh().stats, S.stats); S.mine = S.mine || {};
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }

// ---------- word bank ----------
const BASE = {}; window.WORDS.forEach(e => BASE[e.w] = e);
const entry = w => S.custom[w] || BASE[w];
const isMine = w => !!(S.custom[w] || S.mine[w]);
const allEntries = () => [...window.WORDS, ...Object.values(S.custom).filter(e => !BASE[e.w])];
function ws(w) { // per-word progress
  if (!S.words[w]) S.words[w] = { box: 0, due: 0, right: 0, wrong: 0, intro: false, triage: null };
  return S.words[w];
}
const quizzable = e => e && ((e.s && e.s.length) || e.d);
// related-word clusters so a distractor is never secretly a correct answer
const cluster = new Map();
function rebuildClusters() {
  cluster.clear();
  allEntries().forEach(e => {
    const set = [e.w, ...(e.s || [])].map(x => x.toLowerCase());
    set.forEach(x => { if (!cluster.has(x)) cluster.set(x, new Set()); set.forEach(y => cluster.get(x).add(y)); });
  });
}
rebuildClusters();
const related = (a, b) => a === b || (cluster.get(a) && cluster.get(a).has(b));
// two-hop check: any shared neighbor means the words are too close to be a safe distractor
const near = (c, targets) => { const cc = cluster.get(c) || new Set([c]); return targets.some(t => { const tc = cluster.get(t) || new Set([t]); for (const x of cc) if (tc.has(x)) return true; return false; }); };

function genSyn(w) {
  const e = entry(w);
  if (!e.s || !e.s.length) return genDef(w);
  const correct = e.s[Math.random() < 0.7 ? 0 : Math.min(1, e.s.length - 1)];
  const same = allEntries().filter(x => x.w !== w && (x.p === e.p || !e.p));
  let cands = [];
  same.forEach(x => (x.s || []).slice(0, 2).forEach(c => cands.push(c)));
  cands = [...new Set(cands.map(c => c.toLowerCase()))].filter(c =>
    !near(c, [w, correct.toLowerCase()]) && !(e.s || []).map(t=>t.toLowerCase()).includes(c) && !c.includes(w) && c.split(' ').length <= 2);
  const wrong = pick(cands, 4);
  return { kind: 'syn', w, choices: shuffle([correct, ...wrong]), ans: correct, picked: null, t0: null, ms: null };
}
function genDef(w) {
  const e = entry(w);
  const pool = allEntries().filter(x => x.w !== w && (x.p === e.p || !e.p) && !near(x.w, [w]));
  const wrong = pick(pool, 4).map(x => x.w);
  return { kind: 'def', w, choices: shuffle([w, ...wrong]), ans: w, picked: null, t0: null, ms: null };
}
function genWordQ(w) { const e = entry(w); return (e.s && e.s.length && Math.random() < 0.8) ? genSyn(w) : genDef(w); }

// priority order for word practice
function wordQueue(n) {
  const t = now();
  const list = allEntries().filter(quizzable).map(e => {
    const p = ws(e.w); let score = 0;
    if (p.triage === 'known' && p.box >= 3 && p.due > t) score -= 50;
    if (p.due <= t) score += 30;
    if (isMine(e.w)) score += 40;
    if (e.src === 't1') score += 25;
    if (p.triage === 'no') score += 20;
    if (p.wrong > p.right) score += 15;
    score -= p.box * 6;
    if (p.box >= 4 && p.due > t) score -= 60;
    return { w: e.w, score: score + Math.random() * 8 };
  }).sort((a, b) => b.score - a.score);
  return list.slice(0, n).map(x => x.w);
}

function markWord(w, ok) {
  const p = ws(w);
  if (ok) { p.right++; p.box = Math.min(5, p.box + 1); p.due = now() + INTERVALS[p.box] * DAY; }
  else { p.wrong++; p.box = 0; p.due = now(); }
}

// ---------- analogies ----------
const ANA = {}; window.ANALOGIES.forEach(a => ANA[a.id] = a);
const BR = {}; window.BRIDGES.forEach(b => BR[b.id] = b);
const MISSED_BRIDGES = ['deg','manner','char','cause','lack','func','type','tool']; // bridge types missed on Official Test 1
function stemPair(q) { const [a, rest] = q.split(' is to '); return [a, rest.split(' as')[0]]; }
function anaQueue(n) {
  const b = S.stats.bridge;
  return window.ANALOGIES.map(a => {
    const st = b[a.b] || { n: 0, c: 0 }; const seen = S.stats.ana.filter(x => x.id === a.id);
    let score = Math.random() * 10;
    if (MISSED_BRIDGES.includes(a.b)) score += 8;
    if (st.n) score += (1 - st.c / st.n) * 20;
    if (!seen.length) score += 12;
    if (seen.length && !seen[seen.length - 1].ok) score += 15;
    if (seen.length && seen[seen.length - 1].ok) score -= 10 * seen.length;
    return { id: a.id, score };
  }).sort((x, y) => y.score - x.score).slice(0, n).map(x => ({ kind: 'ana', id: x.id, order: shuffle([0,1,2,3,4]), bridge: null, picked: null, t0: null, ms: null }));
}

// ---------- sessions ----------
function newSession(type) {
  let items = [];
  if (type === 'syn') items = wordQueue(10).map(genWordQ);
  if (type === 'ana') items = anaQueue(6);
  if (type === 'today') {
    const learn = allEntries().filter(e => quizzable(e) && !ws(e.w).intro && (isMine(e.w) || ws(e.w).triage === 'no' || (e.src === 't1' && ws(e.w).triage !== 'known'))).slice(0, 3);
    items = [...learn.map(e => ({ kind: 'learn', w: e.w }))];
    const words = wordQueue(8);
    const anas = anaQueue(4);
    const mixed = [];
    words.forEach((w, i) => { mixed.push(genWordQ(w)); if (i % 2 === 1 && anas.length) mixed.push(anas.shift()); });
    items = items.concat(mixed, anas);
  }
  if (type === 'triage') items = window.WORDS.filter(e => e.src === 't1' && !ws(e.w).triage).map(e => ({ kind: 'triage', w: e.w }));
  S.sessions[type] = { type, items, i: 0, gained: 0, right: 0, total: 0, done: !items.length };
  save();
  return S.sessions[type];
}
const cur = type => S.sessions[type] && !S.sessions[type].done ? S.sessions[type] : null;

function gain(m) { S.stats.alt += m; return m; }
function tickDay() {
  const k = todayKey(); S.stats.days[k] = (S.stats.days[k] || 0) + 1;
  if (S.stats.lastDay !== k && S.stats.days[k] >= 10) {
    const y = todayKey(new Date(now() - DAY));
    S.stats.streak = S.stats.lastDay === y ? S.stats.streak + 1 : 1; S.stats.lastDay = k;
  }
}

// ---------- rendering ----------
const views = {};
function go(view, extra) { S.ui.view = view; if (extra) Object.assign(S.ui, extra); save(); render(); window.scrollTo(0, 0); }
function render() {
  const v = S.ui.view;
  const tab = { home: 'home', today: 'home', triage: 'home', syn: 'syn', ana: 'ana', bridges: 'ana', words: 'words', progress: 'progress' }[v] || 'home';
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('on', b.dataset.go === tab));
  $('#main').innerHTML = (views[v] || views.home)();
}

function altInfo() {
  const a = S.stats.alt; let i = 0; while (i < SUMMITS.length - 1 && a >= SUMMITS[i + 1][0]) i++;
  const next = SUMMITS[i + 1];
  return { a, at: SUMMITS[i][1], next, pct: next ? Math.round(100 * (a - SUMMITS[i][0]) / (next[0] - SUMMITS[i][0])) : 100 };
}
const daysLeft = () => Math.max(0, Math.ceil((TEST_DAY - new Date(new Date().toDateString())) / DAY));

views.home = () => {
  const al = altInfo(); const tri = window.WORDS.filter(e => e.src === 't1' && !ws(e.w).triage).length;
  const td = cur('today'); const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const help = Object.values(S.custom).filter(e => e.lookup === 'failed').length;
  return `
  <header class="hero">
    <div class="kicker">SSAT Climb</div>
    <h1>${daysLeft()} days to test day</h1>
    <div class="alt"><span class="m">${al.a.toLocaleString()} m</span><span class="at">${esc(al.at)}${al.next ? ` → ${esc(al.next[1])}` : ''}</span></div>
    <div class="bar"><i style="width:${al.pct}%"></i></div>
    <div class="sub">${S.stats.streak ? `🔥 ${S.stats.streak}-day streak · ` : ''}${S.stats.days[todayKey()] || 0} answered today</div>
  </header>
  ${!standalone ? `<div class="card tip">Install first: in Safari tap <b>Share → Add to Home Screen</b>, then study only from the home-screen icon. Progress made in Safari won’t carry over.</div>` : ''}
  <button class="cta" data-act="start" data-type="today">${td ? 'Resume today’s climb' : 'Start today’s climb'}<small>${td ? `${td.i + 1} of ${td.items.length}` : '~15 min · words + analogies'}</small></button>
  ${tri ? `<button class="card row" data-act="start" data-type="triage"><b>Sort your Test 1 words</b><span>${tri} left · know it / sort of / no idea</span></button>` : ''}
  ${help ? `<button class="card row warn" data-go="words" data-filter="help"><b>${help} word${help>1?'s':''} couldn’t be looked up</b><span>Check spelling, or ask Dad to send them to Claude</span></button>` : ''}
  <div class="grid2">
    <button class="card tile" data-go="syn"><b>Synonyms</b><span>10 questions</span></button>
    <button class="card tile" data-go="ana"><b>Analogies</b><span>bridge first</span></button>
    <button class="card tile" data-go="bridges"><b>Bridge guide</b><span>${window.BRIDGES.length} relationships</span></button>
    <button class="card tile" data-go="words"><b>My words</b><span>${Object.keys(S.custom).length + Object.keys(S.mine).length} added</span></button>
  </div>
  <div class="card note"><b>Pace on test day (1.5×):</b> synonyms ~30 s each, analogies ~60 s each. Finishing early means you rushed. <b>Use all the time.</b></div>`;
};

function sessionView(type, title) {
  let s = cur(type);
  if (!s) {
    const last = S.sessions[type];
    if (last && last.done && last.total) return type === 'triage'
      ? `<div class="done"><div class="kicker">All sorted</div><h1>${last.total} words</h1><p>The ones you didn’t know now show up first in practice.</p><button class="cta" data-act="start" data-type="today">Start today’s climb</button><button class="ghost wide" data-go="home">Back to basecamp</button></div>`
      : doneView(type, title, last);
    s = newSession(type);
    if (s.done) return `<div class="card">Nothing to do here right now.</div>`;
  }
  const it = s.items[s.i];
  const head = `<div class="shead"><button class="ghost" data-go="home">✕</button><div class="prog"><i style="width:${Math.round(100 * s.i / s.items.length)}%"></i></div><span>${s.i + 1}/${s.items.length}</span></div>`;
  return head + itemView(type, it);
}
function doneView(type, title, s) {
  return `<div class="done"><div class="kicker">${esc(title)}</div><h1>${s.right}/${s.total}</h1><p>+${s.gained} m climbed</p>
    <button class="cta" data-act="again" data-type="${type}">Another round</button><button class="ghost wide" data-go="home">Back to basecamp</button></div>`;
}
views.today = () => sessionView('today', 'Today’s climb');
views.syn = () => sessionView('syn', 'Synonyms');
views.ana = () => `<div class="topline"><h2>Analogies</h2><button class="link" data-go="bridges">Bridge guide</button></div>` + sessionView('ana', 'Analogies');
views.triage = () => sessionView('triage', 'Sorted');

function itemView(type, it) {
  if (!it.t0 && it.kind !== 'learn' && it.kind !== 'triage') { it.t0 = now(); save(); }
  if (it.kind === 'learn') return learnCard(it.w, `<button class="cta" data-act="next" data-type="${type}">Got it</button>`, 'New word');
  if (it.kind === 'triage') {
    const e = entry(it.w);
    return `<div class="qcard"><div class="kicker">From your Test 1 misses</div><div class="stem big">${esc(e.w.toUpperCase())}</div>
      <p class="muted">Do you know this word?</p></div>
      <div class="tri"><button data-act="tri" data-type="${type}" data-v="known">Know it</button><button data-act="tri" data-type="${type}" data-v="sort">Sort of</button><button data-act="tri" data-type="${type}" data-v="no">No idea</button></div>`;
  }
  if (it.kind === 'syn' || it.kind === 'def') {
    const e = entry(it.w);
    const stem = it.kind === 'syn' ? `<div class="stem big">${esc(e.w.toUpperCase())}:</div>` : `<div class="kicker">Which word means…</div><div class="stem">${esc(e.d)}</div>`;
    const ch = it.choices.map((c, k) => {
      let cls = ''; if (it.picked != null) { if (c === it.ans) cls = 'right'; else if (c === it.picked) cls = 'wrong'; }
      return `<button class="ch ${cls}" ${it.picked != null ? 'disabled' : ''} data-act="pick" data-type="${type}" data-k="${k}"><span>${'ABCDE'[k]}</span>${esc(c)}</button>`;
    }).join('');
    let fb = '';
    if (it.picked != null) {
      const ok = it.picked === it.ans;
      fb = `<div class="fb ${ok ? 'ok' : 'no'}">${ok ? 'Correct' : 'Not quite'}${!ok && it.ms < 6000 ? ` — that took ${Math.round(it.ms/1000)} s. Read all five choices first.` : ''}</div>${wordInfo(it.w)}
        <button class="cta" data-act="next" data-type="${type}">Next</button>`;
    }
    return `<div class="qcard">${stem}</div><div class="choices">${ch}</div>${fb}`;
  }
  if (it.kind === 'ana') {
    const a = ANA[it.id]; const [A, B] = stemPair(a.q);
    if (!it.bridge) {
      return `<div class="qcard"><div class="kicker">Step 1 · Name the bridge</div><div class="stem big">${esc(A.toUpperCase())} : ${esc(B.toUpperCase())}</div>
        <p class="muted">How are these two words related? Pick before you see the choices.</p></div>
        <div class="chips">${window.BRIDGES.map(b => `<button data-act="bridge" data-type="${type}" data-b="${b.id}"><b>${esc(b.name)}</b><small>${esc(b.ex)}</small></button>`).join('')}</div>`;
    }
    const mine = BR[it.bridge];
    const ch = it.order.map((idx, k) => {
      let cls = ''; if (it.picked != null) { if (idx === a.a) cls = 'right'; else if (idx === it.picked) cls = 'wrong'; }
      return `<button class="ch ${cls}" ${it.picked != null ? 'disabled' : ''} data-act="anapick" data-type="${type}" data-idx="${idx}"><span>${'ABCDE'[k]}</span>${esc(a.ch[idx])}</button>`;
    }).join('');
    let fb = '';
    if (it.picked != null) {
      const ok = it.picked === a.a, bok = it.bridge === a.b;
      fb = `<div class="fb ${ok ? 'ok' : 'no'}">${ok ? 'Correct' : 'Not quite'}${!ok && it.ms < 10000 ? ` — only ${Math.round(it.ms/1000)} s. Say the bridge sentence, then test each choice.` : ''}</div>
        <div class="info"><p><b>Bridge:</b> ${esc(a.br)} <span class="tag ${bok ? 'ok' : 'no'}">${esc(BR[a.b].name)}${bok ? ' ✓' : ` — you picked ${esc(mine.name)}`}</span></p><p>${esc(a.why)}</p></div>
        <button class="cta" data-act="next" data-type="${type}">Next</button>`;
    }
    return `<div class="qcard"><div class="kicker">Step 2 · Your bridge: ${esc(mine.name)} — “${esc(mine.sent)}”</div><div class="stem">${esc(a.q)}</div></div><div class="choices">${ch}</div>${fb}`;
  }
  return '';
}
function wordInfo(w) {
  const e = entry(w); if (!e) return '';
  return `<div class="info"><p><b>${esc(e.w)}</b> <i>${esc(POS[e.p] || e.p || '')}</i> — ${esc(e.d || 'definition pending')}</p>
    ${e.s && e.s.length ? `<p class="muted">Synonyms: ${esc(e.s.join(', '))}</p>` : ''}${e.r ? `<p class="muted">Tip: ${esc(e.r)}</p>` : ''}${e.e ? `<p class="ex">“${esc(e.e)}”</p>` : ''}</div>`;
}
function learnCard(w, actions, kicker) {
  const e = entry(w);
  return `<div class="qcard"><div class="kicker">${esc(kicker)}</div><div class="stem big">${esc(e.w)}</div></div>${wordInfo(w)}${actions}`;
}

views.bridges = () => `<div class="topline"><h2>Bridge guide</h2><button class="link" data-go="ana">Practice</button></div>
  <div class="card note">Before looking at the choices, make a sentence that links the two words. Then try that exact sentence on every choice. If two choices fit, make the sentence more specific.</div>
  ${window.BRIDGES.map(b => `<div class="card brow ${MISSED_BRIDGES.includes(b.id) ? 'hot' : ''}"><b>${esc(b.name)}</b><span>${esc(b.sent)}</span><small>${esc(b.ex)}${MISSED_BRIDGES.includes(b.id) ? ' · missed on Test 1' : ''}</small></div>`).join('')}`;

views.words = () => {
  const f = S.ui.filter || 'all'; const t = now();
  const rows = allEntries().filter(e => {
    const p = S.words[e.w];
    if (f === 'mine') return isMine(e.w);
    if (f === 't1') return e.src === 't1';
    if (f === 'learning') return p && (p.box < 4 || p.wrong > p.right) && (p.right + p.wrong > 0 || p.intro);
    if (f === 'mastered') return p && p.box >= 4;
    if (f === 'help') return e.lookup === 'failed' || e.lookup === 'pending';
    return true;
  }).sort((a, b) => isMine(b.w) - isMine(a.w) || a.w.localeCompare(b.w));
  const tabs = [['all','All'],['mine','Added'],['t1','Test 1'],['learning','Learning'],['mastered','Mastered']];
  return `<div class="topline"><h2>Words</h2><button class="link" data-act="addopen">+ Add</button></div>
    <div class="seg">${tabs.map(([k, l]) => `<button class="${f === k ? 'on' : ''}" data-act="filter" data-v="${k}">${l}</button>`).join('')}</div>
    <div class="list">${rows.map(e => { const p = S.words[e.w] || { box: 0 };
      const badge = e.lookup === 'pending' ? '<em class="b">looking up…</em>' : e.lookup === 'failed' ? '<em class="b no">not found</em>' : '';
      return `<button class="wrow" data-act="word" data-w="${esc(e.w)}"><b>${esc(e.w)}</b>${badge}<span class="dots">${[1,2,3,4,5].map(i => `<i class="${p.box >= i ? 'f' : ''}"></i>`).join('')}</span></button>`; }).join('') || '<p class="muted pad">Nothing here yet.</p>'}</div>`;
};

views.progress = () => {
  const al = altInfo(); const last = (a, n) => a.slice(-n); const pct = a => a.length ? Math.round(100 * a.filter(x => x.ok).length / a.length) : null;
  const syn = last(S.stats.syn, 50), ana = last(S.stats.ana, 30);
  const counts = { m: 0, l: 0, n: 0 }; allEntries().forEach(e => { const p = S.words[e.w]; if (p && p.box >= 4) counts.m++; else if (p && (p.right + p.wrong)) counts.l++; else counts.n++; });
  const br = window.BRIDGES.map(b => { const s = S.stats.bridge[b.id] || { n: 0, c: 0, pn: 0, pc: 0 };
    return `<div class="brrow"><span>${esc(b.name)}</span><div class="mini"><i style="width:${s.n ? Math.round(100 * s.c / s.n) : 0}%"></i></div><small>${s.n ? `${s.c}/${s.n}` : '—'}</small></div>`; }).join('');
  return `<h2>Progress</h2>
    <div class="stats3"><div><b>${al.a.toLocaleString()}</b><span>meters</span></div><div><b>${S.stats.streak}</b><span>day streak</span></div><div><b>${daysLeft()}</b><span>days left</span></div></div>
    <div class="stats3"><div><b>${pct(syn) ?? '—'}${pct(syn) != null ? '%' : ''}</b><span>synonyms (last ${syn.length})</span></div><div><b>${pct(ana) ?? '—'}${pct(ana) != null ? '%' : ''}</b><span>analogies (last ${ana.length})</span></div><div><b>${counts.m}</b><span>words mastered</span></div></div>
    <div class="card"><b>Analogies by bridge</b>${br}</div>
    <details class="card parent"><summary>Parent tools</summary>
      <p class="muted">Progress lives only on this phone. Export a backup now and then.</p>
      <button class="ghost wide" data-act="export">Export progress backup</button>
      <button class="ghost wide" data-act="import">Import backup</button>
      <button class="ghost wide" data-act="exportwords">Share added words (for Claude)</button>
      <button class="ghost wide danger" data-act="reset">Reset everything</button>
      <input type="file" id="importfile" accept="application/json" hidden>
    </details>`;
};


// ---------- actions ----------
function advance(type) {
  const s = S.sessions[type]; s.i++;
  if (s.i >= s.items.length) s.done = true;
  save(); render(); window.scrollTo(0, 0);
}
function requeue(s, w) {
  const at = Math.min(s.items.length, s.i + 4);
  if (s.items.filter(x => x.w === w && x.picked == null).length === 0 && s.items.length < 20) s.items.splice(at, 0, genWordQ(w));
}
document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-act],[data-go]'); if (!el) return;
  if (el.dataset.go) { if (el.dataset.filter) S.ui.filter = el.dataset.filter; go(el.dataset.go); return; }
  const act = el.dataset.act, type = el.dataset.type;
  const s = type ? S.sessions[type] : null; const it = s ? s.items[s.i] : null;
  switch (act) {
    case 'start': if (!cur(type)) newSession(type); go(type); break;
    case 'again': newSession(type); render(); break;
    case 'next':
      if (it && it.kind === 'learn') { ws(it.w).intro = true; s.gained += gain(2); }
      advance(type); break;
    case 'pick': {
      const k = +el.dataset.k; it.picked = it.choices[k]; it.ms = now() - (it.t0 || now());
      const ok = it.picked === it.ans; markWord(it.w, ok); ws(it.w).intro = true;
      s.total++; if (ok) { s.right++; s.gained += gain(10); } else requeue(s, it.w);
      S.stats.syn.push({ w: it.w, ok, ms: it.ms, t: now() }); if (S.stats.syn.length > 500) S.stats.syn.shift();
      tickDay(); save(); render(); break; }
    case 'bridge': {
      it.bridge = el.dataset.b; it.t0 = now();
      const a = ANA[it.id]; const st = S.stats.bridge[a.b] = S.stats.bridge[a.b] || { n: 0, c: 0, pn: 0, pc: 0 };
      st.pn++; if (it.bridge === a.b) { st.pc++; s.gained += gain(5); }
      save(); render(); break; }
    case 'anapick': {
      const a = ANA[it.id]; it.picked = +el.dataset.idx; it.ms = now() - (it.t0 || now());
      const ok = it.picked === a.a; const st = S.stats.bridge[a.b];
      st.n++; if (ok) st.c++;
      s.total++; if (ok) { s.right++; s.gained += gain(15); }
      S.stats.ana.push({ id: a.id, b: a.b, ok, bridgeOk: it.bridge === a.b, ms: it.ms, t: now() }); if (S.stats.ana.length > 500) S.stats.ana.shift();
      tickDay(); save(); render(); break; }
    case 'tri': {
      const v = el.dataset.v; const p = ws(it.w); p.triage = v;
      if (v === 'known') { p.box = 3; p.due = now() + 4 * DAY; p.intro = true; }
      if (v === 'sort') { p.box = 1; p.due = now(); }
      if (v === 'no') { p.box = 0; p.due = now(); }
      s.total++; advance(type); break; }
    case 'filter': S.ui.filter = el.dataset.v; save(); render(); break;
    case 'word': openWord(el.dataset.w); break;
    case 'addopen': openAdd(); break;
    case 'close': closeSheet(); break;
    case 'study': { const w = el.dataset.w; const p = ws(w); p.box = 0; p.due = now(); p.intro = false; save(); closeSheet(); render(); toast('Added to your study list'); break; }
    case 'retry': lookup(el.dataset.w, true); break;
    case 'remove': { const w = el.dataset.w; if (confirm(`Remove “${w}”?`)) { delete S.custom[w]; delete S.mine[w]; delete S.words[w]; rebuildClusters(); save(); closeSheet(); render(); } break; }
    case 'export': download(`ssat-climb-backup-${todayKey()}.json`, JSON.stringify(S)); break;
    case 'import': $('#importfile').click(); break;
    case 'exportwords': shareWords(); break;
    case 'reset': if (confirm('Erase all progress on this phone?') && confirm('Really erase everything?')) { S = fresh(); save(); go('home'); } break;
  }
});
document.addEventListener('change', ev => {
  if (ev.target.id !== 'importfile') return;
  const f = ev.target.files[0]; if (!f) return;
  f.text().then(t => { const d = JSON.parse(t); if (!d || !d.words) throw 0; S = Object.assign(fresh(), d); S.mine = S.mine || {}; rebuildClusters(); save(); go('home'); toast('Backup restored'); }).catch(() => toast('That file isn’t a backup'));
});

// ---------- add word: available on every screen ----------
function openAdd() {
  $('#sheet').innerHTML = `<div class="sheet-in"><div class="topline"><h2>Add a word</h2><button class="ghost" data-act="close">✕</button></div>
    <form id="addform"><input id="addw" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" placeholder="word you don’t know" enterkeyhint="done"><button class="cta">Add</button></form>
    <p class="muted">Your spot is saved — close this to pick up where you were.</p><div id="addres"></div></div>`;
  $('#sheet').classList.add('on'); setTimeout(() => $('#addw').focus(), 50);
}
function closeSheet() { $('#sheet').classList.remove('on'); $('#sheet').innerHTML = ''; }
document.addEventListener('submit', ev => {
  if (ev.target.id !== 'addform') return; ev.preventDefault();
  const w = $('#addw').value.trim().toLowerCase().replace(/[^a-z\- ']/g, '').replace(/\s+/g, ' ');
  if (!w) return;
  const p = ws(w); p.box = 0; p.due = now(); p.intro = false;
  if (BASE[w]) { S.mine[w] = now(); save(); $('#addres').innerHTML = `<p class="ok">Already in the bank — it’s now on your study list.</p>${wordInfo(w)}`; $('#addw').value = ''; return; }
  if (S.custom[w] && S.custom[w].lookup === 'ok') { save(); $('#addres').innerHTML = `<p class="ok">Already added — moved back to the top of your list.</p>${wordInfo(w)}`; $('#addw').value = ''; return; }
  S.custom[w] = { w, p: '', d: '', s: [], r: '', e: '', src: 'added', ts: now(), lookup: 'pending' };
  save(); $('#addw').value = '';
  if (navigator.onLine) { $('#addres').innerHTML = `<p class="muted">Looking up “${esc(w)}”…</p>`; lookup(w).then(() => { if ($('#addres')) $('#addres').innerHTML = resultHTML(w); }); }
  else $('#addres').innerHTML = `<p class="ok">Saved “${esc(w)}”. It’ll be looked up next time you’re online.</p>`;
});
function resultHTML(w) {
  const e = S.custom[w];
  if (e.lookup === 'ok') return `<p class="ok">Added. You’ll start seeing it in practice.</p>${wordInfo(w)}`;
  if (e.lookup === 'failed') return `<p class="no">Couldn’t find “${esc(w)}”. Check the spelling, or leave it — Dad can send it to Claude.</p><button class="ghost wide" data-act="remove" data-w="${esc(w)}">Remove it</button>`;
  return `<p class="muted">Saved. Lookup will finish when you’re online.</p>`;
}
const POSMAP = { noun: 'n', verb: 'v', adjective: 'adj', adverb: 'adv' };
async function lookup(w, ui) {
  const e = S.custom[w]; if (!e) return;
  const enc = encodeURIComponent(w);
  const get = u => fetch(u, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => undefined); // undefined = network failure
  const [dict, syn, ml] = await Promise.all([
    get(`https://api.dictionaryapi.dev/api/v2/entries/en/${enc}`),
    get(`https://api.datamuse.com/words?rel_syn=${enc}&max=12`),
    get(`https://api.datamuse.com/words?ml=${enc}&max=8`)]);
  if (dict === undefined && syn === undefined) { if (ui) toast('Can’t reach the dictionary right now'); return; } // offline or blocked: stay pending, retry later
  let d = '', p = '', ex = '', syns = [];
  if (Array.isArray(dict) && dict[0] && dict[0].meanings) {
    const m = dict[0].meanings.find(x => POSMAP[x.partOfSpeech]) || dict[0].meanings[0];
    p = POSMAP[m.partOfSpeech] || ''; const def = m.definitions && m.definitions[0];
    d = def ? def.definition : ''; ex = def && def.example ? def.example : '';
    syns = [...(m.synonyms || []), ...((m.definitions || []).flatMap(x => x.synonyms || []))];
  }
  const ok1 = x => /^[a-z][a-z\-]*( [a-z]+)?$/.test(x) && x !== w && !x.includes(w);
  // rank: words both sources agree on, then the scored thesaurus list, then the rest
  const dm = Array.isArray(syn) ? syn.map(x => x.word.toLowerCase()) : [];
  const dl = syns.map(x => x.toLowerCase());
  syns = [...new Set([...dm.filter(x => dl.includes(x)), ...dm, ...dl])].filter(ok1).slice(0, 5);
  if (!syns.length && Array.isArray(ml)) syns = ml.map(x => x.word.toLowerCase()).filter(ok1).slice(0, 3);
  Object.assign(e, { d, p, e: ex, s: syns, lookup: (d || syns.length) ? 'ok' : 'failed' });
  rebuildClusters(); save();
  if (S.ui.view === 'words' && !$('#sheet').classList.contains('on')) render();
  if (ui) openWord(w);
}
function retryPending() { if (!navigator.onLine) return; Object.values(S.custom).filter(e => e.lookup === 'pending').forEach(e => lookup(e.w)); }
window.addEventListener('online', retryPending);

function openWord(w) {
  const e = entry(w); const p = S.words[w] || { box: 0, right: 0, wrong: 0 };
  $('#sheet').innerHTML = `<div class="sheet-in"><div class="topline"><h2>${esc(w)}</h2><button class="ghost" data-act="close">✕</button></div>
    ${e.lookup === 'failed' ? `<p class="no">Not found online. Check the spelling.</p><button class="ghost wide" data-act="retry" data-w="${esc(w)}">Try lookup again</button>` : ''}
    ${e.lookup === 'pending' ? `<p class="muted">Waiting to look this up online.</p>` : ''}
    ${wordInfo(w)}<p class="muted">Right ${p.right} · wrong ${p.wrong} · level ${p.box}/5</p>
    <button class="cta" data-act="study" data-w="${esc(w)}">Study this word again</button>
    ${S.custom[w] ? `<button class="ghost wide danger" data-act="remove" data-w="${esc(w)}">Remove</button>` : ''}</div>`;
  $('#sheet').classList.add('on');
}
$('#sheet').addEventListener('click', ev => { if (ev.target.id === 'sheet') closeSheet(); });

// ---------- export helpers ----------
function download(name, text) {
  const blob = new Blob([text], { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [new File([blob], name)] })) {
    navigator.share({ files: [new File([blob], name, { type: 'application/json' })], title: name }).catch(() => {});
  } else { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); }
}
function shareWords() {
  const list = [...Object.values(S.custom), ...Object.keys(S.mine).filter(w => BASE[w]).map(w => Object.assign({ lookup: 'in bank' }, BASE[w]))].map(e => ({ word: e.w, found: e.lookup, definition: e.d, synonyms: e.s, right: (S.words[e.w] || {}).right || 0, wrong: (S.words[e.w] || {}).wrong || 0 }));
  const text = `SSAT Climb — added words (${todayKey()}):\n` + JSON.stringify(list, null, 1);
  if (navigator.share) navigator.share({ title: 'SSAT Climb words', text }).catch(() => {});
  else navigator.clipboard.writeText(text).then(() => toast('Copied'));
}
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 1800); }

// ---------- boot ----------
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
render(); retryPending();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
