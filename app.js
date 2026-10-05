'use strict';

const $ = (id) => document.getElementById(id);
const state = { jobs: new Map(), library: { items: [], usedBytes: 0, freeBytes: null }, token: localStorage.getItem('lumina_token') || '' };

/* ------------------------------ Formats ------------------------------ */
const fmtBytes = (n) => {
  if (!n) return '0 Mo';
  const u = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 2 ? 2 : i > 1 ? 1 : 0).replace('.', ',')} ${u[i]}`;
};
const fmtDur = (s) => {
  if (!s) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
const host = (u) => { try { return new URL(u).host; } catch { return ''; } };

/* -------------------------------- Réseau -------------------------------- */
const withToken = (url) => (state.token ? url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(state.token) : url);

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) { await askToken(); return api(path, opts); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erreur ' + res.status);
  return data;
}

let tokenPrompt = null;
function askToken() {
  if (tokenPrompt) return tokenPrompt;
  tokenPrompt = new Promise((resolve) => {
    $('auth').showModal();
    $('authForm').onsubmit = () => {
      state.token = $('authToken').value.trim();
      localStorage.setItem('lumina_token', state.token);
      tokenPrompt = null;
      resolve();
      connect();
    };
  });
  return tokenPrompt;
}

/* --------------------------- Temps réel (SSE) --------------------------- */
let es;
function connect() {
  if (es) es.close();
  es = new EventSource(withToken('/api/events'));
  es.onopen = () => setConn(true);
  es.onerror = () => {
    setConn(false);
    // EventSource ne donne pas le code HTTP : on teste l'accès pour détecter un jeton manquant.
    fetch(withToken('/api/jobs')).then((r) => { if (r.status === 401) askToken(); }).catch(() => {});
  };
  es.addEventListener('snapshot', (e) => {
    const d = JSON.parse(e.data);
    state.jobs = new Map(d.jobs.map((j) => [j.id, j]));
    state.library = d.library;
    renderJobs(true);
    renderLibrary();
  });
  es.addEventListener('job', (e) => { const j = JSON.parse(e.data); state.jobs.set(j.id, j); renderJobs(); });
  es.addEventListener('job-removed', (e) => { state.jobs.delete(JSON.parse(e.data).id); renderJobs(); });
  es.addEventListener('library', (e) => { state.library = JSON.parse(e.data); renderLibrary(); });
}
function setConn(on) {
  const c = $('conn');
  c.dataset.state = on ? 'on' : 'off';
  c.textContent = on ? 'Serveur connecté' : 'Serveur injoignable';
}

/* ------------------------------ Téléchargements ------------------------------ */
const STATUS = { queued: 'En attente', probing: 'Analyse du flux…', running: 'Conversion en cours', done: 'Terminé, disponible hors-ligne', canceled: 'Annulé' };
const els = new Map();

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const k of kids) n.append(k);
  return n;
}

function buildJob(job) {
  const card = el('article', { class: 'card' });
  card.innerHTML = '<h3></h3><p class="where"></p><p class="status" role="status"></p><div class="beam"><i></i></div><p class="stats"></p><div class="actions"></div>';
  card._ = { title: card.querySelector('h3'), where: card.querySelector('.where'), status: card.querySelector('.status'), beam: card.querySelector('.beam'), fill: card.querySelector('.beam i'), stats: card.querySelector('.stats'), actions: card.querySelector('.actions') };
  card._.actionsKey = '';
  return card;
}

function updateJob(card, j) {
  const c = card._;
  c.title.textContent = j.title;
  c.where.textContent = host(j.url);
  const s = j.status;
  c.status.dataset.s = s;
  c.status.textContent = s === 'error' ? j.error || 'La conversion a échoué.' : (STATUS[s] || s) + (s === 'running' && j.note ? ` (${j.note.toLowerCase()})` : '');
  c.beam.dataset.s = s;
  c.fill.style.setProperty('--p', (s === 'done' ? 100 : Math.round(j.progress * 1000) / 10) + '%');
  const parts = [];
  if (s === 'running') {
    parts.push(`${Math.round(j.progress * 100)} %`);
    if (j.bytesPerSec) parts.push(fmtBytes(j.bytesPerSec) + '/s');
    if (j.etaSec != null) parts.push('reste ' + fmtDur(j.etaSec));
  }
  if (j.bytes) parts.push(fmtBytes(j.bytes));
  if (j.duration && s !== 'queued') parts.push(fmtDur(j.duration));
  if (j.height) parts.push(j.height + 'p');
  c.stats.replaceChildren(...parts.map((t) => el('span', {}, t)));
  c.stats.hidden = !parts.length;

  const key = s;
  if (c.actionsKey !== key) {
    c.actionsKey = key;
    const btns = [];
    if (['queued', 'probing', 'running'].includes(s)) btns.push(el('button', { class: 'act danger', type: 'button', onclick: () => api('/api/jobs/' + j.id, { method: 'DELETE' }).catch(showErr) }, 'Annuler'));
    if (['error', 'canceled'].includes(s)) btns.push(el('button', { class: 'act', type: 'button', onclick: () => api(`/api/jobs/${j.id}/retry`, { method: 'POST' }).catch(showErr) }, 'Relancer'));
    if (s === 'done') btns.push(el('button', { class: 'act', type: 'button', onclick: () => { selectTab('lib'); } }, 'Voir hors-ligne'));
    if (['done', 'error', 'canceled'].includes(s)) btns.push(el('button', { class: 'act', type: 'button', onclick: () => api('/api/jobs/' + j.id, { method: 'DELETE' }).catch(showErr) }, 'Retirer de la liste'));
    c.actions.replaceChildren(...btns);
  }
}

let rafJobs = 0;
function renderJobs(force) {
  if (rafJobs && !force) return;
  rafJobs = requestAnimationFrame(() => {
    rafJobs = 0;
    const list = [...state.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
    const root = $('jobs');
    const ids = new Set(list.map((j) => j.id));
    for (const [id, node] of els) if (!ids.has(id)) { node.remove(); els.delete(id); }
    list.forEach((j, i) => {
      let node = els.get(j.id);
      if (!node) { node = buildJob(j); els.set(j.id, node); }
      updateJob(node, j);
      if (root.children[i] !== node) root.insertBefore(node, root.children[i] || null);
    });
    const active = list.filter((j) => ['queued', 'probing', 'running'].includes(j.status)).length;
    $('count-jobs').textContent = active || list.length;
    $('jobsEmpty').hidden = list.length > 0;
  });
}

/* ------------------------------- Bibliothèque ------------------------------- */
function renderLibrary() {
  const { items, usedBytes, freeBytes } = state.library;
  $('count-lib').textContent = items.length;
  $('libEmpty').hidden = items.length > 0;
  const st = $('storage');
  st.hidden = !items.length && freeBytes == null;
  if (!st.hidden) {
    const total = usedBytes + (freeBytes || 0);
    $('gaugeFill').style.width = total ? Math.min(100, (usedBytes / total) * 100) + '%' : '0';
    $('storageText').textContent = `${fmtBytes(usedBytes)} utilisés` + (freeBytes != null ? `, ${fmtBytes(freeBytes)} libres sur le disque` : '');
  }
  $('library').replaceChildren(...items.map((it) => {
    const poster = el('button', { class: 'poster', type: 'button', 'aria-label': 'Lire ' + it.title, onclick: () => play(it) });
    if (it.poster) poster.append(el('img', { src: withToken(`/api/library/${it.id}/poster`), alt: '', loading: 'lazy' }));
    poster.append(el('span', { class: 'play' }));
    const meta = el('div', { class: 'meta' });
    [fmtDur(it.duration), fmtBytes(it.size), it.height ? it.height + 'p' : ''].filter(Boolean).forEach((t) => meta.append(el('span', {}, t)));
    return el('article', { class: 'film' }, poster, el('div', { class: 'film-body' },
      el('h3', {}, it.title), meta,
      el('div', { class: 'actions' },
        el('button', { class: 'act', type: 'button', onclick: () => play(it) }, 'Lire'),
        el('a', { class: 'act', href: withToken(`/media/${it.id}.mp4?download=1`), download: it.id + '.mp4' }, 'Enregistrer'),
        el('button', { class: 'act danger', type: 'button', onclick: () => remove(it) }, 'Supprimer'))));
  }));
}

function play(it) {
  $('playerTitle').textContent = it.title;
  const v = $('video');
  v.src = withToken(`/media/${it.id}.mp4`);
  $('player').showModal();
  v.play().catch(() => {});
}
$('playerClose').onclick = () => $('player').close();
$('player').addEventListener('close', () => { const v = $('video'); v.pause(); v.removeAttribute('src'); v.load(); });
$('player').addEventListener('click', (e) => { if (e.target === $('player')) $('player').close(); });

async function remove(it) {
  if (!confirm(`Supprimer « ${it.title} » de l'appareil ?`)) return;
  try { await api('/api/library/' + it.id, { method: 'DELETE' }); } catch (e) { showErr(e); }
}

/* ---------------------------------- Onglets ---------------------------------- */
function selectTab(name) {
  const lib = name === 'lib';
  $('tab-lib').setAttribute('aria-selected', lib);
  $('tab-jobs').setAttribute('aria-selected', !lib);
  $('panel-lib').hidden = !lib;
  $('panel-jobs').hidden = lib;
}
$('tab-jobs').onclick = () => selectTab('jobs');
$('tab-lib').onclick = () => selectTab('lib');

/* ---------------------------------- Formulaire ---------------------------------- */
function showErr(e) { $('formMsg').textContent = e.message || String(e); }

$('add').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('formMsg').textContent = '';
  const btn = $('submit');
  btn.disabled = true;
  try {
    await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ url: $('url').value.trim(), title: $('title').value.trim(), quality: $('quality').value, referer: $('referer').value.trim() }),
    });
    $('url').value = '';
    $('title').value = '';
    selectTab('jobs');
  } catch (err) { showErr(err); } finally { btn.disabled = false; }
});

connect();
