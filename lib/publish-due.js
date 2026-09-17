// Publication des posts approuvés dont l'heure est atteinte.
//
// Partagé entre api/publish.js (appel externe avec CRON_SECRET) et
// api/ingest.js (appelé par les routines planifiées, qui connaissent déjà le
// secret interne). Sans ce second chemin, rien ne déclenchait la publication
// côté Nova : les posts restaient "approved" indéfiniment.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const POSTIZ_API_KEY = process.env.POSTIZ_API_KEY;
const POSTIZ_DOMAIN = process.env.POSTIZ_DOMAIN;
// Cette instance Postiz héberge plusieurs comptes Instagram partageant le même
// identifiant technique : on cible le compte par son id, jamais par recherche
// sur l'identifiant, sous peine de publier sur le compte d'un autre projet.
const POSTIZ_INSTAGRAM_INTEGRATION_ID = process.env.POSTIZ_INSTAGRAM_INTEGRATION_ID || 'cmu4hc1fi0024po6oq3anp7gm';

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

async function postizFetch(path, options) {
    const res = await fetch(`https://${POSTIZ_DOMAIN}/api/public/v1${path}`, Object.assign({}, options, {
        headers: Object.assign({ 'Authorization': POSTIZ_API_KEY, 'Content-Type': 'application/json' }, (options && options.headers) || {})
    }));
    const text = await res.text();
    if (!res.ok) throw new Error(`Postiz ${path} -> ${res.status}: ${text}`);
    try { return JSON.parse(text); } catch (e) { return text; }
}

async function postizPublish(item, integrations) {
    if (!Array.isArray(item.carousel_images) || !item.carousel_images.length || !item.carousel_images.every(Boolean)) {
        throw new Error('carousel_images incomplet -- toutes les slides doivent être composées avant publication.');
    }
    const image = item.carousel_images.map((url, i) => ({ id: item.id + '-' + i, path: url }));

    const wantIg = item.publish_instagram !== false;
    const wantTt = item.publish_tiktok !== false;
    const ig = wantIg ? (integrations || []).find(i => i.id === POSTIZ_INSTAGRAM_INTEGRATION_ID) : null;
    const tt = wantTt ? (integrations || []).find(i => i.identifier && i.identifier.indexOf('tiktok') !== -1) : null;
    // TikTok pas encore connecté ne doit pas empêcher Instagram : on ne lève une
    // erreur que si rien du tout n'a pu être publié.
    if (!ig && !tt) throw new Error(wantIg || wantTt ? 'Aucune des plateformes demandées n\'est disponible sur Postiz' : 'Aucune plateforme sélectionnée pour cette publication');

    // Un appel par plateforme : groupées dans un seul appel, Postiz acceptait la
    // requête mais ne publiait rien sur Instagram.
    if (ig) {
        await postizFetch('/posts', {
            method: 'POST',
            body: JSON.stringify({
                type: 'now', date: new Date().toISOString(), shortLink: false, tags: [],
                posts: [{ integration: { id: ig.id }, value: [{ content: item.caption, image }], settings: { __type: 'instagram', post_type: 'post' } }]
            })
        });
    }
    if (tt) {
        await postizFetch('/posts', {
            method: 'POST',
            body: JSON.stringify({
                type: 'now', date: new Date().toISOString(), shortLink: false, tags: [],
                posts: [{ integration: { id: tt.id }, value: [{ content: item.caption, image }], settings: { __type: 'tiktok', privacyLevel: 'PUBLIC_TO_EVERYONE', disableComment: false } }]
            })
        });
    }
}

function parisNowParts() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date());
    const get = t => parts.find(p => p.type === t).value;
    return { dateStr: `${get('year')}-${get('month')}-${get('day')}`, minutes: parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10) };
}

function isDue(item, now) {
    if (!item.scheduled_for) return false; // sans date, rien n'est dû
    if (item.scheduled_for < now.dateStr) return true;
    if (item.scheduled_for > now.dateStr) return false;
    if (!item.scheduled_time) return true;
    const [h, m] = item.scheduled_time.split(':').map(Number);
    return now.minutes >= (h * 60 + m);
}

async function publishDue() {
    const summary = { checked: 0, published: [], waiting: [], errors: [] };
    const approvedAll = await sbFetch('pending_posts?status=eq.approved&select=*');
    const now = parisNowParts();
    const due = (approvedAll || []).filter(item => isDue(item, now));
    summary.checked = due.length;
    summary.waiting = (approvedAll || []).filter(item => !isDue(item, now))
        .map(item => ({ id: item.id, scheduled_for: item.scheduled_for, scheduled_time: item.scheduled_time }));

    if (!due.length) return summary;

    const integrations = await postizFetch('/integrations');

    for (const item of due) {
        try {
            await postizPublish(item, integrations);
            await sbFetch(`pending_posts?id=eq.${item.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'published', published_at: new Date().toISOString() })
            });
            summary.published.push({ id: item.id });
        } catch (err) {
            await sbFetch(`pending_posts?id=eq.${item.id}`, {
                method: 'PATCH', body: JSON.stringify({ status: 'failed', error: String(err) })
            }).catch(function () {});
            summary.errors.push({ id: item.id, error: String(err) });
        }
    }

    return summary;
}

module.exports = { publishDue, postizPublish, postizFetch, parisNowParts, isDue };
