// Suivi d'une génération instantanée lancée par /api/generate-now.
//
// POST /api/generation-progress { id } -> { status, carousel_images, ready, error }
// Interrogé en boucle par l'appli pendant que l'aperçu se remplit. Pour chaque
// slide pas encore récupérée, on interroge Higgsfield ; dès qu'elle est prête
// on la recopie dans Supabase Storage (les URLs Higgsfield sont temporaires)
// et on l'inscrit à sa place dans carousel_images. Quand les 8 sont là, le
// post passe en "pending" : il attend l'approbation humaine, avec le choix de
// l'heure et des plateformes.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HF_KEY_ID = process.env.HF_KEY_ID;
const HF_KEY_SECRET = process.env.HF_KEY_SECRET;
const BUCKET = 'hibou-content';

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

async function storeSlide(postId, slideIndex, sourceUrl) {
    const imgRes = await fetch(sourceUrl);
    if (!imgRes.ok) throw new Error(`Téléchargement slide -> ${imgRes.status}`);
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const ext = (contentType.split('/')[1] || 'jpg').split(';')[0];
    const buf = Buffer.from(await imgRes.arrayBuffer());

    const objectPath = `posts/${postId}-slide${slideIndex}.${ext}`;
    const upRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`, {
        method: 'POST',
        headers: {
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': contentType,
            'x-upsert': 'true'
        },
        body: buf
    });
    if (!upRes.ok) throw new Error(`Supabase Storage upload -> ${upRes.status}: ${await upRes.text()}`);
    return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !HF_KEY_ID || !HF_KEY_SECRET) {
        return res.status(500).json({ error: 'Variables d\'environnement manquantes.' });
    }

    const authHeader = req.headers.authorization || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '');

    try {
        const isAdmin = await verifyAdmin(accessToken);
        if (!isAdmin) return res.status(403).json({ error: 'Accès refusé' });

        const { id } = req.body || {};
        if (!id) return res.status(400).json({ error: 'id requis' });

        const rows = await sbFetch(`pending_posts?id=eq.${id}&select=*`);
        const row = rows && rows[0];
        if (!row) return res.status(404).json({ error: 'Génération introuvable' });

        const statusUrls = Array.isArray(row.hf_status_urls) ? row.hf_status_urls : [];
        const images = Array.isArray(row.carousel_images) ? row.carousel_images.slice() : [];
        while (images.length < statusUrls.length) images.push(null);

        let changed = false;
        let failure = null;

        for (let i = 0; i < statusUrls.length; i++) {
            if (images[i]) continue;
            const statusRes = await fetch(statusUrls[i], { headers: { Authorization: `Key ${HF_KEY_ID}:${HF_KEY_SECRET}` } });
            if (!statusRes.ok) continue; // hoquet réseau : on retentera au prochain tick
            const data = await statusRes.json();

            if (data.status === 'completed') {
                const url = data.images && data.images[0] && data.images[0].url;
                if (!url) { failure = `Slide ${i + 1} : terminée mais sans image.`; break; }
                // On n'inscrit la slide qu'une fois réellement recopiée : si
                // l'upload échoue, elle reste nulle et sera retentée.
                images[i] = await storeSlide(id, i, url);
                changed = true;
            } else if (data.status === 'failed' || data.status === 'canceled' || data.status === 'nsfw') {
                failure = `Slide ${i + 1} : ${data.status}${data.error ? ' — ' + data.error : ''}`;
                break;
            }
        }

        const ready = statusUrls.length > 0 && images.length === statusUrls.length && images.every(Boolean);
        const patch = {};
        if (changed) patch.carousel_images = images;
        if (failure) { patch.status = 'failed'; patch.error = failure; }
        else if (ready && row.status === 'generating') patch.status = 'pending';
        if (Object.keys(patch).length) await sbFetch(`pending_posts?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

        res.status(200).json({
            status: patch.status || row.status,
            carousel_images: images,
            total: statusUrls.length,
            done: images.filter(Boolean).length,
            ready: ready && !failure,
            error: failure
        });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
