// Fusion cron + bouton admin, comme Score Master :
// - GET /api/publish?secret=... (cron VPS) : publie tous les pending_posts
//   "approved" dont l'heure planifiée est atteinte (heure de Paris),
//   sur Instagram ET TikTok (même contenu, même appel).
// - POST /api/publish { id } (bouton "Publier maintenant") : force la
//   publication immédiate d'un post déjà "approved", sans attendre le cron.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const POSTIZ_API_KEY = process.env.POSTIZ_API_KEY;
const POSTIZ_DOMAIN = process.env.POSTIZ_DOMAIN;
// Cette instance Postiz héberge PLUSIEURS comptes Instagram (Hibou Empire +
// d'autres projets, ex: Score Master), tous avec le même `identifier`
// technique ("instagram-standalone") -- un simple .find() sur l'identifier
// pouvait donc prendre le compte Instagram d'un AUTRE projet. On cible
// désormais explicitement le compte par son id Postiz.
const POSTIZ_INSTAGRAM_INTEGRATION_ID = process.env.POSTIZ_INSTAGRAM_INTEGRATION_ID || 'cmu4hc1fi0024po6oq3anp7gm'; // "Furkan" = compte Instagram hibou.empireFR

async function sbFetch(path, options) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, Object.assign({}, options, {
        headers: Object.assign({
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json'
        }, (options && options.headers) || {})
    }));
    if (!res.ok) throw new Error(`Supabase ${path} -> ${res.status}: ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

async function verifyAdmin(accessToken) {
    if (!accessToken) return false;
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${accessToken}` }
    });
    if (!res.ok) return false;
    const user = await res.json();
    if (!user || !user.id) return false;
    const rows = await sbFetch(`profiles?id=eq.${user.id}&select=is_admin`);
    return !!(rows && rows[0] && rows[0].is_admin);
}

async function postizFetch(path, options) {
    const res = await fetch(`https://${POSTIZ_DOMAIN}/api/public/v1${path}`, Object.assign({}, options, {
        headers: Object.assign({
            'Authorization': POSTIZ_API_KEY,
            'Content-Type': 'application/json'
        }, (options && options.headers) || {})
    }));
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = text; }
    if (!res.ok) throw new Error(`Postiz ${path} -> ${res.status}: ${text}`);
    return data;
}

async function postizPublish(item, integrations) {
    if (!Array.isArray(item.carousel_images) || !item.carousel_images.length || !item.carousel_images.every(Boolean)) {
        throw new Error('carousel_images incomplet -- toutes les slides doivent être composées avant publication.');
    }
    const image = item.carousel_images.map(function (url, i) { return { id: item.id + '-' + i, path: url }; });

    // publish_instagram/publish_tiktok choisis par l'admin au moment de la
    // génération (planifiée : toujours les deux ; manuelle : au choix) --
    // on ne cherche même pas l'intégration correspondante si elle n'est pas demandée.
    const wantIg = item.publish_instagram !== false;
    const wantTt = item.publish_tiktok !== false;
    const ig = wantIg ? (integrations || []).find(function (i) { return i.id === POSTIZ_INSTAGRAM_INTEGRATION_ID; }) : null;
    const tt = wantTt ? (integrations || []).find(function (i) { return i.identifier && i.identifier.indexOf('tiktok') !== -1; }) : null;
    // Si TikTok est demandé mais pas encore connecté sur Postiz, on ne bloque
    // pas Instagram pour autant -- on publie ce qui est disponible et on ne
    // lève une erreur que si RIEN n'a pu être publié du tout.
    if (!ig && !tt) throw new Error(wantIg || wantTt ? 'Aucune des plateformes demandées n\'est disponible sur Postiz' : 'Aucune plateforme sélectionnée pour cette publication');

    // Un appel Postiz distinct PAR plateforme -- les envoyer groupées dans un
    // seul appel (posts: [ig, tt]) a échoué silencieusement sur Instagram lors
    // du premier test (aucune erreur renvoyée, mais rien publié), alors qu'un
    // "Post now" manuel sur une seule carte a fonctionné. On reproduit donc
    // exactement ce schéma : un post = un appel.
    if (ig) {
        await postizFetch('/posts', {
            method: 'POST',
            body: JSON.stringify({
                type: 'now', date: new Date().toISOString(), shortLink: false, tags: [],
                posts: [{
                    integration: { id: ig.id },
                    value: [{ content: item.caption, image }],
                    settings: { __type: 'instagram', post_type: 'post' }
                }]
            })
        });
    }
    // TikTok "Photo Mode" (carrousel photo, même principe qu'Instagram) --
    // ajuste `settings` selon ce que Postiz demande une fois l'intégration
    // TikTok connectée (privacyLevel etc, visible dans l'UI Postiz).
    if (tt) {
        await postizFetch('/posts', {
            method: 'POST',
            body: JSON.stringify({
                type: 'now', date: new Date().toISOString(), shortLink: false, tags: [],
                posts: [{
                    integration: { id: tt.id },
                    value: [{ content: item.caption, image }],
                    settings: { __type: 'tiktok', privacyLevel: 'PUBLIC_TO_EVERYONE', disableComment: false }
                }]
            })
        });
    }
}

function parisNowParts() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date());
    const get = (t) => parts.find(p => p.type === t).value;
    return { dateStr: `${get('year')}-${get('month')}-${get('day')}`, minutes: parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10) };
}

function isDue(item, now) {
    if (!item.scheduled_time || !item.scheduled_for) return true;
    if (item.scheduled_for < now.dateStr) return true;
    if (item.scheduled_for > now.dateStr) return false;
    const [h, m] = item.scheduled_time.split(':').map(Number);
    return now.minutes >= (h * 60 + m);
}

async function handleCronSweep(req, res) {
    if (!CRON_SECRET) return res.status(500).json({ error: 'Variable d\'environnement manquante (CRON_SECRET).' });
    if ((req.query.secret || '') !== CRON_SECRET) return res.status(401).json({ error: 'Secret invalide' });

    const summary = { checked: 0, published: [], waiting: [], errors: [] };
    const approvedAll = await sbFetch(`pending_posts?status=eq.approved&select=*`);
    const now = parisNowParts();
    const approved = approvedAll.filter(item => isDue(item, now));
    summary.checked = approved.length;
    summary.waiting = approvedAll.filter(item => !isDue(item, now)).map(item => ({ id: item.id, scheduled_for: item.scheduled_for, scheduled_time: item.scheduled_time }));

    let integrationsCache = null;
    async function getIntegrations() {
        if (!integrationsCache) integrationsCache = await postizFetch('/integrations');
        return integrationsCache;
    }

    for (const item of approved) {
        try {
            await postizPublish(item, await getIntegrations());
            await sbFetch(`pending_posts?id=eq.${item.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'published', published_at: new Date().toISOString() })
            });
            summary.published.push({ id: item.id });
        } catch (innerErr) {
            await sbFetch(`pending_posts?id=eq.${item.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'failed', error: String(innerErr) })
            }).catch(function () {});
            summary.errors.push({ id: item.id, error: String(innerErr) });
        }
    }

    res.status(200).json(summary);
}

async function handleForcePublish(req, res) {
    const authHeader = req.headers.authorization || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '');
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: 'Accès refusé' });

    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id requis' });

    const rows = await sbFetch(`pending_posts?id=eq.${id}&select=*`);
    const item = rows && rows[0];
    if (!item) return res.status(404).json({ error: 'Post introuvable' });
    if (item.status !== 'approved') {
        return res.status(400).json({ error: `Statut actuel "${item.status}" — seuls les posts "approved" peuvent être forcés.` });
    }

    try {
        const integrations = await postizFetch('/integrations');
        await postizPublish(item, integrations);
        await sbFetch(`pending_posts?id=eq.${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'published', published_at: new Date().toISOString() })
        });
        res.status(200).json({ ok: true });
    } catch (error) {
        await sbFetch(`pending_posts?id=eq.${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'failed', error: String(error) })
        }).catch(function () {});
        throw error;
    }
}

module.exports = async function handler(req, res) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !POSTIZ_API_KEY || !POSTIZ_DOMAIN) {
        return res.status(500).json({ error: 'Variables d\'environnement manquantes (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, POSTIZ_API_KEY, POSTIZ_DOMAIN).' });
    }

    try {
        if (req.method === 'GET') return await handleCronSweep(req, res);
        if (req.method === 'POST') return await handleForcePublish(req, res);
        return res.status(405).json({ error: 'Méthode non autorisée' });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
