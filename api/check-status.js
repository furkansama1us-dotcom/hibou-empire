// Vérifie (un seul appel, pas de boucle) où en est UNE génération Higgsfield
// (une slide du carrousel). Appelé en polling par le client, en parallèle
// pour chaque slide -- le client compose lui-même le texte par-dessus une
// fois l'image prête, puis upload via /api/image-bridge.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HF_KEY_ID = process.env.HF_KEY_ID;
const HF_KEY_SECRET = process.env.HF_KEY_SECRET;

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

        const { statusUrl, rowId } = req.body || {};
        if (!statusUrl) return res.status(400).json({ error: 'statusUrl requis' });

        const statusRes = await fetch(statusUrl, { headers: { Authorization: `Key ${HF_KEY_ID}:${HF_KEY_SECRET}` } });
        if (!statusRes.ok) throw new Error(`Higgsfield status -> ${statusRes.status}: ${await statusRes.text()}`);
        const statusData = await statusRes.json();

        if (statusData.status === 'completed' || statusData.status === 'succeeded') {
            const url = statusData.images?.[0]?.url || statusData.result?.url || statusData.output?.[0]?.url || statusData.url;
            if (!url) throw new Error('Higgsfield: génération terminée mais URL introuvable.');
            return res.status(200).json({ done: true, imageUrl: url });
        }

        if (statusData.status === 'failed' || statusData.status === 'error') {
            const errMsg = 'Higgsfield: génération échouée: ' + JSON.stringify(statusData).slice(0, 300);
            if (rowId) {
                await sbFetch(`pending_posts?id=eq.${rowId}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed', error: errMsg }) }).catch(() => {});
            }
            return res.status(200).json({ done: true, failed: true, error: errMsg });
        }

        res.status(200).json({ done: false });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
