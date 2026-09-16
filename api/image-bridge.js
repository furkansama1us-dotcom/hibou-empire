// Proxy d'image (contourne le CORS de Higgsfield pour charger un fond dans
// un <canvas> sans le "tainter") + upload de la slide finale (fond +
// texte réel habillé côté client) dans Supabase Storage.
//
// action:"proxy" { url } -> renvoie l'image distante en base64.
// action:"upload" { id, imageDataUri, slideIndex } -> upload la slide dans
// le bucket public, la range dans pending_posts.carousel_images[slideIndex].

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
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

async function handleProxy(req, res) {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url requise' });

    const imgRes = await fetch(url);
    if (!imgRes.ok) throw new Error(`Téléchargement image -> ${imgRes.status}`);
    const contentType = imgRes.headers.get('content-type') || 'image/png';
    const buf = Buffer.from(await imgRes.arrayBuffer());

    res.status(200).json({ dataUri: `data:${contentType};base64,${buf.toString('base64')}` });
}

async function handleUpload(req, res) {
    const { id, imageDataUri, slideIndex } = req.body || {};
    if (!id || !imageDataUri || !imageDataUri.startsWith('data:image/') || slideIndex == null) {
        return res.status(400).json({ error: 'id, imageDataUri (data:image/...) et slideIndex requis' });
    }

    const match = imageDataUri.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'imageDataUri invalide' });
    const contentType = match[1];
    const ext = contentType.split('/')[1] || 'png';
    const buf = Buffer.from(match[2], 'base64');

    const objectPath = `posts/${id}-slide${slideIndex}.${ext}`;
    const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`, {
        method: 'POST',
        headers: {
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': contentType,
            'x-upsert': 'true'
        },
        body: buf
    });
    if (!uploadRes.ok) throw new Error(`Supabase Storage upload -> ${uploadRes.status}: ${await uploadRes.text()}`);

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;

    const idx = parseInt(slideIndex, 10);
    const rowRes = await sbFetch(`pending_posts?id=eq.${id}&select=carousel_images`);
    const current = (rowRes && rowRes[0] && Array.isArray(rowRes[0].carousel_images)) ? rowRes[0].carousel_images.slice() : [];
    while (current.length <= idx) current.push(null);
    current[idx] = publicUrl;
    await sbFetch(`pending_posts?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ carousel_images: current }) });

    res.status(200).json({ ok: true, imageUrl: publicUrl });
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({ error: 'Variables d\'environnement manquantes (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).' });
    }

    const authHeader = req.headers.authorization || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '');

    try {
        const isAdmin = await verifyAdmin(accessToken);
        if (!isAdmin) return res.status(403).json({ error: 'Accès refusé' });

        const action = (req.body && req.body.action) || 'proxy';
        if (action === 'upload') return await handleUpload(req, res);
        return await handleProxy(req, res);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
