'use strict';
/**
 * Extraction de liens vidéo (.m3u8 / .mp4) depuis le code HTML d'une page.
 * Fonction pure, sans dépendance : utilisée par le serveur (Node) et par la plateforme LUMINA (navigateur).
 */
function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&eacute;/g, 'é').replace(/&egrave;/g, 'è').replace(/&agrave;/g, 'à').replace(/&ccedil;/g, 'ç')
    .replace(/&ecirc;/g, 'ê').replace(/&ocirc;/g, 'ô').replace(/&icirc;/g, 'î').replace(/&ucirc;/g, 'û')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function extractFromHtml(html, baseUrl) {
  // Les URLs sont souvent échappées dans le JavaScript de la page (https:\/\/…, \u0026).
  const text = String(html).replace(/\\u0026/gi, '&').replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const found = new Map();
  const resolve = (raw) => { try { return new URL(String(raw).trim(), baseUrl).href; } catch (e) { return null; } };
  const add = (raw, via) => {
    const u = resolve(raw);
    if (!u || !/^https?:/i.test(u)) return;
    const path = u.split('#')[0];
    const type = /\.m3u8(\?|$)/i.test(path) ? 'hls' : /\.mp4(\?|$)/i.test(path) ? 'mp4' : null;
    if (type && !found.has(u)) found.set(u, { url: u, type, via });
  };

  for (const m of text.matchAll(/https?:\/\/[^"'\s<>\\)]+?\.(?:m3u8|mp4)(?:\?[^"'\s<>\\)]*)?/gi)) add(m[0], 'page');
  for (const m of text.matchAll(/["'(]((?!https?:)[^"'\s<>()]+?\.(?:m3u8|mp4)(?:\?[^"'\s<>()]*)?)["')]/gi)) add(m[1], 'page');

  const meta = (prop) => {
    const a = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*content=["\']([^"\']*)["\']', 'i').exec(html);
    const b = new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + prop + '["\']', 'i').exec(html);
    return (a && a[1]) || (b && b[1]) || '';
  };
  let title = meta('og:title');
  if (!title) { const t = /<title[^>]*>([^<]*)<\/title>/i.exec(html); title = t ? t[1] : ''; }
  let poster = meta('og:image');
  if (!poster) { const p = /class=["'][^"']*film-detail-poster[^"']*["'][\s\S]*?<img[^>]+src=["']([^"']+)["']/i.exec(html); poster = p ? p[1] : ''; }
  if (!poster) { const p = /<video[^>]+poster=["']([^"']+)["']/i.exec(html); poster = p ? p[1] : ''; }

  const iframes = [];
  for (const m of String(html).matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)) { const u = resolve(decodeEntities(m[1])); if (u && /^https?:/i.test(u) && !iframes.includes(u)) iframes.push(u); }

  return { title: decodeEntities(title), poster: poster ? resolve(decodeEntities(poster)) || '' : '', candidates: sortCandidates([...found.values()]), iframes };
}

function sortCandidates(list) {
  const rank = (c) => (c.type === 'hls' ? 0 : 10) + (c.via === 'page' ? 0 : 1) + (/master|index|playlist/i.test(c.url) ? -0.5 : 0);
  return list.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c);
}

if (typeof module !== 'undefined') module.exports = { extractFromHtml, sortCandidates, decodeEntities };
