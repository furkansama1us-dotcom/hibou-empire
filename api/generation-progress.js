// Suivi d'une demande de génération manuelle (voir api/generate-now.js).
// La routine dépose le carrousel terminé en une fois via api/ingest.js, donc
// il n'y a pas d'avancement slide par slide : la demande est "pending" tant
// que la routine travaille, puis "done" avec le post rattaché.
//
// POST /api/generation-progress { request_id } -> { status, ready, post }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({ error: 'Variables d\'environnement manquantes.' });
    }

    const authHeader = req.headers.authorization || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '');

    try {
        const isAdmin = await verifyAdmin(accessToken);
        if (!isAdmin) return res.status(403).json({ error: 'Accès refusé' });

        const { request_id } = req.body || {};
        if (!request_id) return res.status(400).json({ error: 'request_id requis' });

        const rows = await sbFetch(`nova_manual_requests?id=eq.${request_id}&select=*`);
        const request = rows && rows[0];
        if (!request) return res.status(404).json({ error: 'Demande introuvable' });

        let post = null;
        if (request.pending_post_id) {
            const posts = await sbFetch(`pending_posts?id=eq.${request.pending_post_id}&select=*`);
            post = posts && posts[0];
        }

        res.status(200).json({
            status: request.status,
            ready: request.status === 'done' && !!post,
            error: request.status === 'failed' ? (request.error || 'Génération échouée') : null,
            post
        });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
