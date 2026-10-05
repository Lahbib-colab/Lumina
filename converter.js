'use strict';
/**
 * Couche FFmpeg / FFprobe : analyse d'un flux HLS et conversion en MP4.
 * Aucune dépendance npm : seul le binaire ffmpeg est requis.
 */
const { spawn } = require('child_process');

// Protocoles autorisés pour ffmpeg : empêche la lecture de fichiers locaux via une playlist piégée.
const PROTOCOLS = 'http,https,tcp,tls,crypto';
const ALLOWED_HEADERS = new Set(['referer', 'origin']);

const clean = (v) => String(v).replace(/[\r\n]+/g, ' ').slice(0, 2048);

function inputArgs(opts = {}) {
  const args = ['-protocol_whitelist', PROTOCOLS, '-rw_timeout', '30000000'];
  args.push('-user_agent', clean(opts.userAgent || 'Mozilla/5.0 (Lumina Offline)'));
  const lines = [];
  for (const [k, v] of Object.entries(opts.headers || {})) {
    if (ALLOWED_HEADERS.has(k.toLowerCase()) && v) lines.push(`${k}: ${clean(v)}`);
  }
  if (lines.length) args.push('-headers', lines.join('\r\n') + '\r\n');
  return args;
}

/** Analyse le flux : durée, flux vidéo disponibles (variantes), audio. */
function probe(ffprobeBin, url, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...inputArgs(opts), url];
    const child = spawn(ffprobeBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error("Délai dépassé pendant l'analyse du flux."));
    }, 45000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? 'ffprobe introuvable. Installez FFmpeg.' : e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error('Flux inaccessible : ' + (err.trim().split('\n').pop() || 'erreur inconnue')));
      }
      try {
        const data = JSON.parse(out);
        const streams = data.streams || [];
        const videos = streams
          .filter((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic))
          .map((s) => ({
            index: s.index,
            width: s.width || 0,
            height: s.height || 0,
            bitrate: parseInt(s.bit_rate, 10) || 0,
          }));
        const audios = streams.filter((s) => s.codec_type === 'audio').map((s) => ({ index: s.index }));
        const duration = parseFloat(data.format && data.format.duration);
        resolve({ duration: Number.isFinite(duration) && duration > 0 ? duration : 0, videos, audios });
      } catch (e) {
        reject(new Error('Réponse ffprobe illisible.'));
      }
    });
  });
}

/** Choisit la meilleure variante vidéo (≤ qualité demandée) + la première piste audio. */
function pickStreams(info, quality) {
  let cands = info.videos.slice();
  if (quality && quality !== 'best' && cands.length) {
    const max = parseInt(quality, 10);
    const ok = cands.filter((v) => v.height && v.height <= max);
    cands = ok.length ? ok : [cands.sort((a, b) => a.height - b.height)[0]];
  }
  cands.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));
  const video = cands[0] || null;
  const audio = info.audios[0] || null;
  const maps = [];
  if (video) maps.push('-map', `0:${video.index}`);
  if (audio) maps.push('-map', `0:${audio.index}`);
  return { video, audio, maps };
}

/**
 * Lance la conversion. Par défaut : copie sans recodage (rapide, sans perte).
 * transcode=true : recodage H.264/AAC (repli si les codecs ne passent pas dans un MP4).
 */
function convert(ffmpegBin, o) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    ...inputArgs(o),
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', o.url, ...o.maps,
    ...(o.transcode
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-b:a', '160k']
      : ['-c', 'copy']),
    '-movflags', '+faststart', '-f', 'mp4',
    '-progress', 'pipe:1', '-nostats', o.outPath,
  ];
  const child = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let canceled = false;
  let stderr = '';
  let buf = '';
  const state = {};

  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq);
      const v = line.slice(eq + 1);
      if (k === 'out_time_us' || k === 'out_time_ms') {
        const us = parseInt(v, 10);
        if (Number.isFinite(us) && us >= 0) state.timeSec = us / 1e6;
      } else if (k === 'total_size') {
        state.size = parseInt(v, 10) || 0;
      } else if (k === 'speed') {
        const s = parseFloat(v);
        if (Number.isFinite(s)) state.speedX = s;
      } else if (k === 'progress' && o.onProgress) {
        o.onProgress({ ...state });
      }
    }
  });
  child.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-2000);
  });

  const done = new Promise((resolve) => {
    child.on('error', (e) =>
      resolve({
        ok: false,
        canceled,
        fatal: e.code === 'ENOENT',
        error: e.code === 'ENOENT' ? 'ffmpeg introuvable. Installez FFmpeg.' : e.message,
      })
    );
    child.on('close', (code) =>
      resolve({
        ok: code === 0 && !canceled,
        canceled,
        code,
        error: stderr.trim().split('\n').slice(-2).join(' '),
      })
    );
  });

  return {
    done,
    cancel() {
      canceled = true;
      child.kill('SIGTERM');
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 3000).unref();
    },
  };
}

function thumbnail(ffmpegBin, file, atSec, outJpg) {
  return new Promise((resolve) => {
    const c = spawn(
      ffmpegBin,
      ['-v', 'error', '-y', '-ss', String(Math.max(0, atSec)), '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', outJpg],
      { stdio: 'ignore' }
    );
    c.on('error', () => resolve(false));
    c.on('close', (code) => resolve(code === 0));
  });
}

module.exports = { probe, pickStreams, convert, thumbnail };
