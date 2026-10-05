'use strict';
/**
 * Gestionnaire : file d'attente de conversions + bibliothèque de MP4 hors-ligne.
 */
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { probe, pickStreams, convert, thumbnail } = require('./converter');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const MIN_FREE_BYTES = 200 * 1024 * 1024;

function slugify(s) {
  return (
    String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'video'
  );
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const x = ip.toLowerCase();
  return x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('::ffff:127.');
}

class Manager extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.jobs = new Map();
    this.queue = [];
    this.running = new Map(); // jobId -> { cancel }
    this.reserved = new Set();
    this.metaDir = path.join(cfg.dir, '.meta');
    fs.mkdirSync(this.metaDir, { recursive: true });
    // Nettoie les fichiers partiels laissés par un arrêt brutal.
    for (const f of fs.readdirSync(cfg.dir)) {
      if (f.endsWith('.part')) fs.rmSync(path.join(cfg.dir, f), { force: true });
    }
  }

  /* ------------------------------ Tâches ------------------------------ */

  async addJob({ url, title, quality, referer, dedupe = false }) {
    let u;
    try { u = new URL(url); } catch { throw new Error('URL invalide.'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Seules les URLs http(s) sont acceptées.');
    await this.assertAllowed(u);
    if (dedupe) {
      for (const j of this.jobs.values()) {
        if (j.url === u.href && ['queued', 'probing', 'running', 'done'].includes(j.status)) return { ...this.publicJob(j), duplicate: true };
      }
      if (this._inLibrary(u.href)) return { id: '', url: u.href, status: 'done', duplicate: true };
    }
    if (!['best', '1080', '720', '480', '360'].includes(String(quality || 'best'))) quality = 'best';

    const cleanTitle = String(title || '').trim().slice(0, 200) || decodeURIComponent(u.pathname.split('/').filter(Boolean).slice(-2, -1)[0] || 'Vidéo');
    const id = this._uniqueId(slugify(cleanTitle));
    const job = {
      id, url: u.href, title: cleanTitle, quality: String(quality || 'best'),
      headers: referer ? { Referer: String(referer).slice(0, 2048) } : {},
      status: 'queued', progress: 0, speedX: 0, etaSec: null, bytes: 0, duration: 0,
      height: 0, note: '', error: '', createdAt: Date.now(), finishedAt: null,
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    this._emitJob(job, true);
    this._pump();
    return this.publicJob(job);
  }

  async assertAllowed(u) {
    if (!this.cfg.blockPrivate) return;
    const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true }).catch(() => []);
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Adresse locale ou privée refusée.');
  }

  _inLibrary(href) {
    try {
      for (const f of fs.readdirSync(this.metaDir)) {
        if (!f.endsWith('.json')) continue;
        const m = JSON.parse(fs.readFileSync(path.join(this.metaDir, f), 'utf8'));
        if (m.sourceUrl === href && fs.existsSync(path.join(this.cfg.dir, f.slice(0, -5) + '.mp4'))) return true;
      }
    } catch { /* pas de métadonnées */ }
    return false;
  }

  _uniqueId(base) {
    let id = base;
    for (let n = 2; this.reserved.has(id) || fs.existsSync(path.join(this.cfg.dir, id + '.mp4')); n++) id = `${base}-${n}`;
    this.reserved.add(id);
    return id;
  }

  publicJob(j) {
    const { headers, ...pub } = j; // eslint-disable-line no-unused-vars
    return pub;
  }

  listJobs() {
    return [...this.jobs.values()].map((j) => this.publicJob(j)).sort((a, b) => b.createdAt - a.createdAt);
  }

  _lastEmit = new Map();
  _emitJob(job, force = false) {
    const now = Date.now();
    if (!force && now - (this._lastEmit.get(job.id) || 0) < 400) return;
    this._lastEmit.set(job.id, now);
    this.emit('job', this.publicJob(job));
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'queued') {
      this.queue = this.queue.filter((q) => q !== id);
      this._finish(job, 'canceled');
    } else if (this.running.has(id)) {
      job.canceled = true;
      this.running.get(id).cancel();
    } else {
      // Tâche terminée : on la retire simplement de la liste.
      this.jobs.delete(id);
      this.reserved.delete(id);
      this.emit('job-removed', id);
    }
    return true;
  }

  retry(id) {
    const job = this.jobs.get(id);
    if (!job || !['error', 'canceled'].includes(job.status)) return null;
    Object.assign(job, { status: 'queued', progress: 0, speedX: 0, etaSec: null, bytes: 0, error: '', note: '', canceled: false, finishedAt: null });
    this.queue.push(id);
    this._emitJob(job, true);
    this._pump();
    return this.publicJob(job);
  }

  _pump() {
    while (this.running.size < this.cfg.maxParallel && this.queue.length) {
      const id = this.queue.shift();
      const job = this.jobs.get(id);
      if (!job || job.status !== 'queued') continue;
      this.running.set(id, { cancel() {} });
      this._run(job).catch((e) => this._finish(job, 'error', e.message)).finally(() => {
        this.running.delete(id);
        this._pump();
      });
    }
  }

  _finish(job, status, error = '') {
    job.status = status;
    job.error = error;
    job.etaSec = null;
    job.speedX = 0;
    job.finishedAt = Date.now();
    if (status !== 'done') this.reserved.delete(job.id);
    this._emitJob(job, true);
  }

  async _run(job) {
    const { cfg } = this;
    const opts = { headers: job.headers };
    const part = path.join(cfg.dir, `${job.id}.mp4.part`);
    const finalPath = path.join(cfg.dir, `${job.id}.mp4`);

    try {
      const st = fs.statfsSync(cfg.dir);
      if (st.bavail * st.bsize < MIN_FREE_BYTES) throw new Error('Espace disque insuffisant (moins de 200 Mo libres).');
    } catch (e) {
      if (/Espace disque/.test(e.message)) throw e;
    }

    job.status = 'probing';
    this._emitJob(job, true);
    const info = await probe(cfg.ffprobe, job.url, opts);
    if (job.canceled) return this._cleanup(job, part);
    if (!info.duration) throw new Error('Durée introuvable : les flux en direct ne sont pas pris en charge.');
    const sel = pickStreams(info, job.quality);
    if (!sel.maps.length) throw new Error('Aucune piste audio ou vidéo trouvée.');
    job.duration = info.duration;
    job.height = sel.video ? sel.video.height : 0;

    let res = await this._convert(job, sel, part, false);
    if (!res.ok && !res.canceled && !res.fatal && cfg.fallbackTranscode) {
      job.note = 'Recodage nécessaire';
      job.progress = 0;
      res = await this._convert(job, sel, part, true);
    }
    if (res.canceled || job.canceled) return this._cleanup(job, part);
    if (!res.ok) {
      fs.rmSync(part, { force: true });
      throw new Error(res.error || 'La conversion a échoué.');
    }

    fs.renameSync(part, finalPath);
    const size = fs.statSync(finalPath).size;
    fs.writeFileSync(
      path.join(this.metaDir, job.id + '.json'),
      JSON.stringify({ title: job.title, source: new URL(job.url).host, sourceUrl: job.url, duration: job.duration, height: job.height, createdAt: Date.now() })
    );
    await thumbnail(cfg.ffmpeg, finalPath, Math.min(job.duration * 0.1, 60), path.join(this.metaDir, job.id + '.jpg'));
    job.bytes = size;
    job.progress = 1;
    job.note = '';
    this._finish(job, 'done');
    this.emit('library');
  }

  _convert(job, sel, part, transcode) {
    job.status = 'running';
    this._emitJob(job, true);
    let lastSize = 0, lastT = Date.now();
    const c = convert(this.cfg.ffmpeg, {
      url: job.url, outPath: part, maps: sel.maps, headers: job.headers, transcode,
      onProgress: (p) => {
        if (p.timeSec !== undefined) job.progress = Math.min(0.999, p.timeSec / job.duration);
        if (p.size !== undefined) {
          job.bytes = p.size;
          const now = Date.now();
          if (now - lastT >= 1000) { job.bytesPerSec = Math.round(((p.size - lastSize) * 1000) / (now - lastT)); lastSize = p.size; lastT = now; }
        }
        if (p.speedX > 0 && p.timeSec !== undefined) {
          job.speedX = p.speedX;
          job.etaSec = Math.max(0, Math.round((job.duration - p.timeSec) / p.speedX));
        }
        this._emitJob(job);
      },
    });
    this.running.set(job.id, c);
    return c.done;
  }

  _cleanup(job, part) {
    fs.rmSync(part, { force: true });
    this._finish(job, 'canceled');
  }

  /* ---------------------------- Bibliothèque ---------------------------- */

  validId(id) { return ID_RE.test(id); }

  list() {
    const items = [];
    for (const f of fs.readdirSync(this.cfg.dir)) {
      if (!f.endsWith('.mp4')) continue;
      const id = f.slice(0, -4);
      if (!ID_RE.test(id)) continue;
      const st = fs.statSync(path.join(this.cfg.dir, f));
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(this.metaDir, id + '.json'), 'utf8')); } catch { /* pas de métadonnées */ }
      items.push({
        id, title: meta.title || id.replace(/-/g, ' '), size: st.size, duration: meta.duration || 0,
        height: meta.height || 0, source: meta.source || '', createdAt: meta.createdAt || st.mtimeMs,
        poster: fs.existsSync(path.join(this.metaDir, id + '.jpg')),
      });
    }
    items.sort((a, b) => b.createdAt - a.createdAt);
    let free = null;
    try { const s = fs.statfsSync(this.cfg.dir); free = s.bavail * s.bsize; } catch { /* non supporté */ }
    return { items, usedBytes: items.reduce((n, i) => n + i.size, 0), freeBytes: free };
  }

  filePath(id) { return this.validId(id) ? path.join(this.cfg.dir, id + '.mp4') : null; }
  posterPath(id) { return this.validId(id) ? path.join(this.metaDir, id + '.jpg') : null; }

  remove(id) {
    if (!this.validId(id)) return false;
    const f = this.filePath(id);
    if (!fs.existsSync(f)) return false;
    fs.rmSync(f, { force: true });
    fs.rmSync(path.join(this.metaDir, id + '.json'), { force: true });
    fs.rmSync(this.posterPath(id), { force: true });
    this.reserved.delete(id);
    this.emit('library');
    return true;
  }

  newToken() { return crypto.randomBytes(24).toString('hex'); }
}

module.exports = { Manager };
