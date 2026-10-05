#!/usr/bin/env node
'use strict';
/**
 * Génère un flux HLS de test (2 qualités, 20 s, vidéo + son) et le sert en local.
 * Collez ensuite http://localhost:8788/master.m3u8 dans LUMINA Offline pour essayer.
 */
const { spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-demo-'));
const PORT = parseInt(process.env.DEMO_PORT, 10) || 8788;

console.log('Génération du flux de test…');
const r = spawnSync(ffmpeg, [
  '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=20',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
  '-filter_complex', '[0:v]split=2[a][b];[b]scale=640:360[bs]',
  '-map', '[a]', '-map', '[bs]', '-map', '1:a', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
  '-b:v:0', '2500k', '-b:v:1', '800k',
  '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
  '-master_pl_name', 'master.m3u8',
  '-var_stream_map', 'v:0,a:0 v:1,a:1',
  path.join(dir, 'stream_%v.m3u8'),
], { stdio: 'inherit' });
if (r.status !== 0) { console.error('Échec : FFmpeg avec libx264 est requis pour la démo.'); process.exit(1); }

const types = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t' };
http.createServer((req, res) => {
  const f = path.join(dir, path.basename(decodeURIComponent(req.url.split('?')[0])));
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`\nFlux de test prêt : http://localhost:${PORT}/master.m3u8\n(Ctrl+C pour arrêter)`);
});
