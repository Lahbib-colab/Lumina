/**
 * Client JavaScript pour intégrer LUMINA Offline dans l'interface LUMINA.
 * Fonctionne dans le navigateur (ES2018+) sans dépendance.
 *
 *   const off = new LuminaOffline('http://localhost:8787', { token: '...' });
 *   const job = await off.download('https://…/master.m3u8', { title: 'Mon film', quality: '720' });
 *   off.subscribe({ onJob: j => console.log(j.progress), onLibrary: lib => render(lib.items) });
 *   video.src = off.mediaUrl('mon-film');   // lecture hors-ligne
 *
 * Si LUMINA est servie depuis une autre origine, lancez le serveur avec
 * LUMINA_ORIGIN=https://votre-interface.exemple
 */
class LuminaOffline {
  constructor(baseUrl = 'http://localhost:8787', { token = '' } = {}) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  async _req(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = 'Bearer ' + this.token;
    const res = await fetch(this.base + path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Erreur ' + res.status);
    return data;
  }

  _q(url) { return this.token ? url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(this.token) : url; }

  health() { return this._req('/api/health'); }
  download(url, { title = '', quality = 'best', referer = '' } = {}) {
    return this._req('/api/jobs', { method: 'POST', body: JSON.stringify({ url, title, quality, referer }) });
  }
  jobs() { return this._req('/api/jobs'); }
  cancel(id) { return this._req('/api/jobs/' + id, { method: 'DELETE' }); }
  retry(id) { return this._req(`/api/jobs/${id}/retry`, { method: 'POST' }); }
  library() { return this._req('/api/library'); }
  remove(id) { return this._req('/api/library/' + id, { method: 'DELETE' }); }
  mediaUrl(id, { download = false } = {}) { return this._q(`${this.base}/media/${id}.mp4${download ? '?download=1' : ''}`); }
  posterUrl(id) { return this._q(`${this.base}/api/library/${id}/poster`); }

  /** Suivi temps réel. Retourne une fonction pour arrêter l'écoute. */
  subscribe({ onSnapshot, onJob, onJobRemoved, onLibrary, onStatus } = {}) {
    const es = new EventSource(this._q(this.base + '/api/events'));
    const on = (name, fn) => fn && es.addEventListener(name, (e) => fn(JSON.parse(e.data)));
    on('snapshot', onSnapshot); on('job', onJob); on('job-removed', onJobRemoved); on('library', onLibrary);
    es.onopen = () => onStatus && onStatus(true);
    es.onerror = () => onStatus && onStatus(false);
    return () => es.close();
  }
}

if (typeof module !== 'undefined') module.exports = { LuminaOffline };
