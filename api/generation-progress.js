// Suivi d'une génération lancée par /api/generate-now.
//
// Délègue à lib/collect-generating.js, partagé avec les routines : la collecte
// ne dépend donc plus du navigateur. Sans `id`, ramasse toutes les générations
// en cours — c'est ce qui permet à l'onglet Valider de réparer tout seul un
// carrousel laissé en plan par un onglet fermé.
//
// POST /api/generation-progress { id? } -> { status, done, total, ready, error }

const { collectGenerating } = require('../lib/collect-generating');

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

    try {
        const isAdmin = await verifyAdmin((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
        if (!isAdmin) return res.status(403).json({ error: 'Accès refusé' });

        const { id } = req.body || {};
        const results = await collectGenerating(id);

        if (!id) return res.status(200).json({ collected: results.length });

        const r = results[0];
        if (!r) return res.status(404).json({ error: 'Génération introuvable' });
        res.status(200).json({ done: r.done || 0, total: r.total || 0, ready: !!r.ready, error: r.error || null });
    } catch (error) {
        res.status(500).json({ error: String(error && error.message ? error.message : error) });
    }
};
