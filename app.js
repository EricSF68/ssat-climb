/* SSAT Climb — offline-first verbal trainer. State lives in localStorage and is saved after every action. */
(() => {
'use strict';
const KEY = 'climb.v1';
const APP_VERSION = '1.4';
const TEST_DAY = new Date(2026, 11, 12);
const DAY = 86400000;
// Word levels (dots): 0 = don't know it, 1 = not sure, 2 = I know it, 3 = mastered (a 2-dot word confirmed correct again)
const LV_DAYS = [0, 1, 3, 10];           // when a word at each level is due again
const LV_WEIGHT = [10, 6, 1.5, 0.3];     // how likely a word at each level is to be picked; not-yet-sorted words = 4
const LV_NAME = ['Don’t know it', 'Not sure', 'I know it', 'Mastered'];
const GOAL_END = new Date(2026, 11, 6);  // daily target finishes every word by the end of Sun Dec 6 (10 days from Nov 27)
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
  return { v: 1, scale: 3, words: {}, custom: {}, mine: {}, anaRate: {}, gloss: {}, daily: null, stats: { alt: 0, streak: 0, lastDay: null, days: {}, syn: [], ana: [], bridge: {} },
           sessions: {}, ui: { view: 'home' } };
}
let S, raw = null;
try { raw = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
S = Object.assign(fresh(), raw || {});
S.stats = Object.assign(fresh().stats, S.stats); S.mine = S.mine || {}; S.anaRate = S.anaRate || {}; S.gloss = S.gloss || {};
// One-time move from the old 0–5 dots to the new 0–3 scale: 0→0, 1–2→1, 3→2, 4–5→3
if (raw && raw.scale !== 3) {
  Object.values(S.words).forEach(p => { if (p.lv == null) { const b = p.box || 0; p.lv = b === 0 ? 0 : b <= 2 ? 1 : b === 3 ? 2 : 3; } delete p.box; });
  S.scale = 3;
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }

// ---------- word bank ----------
const BASE = {}; window.WORDS.forEach(e => { BASE[e.w] = e; const x = (window.EXTRA || {})[e.w]; if (x) { e.a = x[0]; e.c = x[1]; } });
const entry = w => S.custom[w] || BASE[w];
const isMine = w => !!(S.custom[w] || S.mine[w]);
const allEntries = () => [...window.WORDS, ...Object.values(S.custom).filter(e => !BASE[e.w])];
function ws(w) { // per-word progress
  if (!S.words[w]) S.words[w] = { lv: 0, due: 0, right: 0, wrong: 0, intro: false, triage: null };
  return S.words[w];
}
// -1 = not sorted yet (never sorted, answered or added); otherwise the 0–3 level
function status(w) { const p = S.words[w]; if (!p || (!p.triage && p.right + p.wrong === 0 && !isMine(w))) return -1; return p.lv || 0; }
function setLv(p, lv) { p.lv = lv; p.due = now() + LV_DAYS[lv] * DAY; }
// meaning of any answer word: a headword's definition, the built-in glossary, or one fetched online
function glossOf(x) { const k = String(x).toLowerCase(); const e = entry(k); return (e && e.d) || (window.GLOSS || {})[k] || S.gloss[k] || ''; }
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
  // SSAT-style trap: an opposite or a look/sound-alike, about 60% of the time
  const traps = {};
  const trapPool = [...(e.a || []).map(t => [t, 'opposite']), ...(e.c || []).map(t => [t, 'lookalike'])]
    .filter(([t]) => !near(t.toLowerCase(), [w, correct.toLowerCase()]) && !(e.s || []).includes(t));
  const chosen = trapPool.length && Math.random() < 0.6 ? pick(trapPool, 1) : [];
  chosen.forEach(([t, k]) => traps[t] = k);
  const wrong = [...chosen.map(x => x[0]), ...pick(cands.filter(c => !traps[c]), 4 - chosen.length)];
  return { kind: 'syn', w, choices: shuffle([correct, ...wrong]), ans: correct, traps, picked: null, t0: null, ms: null };
}
function genDef(w) {
  const e = entry(w);
  const pool = allEntries().filter(x => x.w !== w && (x.p === e.p || !e.p) && !near(x.w, [w]));
  const wrong = pick(pool, 4).map(x => x.w);
  return { kind: 'def', w, choices: shuffle([w, ...wrong]), ans: w, picked: null, t0: null, ms: null };
}
function genWordQ(w) { const e = entry(w); return (e.s && e.s.length && Math.random() < 0.8) ? genSyn(w) : genDef(w); }

// Weighted random pick: words you know least are far more likely to come up (Don't know 10 : Not sure 6 : not sorted 4 : Know it 1.5 : Mastered 0.3)
function wordQueue(n) {
  const t = now();
  return allEntries().filter(quizzable).map(e => {
    const st = status(e.w); const p = S.words[e.w] || {};
    let wt = st < 0 ? 4 : LV_WEIGHT[st];
    if (st >= 2 && p.due > t) wt *= 0.4;            // known words that aren't due yet: even less likely
    if (isMine(e.w)) wt *= 1.5;
    if (e.src === 't1') wt *= 1.3;
    if (p.last && t - p.last < 15 * 60000) wt *= 0.15; // just practiced: give it a rest
    return { w: e.w, k: Math.pow(Math.random(), 1 / wt) };
  }).sort((a, b) => b.k - a.k).slice(0, n).map(x => x.w);
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
    const r = S.anaRate[a.id]; if (r === 'know') score -= 40; if (r === 'unsure') score += 6; if (r === 'guess') score += 12; if (r === 'dont') score += 18;
    return { id: a.id, score };
  }).sort((x, y) => y.score - x.score).slice(0, n).map(x => ({ kind: 'ana', id: x.id, order: shuffle([0,1,2,3,4]), bridge: null, picked: null, t0: null, ms: null }));
}

// Words still to sort: never sorted and never practiced (words you've already answered keep their progress).
// Test 1 words first, then words you added, then the common SSAT words.
function toSort() {
  const rank = e => e.src === 't1' ? 0 : isMine(e.w) ? 1 : 2;
  return allEntries().filter(e => { const p = S.words[e.w]; return quizzable(e) && !(p && (p.triage || p.right + p.wrong > 0)); })
    .sort((a, b) => rank(a) - rank(b));
}
// ---------- sessions ----------
function newSession(type) {
  let items = [];
  if (type === 'syn') items = wordQueue(10).map(genWordQ);
  if (type === 'ana') items = anaQueue(6);
  if (type === 'today') {
    const learn = allEntries().filter(e => quizzable(e) && !ws(e.w).intro && status(e.w) === 0).slice(0, 3);
    items = [...learn.map(e => ({ kind: 'learn', w: e.w }))];
    const words = wordQueue(8);
    const anas = anaQueue(4);
    const mixed = [];
    words.forEach((w, i) => { mixed.push(genWordQ(w)); if (i % 2 === 1 && anas.length) mixed.push(anas.shift()); });
    items = items.concat(mixed, anas);
  }
  if (type === 'triage') items = toSort().slice(0, 20).map(e => ({ kind: 'triage', w: e.w }));
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
  const al = altInfo(); const tri = toSort().length;
  const td = cur('today'); const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const help = Object.values(S.custom).filter(e => e.lookup === 'failed').length;
  return `
  <header class="hero">
    <div class="topline"><div class="kicker">SSAT Climb</div><button class="qbtn" data-act="help" data-i="0" aria-label="How to use the app">?</button></div>
    <h1>${daysLeft()} days to test day</h1>
    <div class="alt"><span class="m">${al.a.toLocaleString()} m</span><span class="at">${esc(al.at)}${al.next ? ` → ${esc(al.next[1])}` : ''}</span></div>
    <div class="bar"><i style="width:${al.pct}%"></i></div>
    <div class="sub">${S.stats.streak ? `🔥 ${S.stats.streak}-day streak · ` : ''}${S.stats.days[todayKey()] || 0} answered today</div>
  </header>
  ${!standalone ? `<div class="card tip">Install first: in Safari tap <b>Share → Add to Home Screen</b>, then study only from the home-screen icon. Progress made in Safari won’t carry over.</div>` : ''}
  <button class="cta" data-act="start" data-type="today">${td ? 'Resume today’s climb' : 'Start today’s climb'}<small>${td ? `${td.i + 1} of ${td.items.length}` : '~15 min · words + analogies'}</small></button>
  ${statsCard()}
  ${tri ? `<button class="card row" data-act="start" data-type="triage"><b>Sort your words</b><span>${tri} left · 20 at a time · don’t know / not sure / I know it</span></button>` : ''}
  ${help ? `<button class="card row warn" data-go="words" data-filter="help"><b>${help} word${help>1?'s':''} couldn’t be looked up</b><span>Check spelling, or ask Dad to send them to Claude</span></button>` : ''}
  <div class="grid2">
    <button class="card tile" data-go="syn"><b>Synonyms</b><span>10 questions</span></button>
    <button class="card tile" data-go="ana"><b>Analogies</b><span>bridge first</span></button>
    <button class="card tile" data-go="bridges"><b>Bridge guide</b><span>${window.BRIDGES.length} relationships</span></button>
    <button class="card tile" data-go="words"><b>My words</b><span>${Object.keys(S.custom).length + Object.keys(S.mine).length} added</span></button>
  </div>
  <div class="card note"><b>Pace on test day (1.5×):</b> synonyms ~30 s each, analogies ~60 s each. Finishing early means you rushed. <b>Use all the time.</b></div>`;
};

// ---------- word stats + daily target ----------
function levelCounts() {
  const c = { '-1': 0, 0: 0, 1: 0, 2: 0, 3: 0 }; allEntries().forEach(e => c[status(e.w)]++); return c;
}
const points = c => c[1] + 2 * c[2] + 3 * c[3];
function daily(c) {
  const k = todayKey();
  if (!S.daily || S.daily.date !== k) {
    const total = 3 * allEntries().length, start = points(c);
    const days = Math.max(1, Math.round((GOAL_END - new Date(new Date().toDateString())) / DAY) + 1);
    S.daily = { date: k, start, goal: Math.max(1, Math.ceil((total - start) / days)), days }; save();
  }
  return S.daily;
}
const dots = n => n < 0 ? '<span class="dd none">–</span>' : `<span class="dd">${[1, 2, 3].map(i => `<i class="${n >= i ? 'f' : ''}"></i>`).join('')}</span>`;
function statsCard() {
  const c = levelCounts(), n = allEntries().length, pts = points(c), d = daily(c);
  const done = Math.max(0, pts - d.start), dp = Math.min(100, Math.round(100 * done / d.goal)), overall = Math.round(100 * pts / (3 * n));
  const pc = x => Math.round(100 * x / n);
  const rows = [[3, 'Mastered', 'm3'], [2, 'I know it', 'm2'], [1, 'Not sure', 'm1'], [0, 'Don’t know it', 'm0'], [-1, 'Not sorted yet', 'mx']];
  return `<div class="card statcard">
    <div class="srow"><b>Today’s target</b><span>${done} / ${d.goal} dots · <b>${dp}%</b></span></div>
    <div class="bar"><i style="width:${dp}%"></i></div>
    <small class="muted">Resets at midnight · pace to finish every word by Sun, Dec 6${d.days > 1 ? ` (${d.days} days incl. today)` : ''}</small>
    <div class="srow"><b>Overall learning</b><span><b>${overall}%</b> · ${pts} of ${3 * n} dots</span></div>
    <div class="stack">${rows.map(([lv, , cls]) => `<i class="${cls}" style="width:${100 * c[lv] / n}%"></i>`).join('')}</div>
    <div class="lvtable">${rows.map(([lv, name, cls]) => `<button data-go="words" data-filter="lv${lv}"><span class="key ${cls}"></span>${dots(lv)}<span class="nm">${name}</span><b>${c[lv]}</b><span class="pc">${pc(c[lv])}%</span></button>`).join('')}</div>
  </div>`;
}

function sessionView(type, title) {
  let s = cur(type);
  if (!s) {
    const last = S.sessions[type];
    if (last && last.done && last.total) return type === 'triage'
      ? `<div class="done"><div class="kicker">${toSort().length ? 'Round sorted' : 'All sorted'}</div><h1>${last.total} words</h1><p>The ones you didn’t know now show up first in practice.${toSort().length ? ` ${toSort().length} words left to sort.` : ''}</p>${toSort().length ? `<button class="cta" data-act="again" data-type="triage">Sort 20 more</button>` : ''}<button class="${toSort().length ? 'ghost wide' : 'cta'}" data-act="start" data-type="today">Start today’s climb</button><button class="ghost wide" data-go="home">Back to basecamp</button></div>`
      : doneView(type, title, last);
    s = newSession(type);
    if (s.done) return `<div class="card">Nothing to do here right now.</div>`;
  }
  const it = s.items[s.i];
  const head = `<div class="shead"><button class="ghost" data-go="home" aria-label="Close">✕</button><button class="ghost back" data-act="back" data-type="${type}" ${s.i === 0 ? 'disabled' : ''} aria-label="Previous question">‹ Back</button><div class="prog"><i style="width:${Math.round(100 * s.i / s.items.length)}%"></i></div><span>${s.i + 1}/${s.items.length}</span></div>`;
  return head + itemView(type, it);
}
function doneView(type, title, s) {
  return `<div class="done"><div class="kicker">${esc(title)}</div><h1>${s.right}/${s.total}</h1><p>+${s.gained} m climbed</p>
    <button class="cta" data-act="again" data-type="${type}">Another round</button><button class="ghost wide" data-act="review" data-type="${type}">Review answers</button><button class="ghost wide" data-go="home">Back to basecamp</button></div>`;
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
    const src = e.src === 't1' ? 'From your Test 1 misses' : isMine(e.w) ? 'A word you added' : 'Common SSAT word';
    return `<div class="qcard"><div class="kicker">${src}</div><div class="stem big">${esc(e.w.toUpperCase())}</div>
      <p class="muted">Do you know this word?</p></div>
      <div class="tri"><button data-act="tri" data-type="${type}" data-v="dont">Don’t know it<small>0 dots</small></button><button data-act="tri" data-type="${type}" data-v="unsure">Not sure<small>1 dot</small></button><button data-act="tri" data-type="${type}" data-v="know">I know it<small>2 dots</small></button></div>`;
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
      const trap = !ok && it.traps && it.traps[it.picked];
      const trapMsg = trap === 'opposite' ? `<p class="trapmsg">Trap! “${esc(it.picked)}” is an <b>opposite</b> of ${esc(e.w)}. Test-makers love putting the opposite in the choices.</p>`
        : trap === 'lookalike' ? `<p class="trapmsg">Trap! “${esc(it.picked)}” <b>looks or sounds like</b> ${esc(e.w)} but means something different.</p>` : '';
      const head = `<div class="fb ${ok ? 'ok' : 'no'}">${ok ? '✓ Correct!' : 'Not quite'}${!ok && it.ms < 6000 ? ` — that took ${Math.round(it.ms/1000)} s. Read all five choices first.` : ''}</div>`;
      fb = ok ? head + rateBlock(type, it, `How well do you know <b>${esc(e.w)}</b>?`) + explainBtn(type, it) + (it.explain ? answerInfo(it) + wordInfo(it.w) : '')
              : head + trapMsg + answerInfo(it) + wordInfo(it.w) + rateBlock(type, it, `How well do you know <b>${esc(e.w)}</b>?`);
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
      const head = `<div class="fb ${ok ? 'ok' : 'no'}">${ok ? '✓ Correct!' : 'Not quite'}${!ok && it.ms < 10000 ? ` — only ${Math.round(it.ms/1000)} s. Say the bridge sentence, then test each choice.` : ''}</div>`;
      const info = `<div class="info"><p><b>Bridge:</b> ${esc(a.br)} <span class="tag ${bok ? 'ok' : 'no'}">${esc(BR[a.b].name)}${bok ? ' ✓' : ` — you picked ${esc(mine.name)}`}</span></p><p>${esc(a.why)}</p></div>`;
      const q = 'How sure were you?';
      fb = (ok ? head + rateBlock(type, it, q) + explainBtn(type, it) + (it.explain ? info : '') : head + info + rateBlock(type, it, q))
        + `<button class="ghost wide" data-act="redo" data-type="${type}">Change my bridge / answer</button>`;
    }
    return `<div class="qcard"><div class="kicker">Step 2 · Your bridge: ${esc(mine.name)} — “${esc(mine.sent)}”</div><div class="stem">${esc(a.q)}</div></div><div class="choices">${ch}</div>${fb}`;
  }
  return '';
}
// The right answer's meaning (and the one you picked, if wrong)
function answerInfo(it) {
  const ok = it.picked === it.ans;
  const line = (label, x) => { const g = glossOf(x); return `<p><b>${label} ${esc(x)}</b>${g ? ` — ${esc(g)}` : ''}</p>`; };
  if (it.kind === 'def') return ok ? '' : `<div class="info ans">${line('You picked:', it.picked)}</div>`;
  return `<div class="info ans">${line(ok ? 'Answer:' : 'Right answer:', it.ans)}${ok ? '' : `<div class="muted">${line('You picked:', it.picked)}</div>`}</div>`;
}
const RATES = [['dont', 'Don’t know it'], ['guess', 'Guessed'], ['unsure', 'Not sure'], ['know', 'I know it']];
function rateBlock(type, it, q) {
  return `<p class="rateq">${q}</p><div class="rate">${RATES.map(([v, l]) => `<button class="r-${v} ${it.rate === v ? 'on' : ''}" data-act="rate" data-type="${type}" data-v="${v}">${l}</button>`).join('')}</div>
    ${it.rate ? `<button class="ghost wide" data-act="next" data-type="${type}">Next ›</button>` : ''}`;
}
const explainBtn = (type, it) => it.explain ? '' : `<button class="link explain" data-act="explain" data-type="${type}">Explain</button>`;
function wordInfo(w) {
  const e = entry(w); if (!e) return '';
  return `<div class="info"><p><b>${esc(e.w)}</b> <i>${esc(POS[e.p] || e.p || '')}</i> — ${esc(e.d || 'definition pending')}</p>
    ${e.s && e.s.length ? `<p class="muted">Synonyms: ${esc(e.s.join(', '))}</p>` : ''}${e.a && e.a.length ? `<p class="muted">Opposites: ${esc(e.a.join(', '))}</p>` : ''}${e.c && e.c.length ? `<p class="muted">Don’t confuse with: ${esc(e.c.join(', '))}</p>` : ''}${e.r ? `<p class="muted">Tip: ${esc(e.r)}</p>` : ''}${e.e ? `<p class="ex">“${esc(e.e)}”</p>` : ''}</div>`;
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
    if (/^lv-?\d$/.test(f)) return status(e.w) === +f.slice(2);
    if (f === 'help') return e.lookup === 'failed' || e.lookup === 'pending';
    return true;
  }).sort((a, b) => isMine(b.w) - isMine(a.w) || a.w.localeCompare(b.w));
  const tabs = [['all','All'],['lv0','Don’t know'],['lv1','Not sure'],['lv2','Know it'],['lv3','Mastered'],['lv-1','Not sorted'],['mine','Added'],['t1','Test 1']];
  return `<div class="topline"><h2>Words</h2><button class="link" data-act="addopen">+ Add</button></div>
    <div class="seg">${tabs.map(([k, l]) => `<button class="${f === k ? 'on' : ''}" data-act="filter" data-v="${k}">${l}</button>`).join('')}</div>
    <div class="list">${rows.map(e => {
      const badge = e.lookup === 'pending' ? '<em class="b">looking up…</em>' : e.lookup === 'failed' ? '<em class="b no">not found</em>' : '';
      return `<button class="wrow" data-act="word" data-w="${esc(e.w)}"><b>${esc(e.w)}</b>${badge}<span class="dots">${dots(status(e.w))}</span></button>`; }).join('') || '<p class="muted pad">Nothing here yet.</p>'}</div>`;
};

views.progress = () => {
  const al = altInfo(); const last = (a, n) => a.slice(-n); const pct = a => a.length ? Math.round(100 * a.filter(x => x.ok).length / a.length) : null;
  const syn = last(S.stats.syn, 50), ana = last(S.stats.ana, 30);
  const counts = { m: levelCounts()[3] };
  const br = window.BRIDGES.map(b => { const s = S.stats.bridge[b.id] || { n: 0, c: 0, pn: 0, pc: 0 };
    return `<div class="brrow"><span>${esc(b.name)}</span><div class="mini"><i style="width:${s.n ? Math.round(100 * s.c / s.n) : 0}%"></i></div><small>${s.n ? `${s.c}/${s.n}` : '—'}</small></div>`; }).join('');
  return `<h2>Progress</h2>
    <div class="stats3"><div><b>${al.a.toLocaleString()}</b><span>meters</span></div><div><b>${S.stats.streak}</b><span>day streak</span></div><div><b>${daysLeft()}</b><span>days left</span></div></div>
    <div class="stats3"><div><b>${pct(syn) ?? '—'}${pct(syn) != null ? '%' : ''}</b><span>synonyms (last ${syn.length})</span></div><div><b>${pct(ana) ?? '—'}${pct(ana) != null ? '%' : ''}</b><span>analogies (last ${ana.length})</span></div><div><b>${counts.m}</b><span>words mastered</span></div></div>
    <div class="card"><b>Analogies by bridge</b>${br}</div>
    <button class="ghost wide" data-act="help" data-i="0">How to use the app</button>
    <details class="card parent"><summary>Parent tools</summary>
      <p class="muted">Progress lives only on this phone. Export a backup now and then.</p>
      <button class="ghost wide" data-act="export">Export progress backup</button>
      <button class="ghost wide" data-act="import">Import backup</button>
      <button class="ghost wide" data-act="exportwords">Share added words (for Claude)</button>
      <button class="ghost wide" data-act="update">Check for updates</button>
      <button class="ghost wide danger" data-act="reset">Reset everything</button>
      <p class="muted">Version ${APP_VERSION}</p>
      <input type="file" id="importfile" accept="application/json" hidden>
    </details>`;
};


// ---------- actions ----------
function advance(type) {
  const s = S.sessions[type]; s.i++;
  if (s.i >= s.items.length) s.done = true;
  save(); render(); window.scrollTo(0, 0);
}
// The rating decides when the word comes back. Re-rating a reviewed question first restores the word's earlier state.
function rateWord(s, it, v) {
  const p = ws(it.w);
  if (it.prev) Object.assign(p, it.prev); else it.prev = Object.assign({}, p);
  const ok = it.picked === it.ans;
  p.intro = true; if (ok) p.right++; else p.wrong++;
  const before = p.lv || 0;
  // Your button sets the dots; the app only promotes to Mastered after a 2-dot word is answered right and marked I know it again,
  // and a word you say you know but miss drops to Not sure.
  setLv(p, v === 'know' ? (ok ? (before >= 2 ? 3 : 2) : 1) : v === 'unsure' ? 1 : 0);
  p.rate = v; p.last = now(); it.rate = v;
  if (!it.requeued && (v === 'dont' || v === 'guess' || (!ok && v !== 'know'))) { requeue(s, it.w); it.requeued = true; }
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
      if (it && it.kind === 'learn' && !it.seen) { it.seen = true; ws(it.w).intro = true; s.gained += gain(2); }
      advance(type); break;
    case 'back': if (s.i > 0) { s.i--; s.done = false; save(); render(); window.scrollTo(0, 0); } break;
    case 'review': s.done = false; s.i = s.items.length - 1; save(); render(); break;
    case 'explain': it.explain = true; save(); render(); break;
    case 'rate': {
      const v = el.dataset.v;
      if (it.kind === 'ana') { S.anaRate[it.id] = v; it.rate = v; } else rateWord(s, it, v);
      advance(type); break; }
    case 'redo': {
      const a = ANA[it.id]; const st = S.stats.bridge[a.b];
      if (it.bridge && st) { st.pn--; if (it.bridge === a.b) st.pc--; }
      if (it.picked != null && st) { const ok = it.picked === a.a; st.n--; if (ok) st.c--; s.total--; if (ok) s.right--;
        S.stats.ana = S.stats.ana.filter(x => x.t !== it.stamp); }
      S.stats.alt -= it.gainM || 0; s.gained -= it.gainM || 0;
      if (it.rate) delete S.anaRate[a.id];
      Object.assign(it, { bridge: null, picked: null, rate: null, explain: false, gainM: 0, t0: null, ms: null, stamp: null });
      save(); render(); window.scrollTo(0, 0); break; }
    case 'pick': {
      const k = +el.dataset.k; it.picked = it.choices[k]; it.ms = now() - (it.t0 || now());
      const ok = it.picked === it.ans;
      s.total++; if (ok) { s.right++; s.gained += gain(10); }
      S.stats.syn.push({ w: it.w, ok, ms: it.ms, t: now() }); if (S.stats.syn.length > 500) S.stats.syn.shift();
      tickDay(); save(); render(); break; }
    case 'bridge': {
      it.bridge = el.dataset.b; it.t0 = now();
      const a = ANA[it.id]; const st = S.stats.bridge[a.b] = S.stats.bridge[a.b] || { n: 0, c: 0, pn: 0, pc: 0 };
      st.pn++; if (it.bridge === a.b) { st.pc++; s.gained += gain(5); it.gainM = (it.gainM || 0) + 5; }
      save(); render(); break; }
    case 'anapick': {
      const a = ANA[it.id]; it.picked = +el.dataset.idx; it.ms = now() - (it.t0 || now());
      const ok = it.picked === a.a; const st = S.stats.bridge[a.b];
      st.n++; if (ok) st.c++;
      s.total++; if (ok) { s.right++; s.gained += gain(15); it.gainM = (it.gainM || 0) + 15; }
      it.stamp = now();
      S.stats.ana.push({ id: a.id, b: a.b, ok, bridgeOk: it.bridge === a.b, ms: it.ms, t: it.stamp }); if (S.stats.ana.length > 500) S.stats.ana.shift();
      tickDay(); save(); render(); break; }
    case 'tri': {
      const v = el.dataset.v; const p = ws(it.w); p.triage = v; const first = !it.v; it.v = v;
      if (v === 'know') { setLv(p, Math.max(p.lv || 0, 2)); p.intro = true; }
      if (v === 'unsure') setLv(p, 1);
      if (v === 'dont') setLv(p, 0);
      if (first) s.total++; advance(type); break; }
    case 'filter': S.ui.filter = el.dataset.v; save(); render(); break;
    case 'help': openHelp(+el.dataset.i || 0); break;
    case 'helpdone': S.ui.helpSeen = true; save(); closeSheet(); break;
    case 'update': checkUpdate(true); break;
    case 'word': openWord(el.dataset.w); break;
    case 'addopen': openAdd(); break;
    case 'close': closeSheet(); break;
    case 'study': { const w = el.dataset.w; const p = ws(w); setLv(p, 0); p.triage = p.triage || 'dont'; p.intro = false; save(); closeSheet(); render(); toast('Added to your study list'); break; }
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
  const p = ws(w); setLv(p, 0); p.intro = false;
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
function lev(a, b) { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return d[a.length][b.length]; }
async function lookup(w, ui) {
  const e = S.custom[w]; if (!e) return;
  const enc = encodeURIComponent(w);
  const get = u => fetch(u, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => undefined); // undefined = network failure
  const [dict, syn, ml, ant, sl] = await Promise.all([
    get(`https://api.dictionaryapi.dev/api/v2/entries/en/${enc}`),
    get(`https://api.datamuse.com/words?rel_syn=${enc}&max=12`),
    get(`https://api.datamuse.com/words?ml=${enc}&max=8`),
    get(`https://api.datamuse.com/words?rel_ant=${enc}&max=6`),
    get(`https://api.datamuse.com/words?sl=${enc}&md=f&max=25`)]);
  if (dict === undefined && syn === undefined) { if (ui) toast('Can’t reach the dictionary right now'); return; } // offline or blocked: stay pending, retry later
  let d = '', p = '', ex = '', syns = [], ants = [];
  if (Array.isArray(dict) && dict[0] && dict[0].meanings) {
    const m = dict[0].meanings.find(x => POSMAP[x.partOfSpeech]) || dict[0].meanings[0];
    p = POSMAP[m.partOfSpeech] || ''; const def = m.definitions && m.definitions[0];
    d = def ? def.definition : ''; ex = def && def.example ? def.example : '';
    syns = [...(m.synonyms || []), ...((m.definitions || []).flatMap(x => x.synonyms || []))];
    ants = [...(m.antonyms || []), ...((m.definitions || []).flatMap(x => x.antonyms || []))];
  }
  const ok1 = x => /^[a-z][a-z\-]*( [a-z]+)?$/.test(x) && x !== w && !x.includes(w);
  // rank: words both sources agree on, then the scored thesaurus list, then the rest
  const dm = Array.isArray(syn) ? syn.map(x => x.word.toLowerCase()) : [];
  const dl = syns.map(x => x.toLowerCase());
  syns = [...new Set([...dm.filter(x => dl.includes(x)), ...dm, ...dl])].filter(ok1).slice(0, 5);
  if (!syns.length && Array.isArray(ml)) syns = ml.map(x => x.word.toLowerCase()).filter(ok1).slice(0, 3);
  // opposites: both sources, minus anything that is also listed as a synonym
  ants = [...new Set([...(Array.isArray(ant) ? ant.map(x => x.word) : []), ...ants].map(x => x.toLowerCase()))].filter(x => ok1(x) && !syns.includes(x)).slice(0, 3);
  // look/sound-alikes: common real words only, not just another form of the same word
  const SUF = new Set(['', 's', 'es', 'ed', 'd', 'ing', 'ly', 'y', 'ce', 'ness', 'ment', 'ity', 'ism', 'ion', 'ions', 'ist', 'er', 'ers', 'ies', 'ence', 'ance', 'ize', 'ise', 'ized', 'ised', 'ous', 'al']);
  const derived = t => { let i = 0; while (i < t.length && i < w.length && t[i] === w[i]) i++; return i >= w.length - 3 && SUF.has(t.slice(i)) && SUF.has(w.slice(i)); };
  const alikes = (Array.isArray(sl) ? sl : []).filter(x => {
    const t = x.word.toLowerCase(); const f = parseFloat(((x.tags || []).find(g => g.startsWith('f:')) || 'f:0').slice(2));
    return /^[a-z]+$/.test(t) && t !== w && f >= 1 && !derived(t) && !syns.includes(t) && !ants.includes(t) && lev(t, w) <= Math.max(2, Math.floor(w.length / 4));
  }).map(x => x.word.toLowerCase()).slice(0, 2);
  Object.assign(e, { d, p, e: ex, s: syns, a: ants, c: alikes, lookup: (d || syns.length) ? 'ok' : 'failed' });
  // fetch meanings for the synonyms that can be used as right answers, so a miss can show what they mean
  for (const x of syns.slice(0, 2)) {
    if (glossOf(x)) continue;
    const r = await get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(x)}`);
    if (Array.isArray(r) && r[0] && r[0].meanings) { const m = r[0].meanings.find(y => POSMAP[y.partOfSpeech] === p) || r[0].meanings[0]; const df = m.definitions && m.definitions[0]; if (df) S.gloss[x] = df.definition; }
  }
  rebuildClusters(); save();
  if (S.ui.view === 'words' && !$('#sheet').classList.contains('on')) render();
  if (ui) openWord(w);
}
function retryPending() { if (!navigator.onLine) return; Object.values(S.custom).filter(e => e.lookup === 'pending').forEach(e => lookup(e.w)); }
window.addEventListener('online', retryPending);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { retryPending(); checkUpdate(); } });

function openWord(w) {
  const e = entry(w); const p = S.words[w] || { right: 0, wrong: 0 }; const st = status(w);
  $('#sheet').innerHTML = `<div class="sheet-in"><div class="topline"><h2>${esc(w)}</h2><button class="ghost" data-act="close">✕</button></div>
    ${e.lookup === 'failed' ? `<p class="no">Not found online. Check the spelling.</p><button class="ghost wide" data-act="retry" data-w="${esc(w)}">Try lookup again</button>` : ''}
    ${e.lookup === 'pending' ? `<p class="muted">Waiting to look this up online.</p>` : ''}
    ${wordInfo(w)}<p class="muted">Right ${p.right} · wrong ${p.wrong} · ${st < 0 ? 'not sorted yet' : `${st}/3 dots (${LV_NAME[st]})`}</p>
    <button class="cta" data-act="study" data-w="${esc(w)}">Study this word again</button>
    ${S.custom[w] ? `<button class="ghost wide danger" data-act="remove" data-w="${esc(w)}">Remove</button>` : ''}</div>`;
  $('#sheet').classList.add('on');
}
$('#sheet').addEventListener('click', ev => { if (ev.target.id === 'sheet' && !$('.help')) closeSheet(); });

// ---------- help / onboarding ----------
const HELP = [
  ['Welcome to SSAT Climb', `Your verbal trainer for the SSAT: <b>synonyms, analogies, and words you don’t know yet</b>. About 15–30 minutes a day, alongside your prep book.<br><br>It works <b>with no internet</b> once it’s installed, and it always remembers exactly where you stopped.`],
  ['Today’s climb', `The big orange button on the Climb screen. Each round mixes <b>new word cards</b>, <b>synonym questions</b>, and <b>analogies</b>, picked from what you need most.<br><br>Missed words come back sooner. Words you know show up less often.`],
  ['Sort your words', `Go through the words 20 at a time — words from your practice test first, then common SSAT words. Tap <b>Don’t know it</b> (0 dots — you get a learning card first), <b>Not sure</b> (1 dot), or <b>I know it</b> (2 dots). The 3rd dot, <b>Mastered</b>, only comes when you answer a 2-dot word right again and tap I know it. Be honest — the words you know least come up most.`],
  ['Synonyms', `Pick the word that means the same thing. <b>Read all five choices</b> before tapping.<br><br>Watch for traps: an <b>opposite</b> of the word, or a word that <b>looks or sounds alike</b> (dubious vs. devious). The app tells you when you fell for one.<br><br>After each answer, tell the app how well you know the word: <b>Don’t know it</b> or <b>Guessed</b> (0 dots), <b>Not sure</b> (1 dot), <b>I know it</b> (2 dots — or Mastered if it already had 2). Miss a word you said you know and it drops to 1 dot. When you miss, you see what the right answer and your pick mean. Tap <b>Explain</b> on a right answer to see why.`],
  ['Analogies: bridge first', `<b>Step 1:</b> before you see the choices, pick how the two words are related — the “bridge.”<br><b>Step 2:</b> try that exact bridge on every choice.<br><br>Changed your mind? <b>Change my bridge / answer</b> lets you redo it. <b>‹ Back</b> at the top lets you look at earlier questions.<br><br>The Bridge guide (Analogies screen, top right) lists all 15 bridges with examples.`],
  ['Add a word — anytime', `See a word you don’t know — in your book, a practice test, anywhere? Tap the orange <b>＋ Word</b> button in the bottom bar. It works on every screen, even in the middle of a question, and you land right back where you were.<br><br>Online, the app looks up the <b>definition, synonyms, opposites, and look-alikes</b> and starts quizzing you. Offline, it saves the word and looks it up as soon as you’re back online.`],
  ['Words & Progress', `The <b>Climb</b> screen shows today’s target, your overall learning, and how many words sit at each level. <b>Words</b> lists everything, with dots showing how well you know each word (3 dots = mastered). Tap a word for its card.<br><br><b>Progress</b> shows your accuracy and which analogy bridges need work. Every right answer climbs you higher — from Basecamp toward Everest.`],
  ['Pace on test day', `With 1.5× time you get about <b>30 seconds per synonym</b> and <b>60 seconds per analogy</b>. Finishing early means you rushed — go back and check.<br><br>Tap <b>?</b> on the Climb screen any time to see these tips again.`]
];
function openHelp(i = 0) {
  const [t, body] = HELP[i]; const last = i === HELP.length - 1;
  $('#sheet').innerHTML = `<div class="sheet-in help"><div class="topline"><div class="kicker">How it works · ${i + 1} of ${HELP.length}</div><button class="ghost" data-act="helpdone">Skip</button></div>
    <h2>${t}</h2><p>${body}</p>
    <div class="hdots">${HELP.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
    <div class="hnav">${i ? `<button class="ghost" data-act="help" data-i="${i - 1}">Back</button>` : '<span></span>'}
    <button class="cta" data-act="${last ? 'helpdone' : 'help'}" data-i="${i + 1}">${last ? 'Start climbing' : 'Next'}</button></div></div>`;
  $('#sheet').classList.add('on');
}

// ---------- updates: check every time the app opens or comes back to the front ----------
let swReg = null;
function checkUpdate(manual) {
  if (!swReg || !navigator.onLine) { if (manual) toast(navigator.onLine ? 'Up to date' : 'Offline — try again when online'); return; }
  swReg.update().then(() => { if (manual && !swReg.installing && !swReg.waiting) toast(`Up to date (v${APP_VERSION})`); }).catch(() => {});
}

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
if (!S.ui.helpSeen) openHelp(0);
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(r => { swReg = r; checkUpdate(); }).catch(() => {});
  // a new version took over: reload once so the new files are used (your place is saved)
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloaded || !navigator.serviceWorker.controller) return; reloaded = true; save(); location.reload(); });
}
})();
