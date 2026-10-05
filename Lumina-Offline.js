// ===================== CONFIGURATION LUMINA OFFLINE =====================
// Adresse du serveur LUMINA Offline, joignable depuis l'appareil qui exécute ce script
// (même Wi-Fi : utilisez l'IP de l'ordinateur, ex. http://192.168.1.20:8787).
var SERVEUR = 'http://192.168.1.20:8787';
// Même valeur que LUMINA_TOKEN au lancement du serveur (obligatoire pour cette route).
var JETON = 'remplacez-par-votre-jeton';
// Mettre false pour récupérer les infos sans lancer la conversion.
var ENVOYER_AU_SERVEUR = true;
// Qualité maximale : 'best', '1080', '720', '480' ou '360'.
var QUALITE = 'best';
// =======================================================================

var urlID = 'fld-c7d4a65e07fa4ecba850bbd9b0c46e04';
var m3u8ID = 'fld-ddd80f77ca044e319d1c18a5417f1ae6';
var titreID = 'fld-4cf9a3b0a2e6474b89e4a1742128cd8a';
var afficheID = 'fld-29b728c951f34992b8938cf5d08b7319';

function decoderEntitesHTML(texte) {
    return texte.replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/&eacute;/g, 'é').replace(/&egrave;/g, 'è').replace(/&agrave;/g, 'à').replace(/&ccedil;/g, 'ç').trim();
}

function extraireTitre(html) {
    var titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (titleMatch) return decoderEntitesHTML(titleMatch[1]);
    return null;
}

function extraireAffiche(html) {
    var match = html.match(/class=["']film-detail-poster["'][\s\S]*?<img[^>]+src=["']([^"']+)["']/i);
    return match ? match[1] : null;
}

function extraireLienVideo(html) {
    var m3u8Regex = /https?:\/\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?/i;

    // 1. .m3u8 direct dans la page principale
    var m3u8Direct = html.match(m3u8Regex);
    if (m3u8Direct) {
        return { url: m3u8Direct[0], type: 'm3u8 direct' };
    }

    // 2. Sinon, iframe -> chercher un .m3u8 dedans
    var iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    if (iframeMatch) {
        var iframeUrl = iframeMatch[1];
        var iframeHtml = Utils.getTextFromUrl(iframeUrl);

        if (iframeHtml) {
            var m3u8DansIframe = iframeHtml.match(m3u8Regex);
            if (m3u8DansIframe) {
                return { url: m3u8DansIframe[0], type: 'm3u8 via iframe' };
            }
        }

        // 3. Repli : le lien de l'iframe lui-même
        return { url: iframeUrl, type: 'iframe (lien de page)' };
    }

    return null;
}

// Envoie le lien au serveur LUMINA Offline (requête GET, seule méthode utilisée par ce script).
// Retourne un court message d'état.
function envoyerAuServeur(lienVideo, titre, pageUrl) {
    if (!ENVOYER_AU_SERVEUR) return '';
    if (!/\.m3u8(\?|$)/i.test(lienVideo)) return ' | ⚠️ Non envoyé : ce n\'est pas un lien .m3u8';

    var adresse = SERVEUR.replace(/\/+$/, '') + '/api/add'
        + '?token=' + encodeURIComponent(JETON)
        + '&url=' + encodeURIComponent(lienVideo)
        + '&title=' + encodeURIComponent(titre || '')
        + '&quality=' + encodeURIComponent(QUALITE)
        + '&referer=' + encodeURIComponent(pageUrl || '');

    var reponse;
    try {
        reponse = Utils.getTextFromUrl(adresse);
    } catch (e) {
        return ' | ❌ Serveur injoignable : ' + e;
    }
    if (!reponse) return ' | ❌ Serveur injoignable (' + SERVEUR + ')';

    try {
        var r = JSON.parse(reponse);
        if (r.error) return ' | ❌ Serveur : ' + r.error;
        if (r.duplicate) return ' | ℹ️ Déjà envoyé ou téléchargé';
        return ' | 📥 Conversion lancée (' + r.status + ')';
    } catch (e) {
        return ' | ❌ Réponse inattendue du serveur';
    }
}

function recupererInfosFilm() {
    var pageUrl = record.getFieldValue(urlID);
    if (!pageUrl) { return "⚠️ Aucune URL."; }

    var html = Utils.getTextFromUrl(pageUrl);
    if (!html) { return "❌ Impossible de récupérer la page."; }

    var titre = extraireTitre(html);
    if (titre) { record.setFieldValue(titreID, titre); }

    var affiche = extraireAffiche(html);
    if (affiche) { record.addPhotoFromUrlToField(affiche, afficheID); }

    var video = extraireLienVideo(html);
    if (!video) {
        form.saveAllChanges();
        return "❌ Aucun lien vidéo trouvé." + (titre ? " | Titre : " + titre : "");
    }

    record.setFieldValue(m3u8ID, video.url);
    form.saveAllChanges();

    var etatServeur = envoyerAuServeur(video.url, titre, pageUrl);

    return "✅ (" + video.type + ") " + video.url
        + (titre ? " | Titre : " + titre : "")
        + (affiche ? " | Affiche téléchargée" : "")
        + etatServeur;
}

recupererInfosFilm();
