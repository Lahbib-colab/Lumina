'use strict';
/** Extraction côté serveur : va chercher la page (et ses iframes) puis en tire les flux vidéo. */
const { extractFromHtml, sortCandidates } = require('./extract-core');

const MAX_BYTES = 3 * 1024 * 1024;
const isDirect = (u) => /\.(m3u8|mp4)(\?|#|$)/i.test(u);

async function fetchText(url, referer) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LuminaOffline)', Accept: 'text/html,application/xhtml+xml,*/*', ...(referer ? { Referer: referer } : {}) },
  });
  if (!res.ok) throw new Error(`Page inaccessible (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.subarray(0, MAX_BYTES).toString('utf8');
}

/**
 * @param {string} pageUrl  page ou lien direct
 * @param {{referer?: string, assertAllowed?: (u: URL) => Promise<void>}} opts
 */
async function extractFromUrl(pageUrl, opts = {}) {
  const u = new URL(pageUrl);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Seules les URLs http(s) sont acceptées.');
  if (isDirect(u.pathname + u.search)) {
    return { pageUrl: '', title: '', poster: '', candidates: [{ url: u.href, type: /\.m3u8/i.test(u.pathname + u.search) ? 'hls' : 'mp4', via: 'direct' }] };
  }
  if (opts.assertAllowed) await opts.assertAllowed(u);
  const html = await fetchText(u.href, opts.referer);
  if (html.trimStart().startsWith('#EXTM3U')) return { pageUrl: '', title: '', poster: '', candidates: [{ url: u.href, type: 'hls', via: 'direct' }] };

  const res = extractFromHtml(html, u.href);
  const hasHls = () => res.candidates.some((c) => c.type === 'hls');
  // Pas de flux HLS dans la page : on regarde dans les iframes (au plus 3, un seul niveau).
  if (!hasHls()) {
    for (const f of res.iframes.slice(0, 3)) {
      try {
        if (opts.assertAllowed) await opts.assertAllowed(new URL(f));
        const sub = extractFromHtml(await fetchText(f, u.href), f);
        for (const c of sub.candidates) if (!res.candidates.some((x) => x.url === c.url)) res.candidates.push({ ...c, via: 'iframe' });
        if (!res.title && sub.title) res.title = sub.title;
        if (!res.poster && sub.poster) res.poster = sub.poster;
        if (hasHls()) break;
      } catch (e) { /* iframe inaccessible : on passe à la suivante */ }
    }
    res.candidates = sortCandidates(res.candidates);
  }
  return { pageUrl: u.href, title: res.title, poster: res.poster, candidates: res.candidates };
}

module.exports = { extractFromUrl, isDirect };
