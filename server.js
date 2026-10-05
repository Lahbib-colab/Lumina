#!/usr/bin/env node
'use strict';
/**
 * LUMINA Offline : serveur local de conversion HLS (.m3u8) -> MP4.
 * Zéro dépendance npm. Prérequis : Node 18.17+ et FFmpeg.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream');
const { Manager } = require('./lib/manager');
const { extractFromUrl } = require('./lib/extract');

const CFG = {
  port: parseInt(process.env.PORT, 10) || 8787,
  host: process.env.HOST || '127.0.0.1',
  dir: path.resolve(process.env.LUMINA_DIR || path.join(__dirname, 'library')),
  token: process.env.LUMINA_TOKEN || '',
  origin: process.env.LUMINA_ORIGIN || '', // origine autorisée (CORS) si LUMINA est hébergée ailleurs
  maxParallel: Math.max(1, parseInt(process.env.MAX_PARALLEL, 10) || 2),
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
  blockPrivate: process.env.BLOCK_PRIVATE === '1',
  fallbackTranscode: process.env.FALLBACK_TRANSCODE !== '0',
  trustProxy: process.env.TRUST_PROXY === '1',            // derrière un proxy HTTPS (Render, Caddy, Fly…)
  retentionHours: parseFloat(process.env.RETENTION_HOURS) || 0, // supprime les MP4 du serveur après N heures (0 = jamais)
  sweepSeconds: parseInt(process.env.SWEEP_SECONDS, 10) || 600,
};

const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(CFG.host);
if (!isLoopback && !CFG.token) {
  console.error('Refus de démarrer : le serveur est exposé au réseau, définissez LUMINA_TOKEN (au moins 12 caractères).');
  process.exit(1);
}
if (!isLoopback && CFG.token.length < 12) {
  console.error('Refus de démarrer : LUMINA_TOKEN est trop court pour un serveur exposé (12 caractères minimum).');
  process.exit(1);
}

fs.mkdirSync(CFG.dir, { recursive: true });
const manager = new Manager(CFG);
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.mp4': 'video/mp4',
};

/* ------------------------------ Utilitaires ------------------------------ */

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Requête trop volumineuse.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('JSON invalide.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const fails = new Map(); // ip -> { n, reset }
function clientIp(req) {
  if (CFG.trustProxy) { const f = (req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (f) return f; }
  return req.socket.remoteAddress || '';
}
function tooManyFails(ip) { const f = fails.get(ip); return !!f && f.reset > Date.now() && f.n >= 10; }
function recordFail(ip) {
  const now = Date.now(); const f = fails.get(ip);
  if (!f || f.reset < now) fails.set(ip, { n: 1, reset: now + 10 * 60 * 1000 }); else f.n++;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of fails) if (v.reset < now) fails.delete(k); }, 60000).unref();

function authorized(req, url) {
  if (!CFG.token) return true;
  const h = req.headers.authorization || '';
  const given = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token') || '';
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(CFG.token).digest();
  return crypto.timingSafeEqual(a, b);
}

// Protège contre le « DNS rebinding » quand le serveur n'écoute qu'en local et sans jeton.
function hostAllowed(req) {
  if (CFG.token || !isLoopback) return true;
  const host = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return ['localhost', '127.0.0.1', '::1'].includes(host);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  // Avec un jeton (obligatoire pour toute requête protégée), la plateforme peut être ouverte depuis n'importe où, y compris un fichier local.
  const allowed = CFG.origin ? origin === CFG.origin : !!CFG.token && !!origin;
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', CFG.origin ? origin : '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  }
}

function serveFile(req, res, file, { download = false, name = '' } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { res.writeHead(404); return res.end(); }
  if (!st.isFile()) { res.writeHead(404); return res.end(); }
  const size = st.size;
  const type = MIME[path.extname(file)] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  if (download) headers['Content-Disposition'] = `attachment; filename="${name.replace(/[^\w.-]+/g, '_')}"`;

  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (m[1] === '' && m[2] === '')) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    if (m[1] === '') { start = Math.max(0, size - parseInt(m[2], 10)); }
    else { start = parseInt(m[1], 10); if (m[2] !== '') end = Math.min(end, parseInt(m[2], 10)); }
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  pipeline(fs.createReadStream(file, { start, end }), res, () => {});
}

/* ---------------------------------- SSE ---------------------------------- */

const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
manager.on('job', (j) => broadcast('job', j));
manager.on('job-removed', (id) => broadcast('job-removed', { id }));
manager.on('library', () => broadcast('library', manager.list()));
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000).unref();

/* --------------------------------- Routes -------------------------------- */

async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  let r;

  if (p === '/api/health' && m === 'GET') return json(res, 200, { ok: true, lumina: true, version: '1.1.0', auth: !!CFG.token, maxParallel: CFG.maxParallel });

  if (p === '/api/events' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    res.write(`event: snapshot\ndata: ${JSON.stringify({ jobs: manager.listJobs(), library: manager.list() })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Extraction du flux vidéo (.m3u8 / .mp4) à partir d'une page web.
  if (p === '/api/extract' && m === 'GET') {
    const target = url.searchParams.get('url');
    if (!target) return json(res, 400, { error: 'Paramètre « url » requis.' });
    try {
      const out = await extractFromUrl(target, { referer: url.searchParams.get('referer') || '', assertAllowed: (u) => manager.assertAllowed(u) });
      return json(res, 200, out);
    } catch (e) {
      return json(res, 400, { error: e.name === 'TimeoutError' ? 'La page ne répond pas (délai dépassé).' : e.message });
    }
  }

  // Pour les scripts qui ne savent faire que des GET (ex. Utils.getTextFromUrl). Jeton obligatoire.
  if (p === '/api/add' && m === 'GET') {
    if (!CFG.token) return json(res, 403, { error: 'Définissez LUMINA_TOKEN pour utiliser /api/add.' });
    const q = url.searchParams;
    if (!q.get('url')) return json(res, 400, { error: 'Paramètre « url » requis.' });
    try {
      const job = await manager.addJob({ url: q.get('url'), title: q.get('title') || '', quality: q.get('quality') || 'best', referer: q.get('referer') || '', dedupe: true });
      return json(res, 200, { ok: true, id: job.id, status: job.status, duplicate: !!job.duplicate });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  if (p === '/api/jobs' && m === 'GET') return json(res, 200, manager.listJobs());

  if (p === '/api/jobs' && m === 'POST') {
    const body = await readBody(req);
    if (!body.url) return json(res, 400, { error: 'Le champ « url » est requis.' });
    try { return json(res, 201, await manager.addJob(body)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }

  if ((r = /^\/api\/jobs\/([a-z0-9-]+)$/.exec(p)) && m === 'DELETE') {
    return manager.cancel(r[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Tâche introuvable.' });
  }

  if ((r = /^\/api\/jobs\/([a-z0-9-]+)\/retry$/.exec(p)) && m === 'POST') {
    const j = manager.retry(r[1]);
    return j ? json(res, 200, j) : json(res, 404, { error: 'Tâche introuvable ou non relançable.' });
  }

  if (p === '/api/library' && m === 'GET') return json(res, 200, manager.list());

  if ((r = /^\/api\/library\/([a-z0-9-]+)$/.exec(p)) && m === 'DELETE') {
    return manager.remove(r[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Fichier introuvable.' });
  }

  if ((r = /^\/api\/library\/([a-z0-9-]+)\/poster$/.exec(p)) && (m === 'GET' || m === 'HEAD')) {
    const f = manager.posterPath(r[1]);
    return f ? serveFile(req, res, f) : json(res, 404, { error: 'Introuvable.' });
  }

  return json(res, 404, { error: 'Route inconnue.' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!hostAllowed(req)) { res.writeHead(403); return res.end('Hôte refusé.'); }
    applyCors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const p = url.pathname;
    const protectedRoute = p.startsWith('/api/') && p !== '/api/health' || p.startsWith('/media/');
    if (protectedRoute) {
      const ip = clientIp(req);
      if (tooManyFails(ip)) { res.setHeader('Retry-After', '600'); return json(res, 429, { error: 'Trop de tentatives. Réessayez dans quelques minutes.' }); }
      if (!authorized(req, url)) { recordFail(ip); return json(res, 401, { error: 'Jeton requis ou invalide.' }); }
    }

    if (p.startsWith('/api/')) return await handleApi(req, res, url);

    let r;
    if ((r = /^\/media\/([a-z0-9-]+)\.mp4$/.exec(p)) && (req.method === 'GET' || req.method === 'HEAD')) {
      const f = manager.filePath(r[1]);
      return serveFile(req, res, f, { download: url.searchParams.get('download') === '1', name: r[1] + '.mp4' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    const rel = (p.endsWith('/') ? p + 'index.html' : p).replace(/^\/+/, '');
    if (rel.includes('\0')) { res.writeHead(400); return res.end(); }
    const file = path.normalize(path.join(PUBLIC, decodeURIComponent(rel)));
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
    return serveFile(req, res, file);
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { error: e.message || 'Erreur interne.' });
    else res.end();
  }
});

server.listen(CFG.port, CFG.host, () => {
  const shown = isLoopback ? 'localhost' : CFG.host;
  console.log(`\n  LUMINA Offline prêt : http://${shown}:${CFG.port}`);
  console.log(`  Bibliothèque : ${CFG.dir}`);
  console.log(`  Conversions parallèles : ${CFG.maxParallel}${CFG.token ? '  |  Jeton activé' : ''}\n`);
});

// Supprime les MP4 plus vieux que RETENTION_HOURS (utile sur un serveur en ligne : la copie utile est dans l'appareil).
if (CFG.retentionHours > 0) {
  const sweep = () => {
    const limit = Date.now() - CFG.retentionHours * 3600 * 1000;
    try {
      for (const f of fs.readdirSync(CFG.dir)) {
        if (!f.endsWith('.mp4')) continue;
        if (fs.statSync(path.join(CFG.dir, f)).mtimeMs < limit) manager.remove(f.slice(0, -4));
      }
    } catch (e) { /* dossier indisponible */ }
  };
  setInterval(sweep, CFG.sweepSeconds * 1000).unref();
  console.log(`  Nettoyage automatique : fichiers supprimés après ${CFG.retentionHours} h`);
}

function shutdown() {
  console.log('\nArrêt…');
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
