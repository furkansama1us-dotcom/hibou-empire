// Génération manuelle déclenchée à la demande depuis l'appli.
//
// Les modèles image qui rendent Nova correctement (gpt_image_2 + le Reference
// Element) ne sont accessibles que depuis une session Claude Code via MCP :
// l'API REST publique n'expose que Soul, qui ne respecte la référence que de
// très loin. On ne génère donc pas ici — on dépose la demande et on réveille
// immédiatement la routine par un repository_dispatch GitHub, auquel un
// déclencheur d'événement est abonné. La routine part dans les secondes qui
// suivent au lieu d'attendre son créneau horaire.
//
// POST /api/generate-now { format, custom_theme? } -> { request_id }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'furkansama1us-dotcom/hibou-empire';

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

async function wakeRoutine() {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/dispatches`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ event_type: 'nova-generate' })
    });
    if (!res.ok) throw new Error(`GitHub dispatch -> ${res.status}: ${await res.text()}`);
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

        const { format, custom_theme } = req.body || {};
        if (!format) return res.status(400).json({ error: 'format requis' });

        const rows = await sbFetch('nova_manual_requests', {
            method: 'POST', headers: { Prefer: 'return=representation' },
            body: JSON.stringify([{ format, custom_theme: (custom_theme || '').trim() || null, status: 'pending' }])
        });
        const requestId = rows && rows[0] && rows[0].id;

        // La demande est enregistrée : si le réveil échoue, la routine la
        // ramassera à son passage horaire plutôt que de la perdre.
        let woken = true, wakeError = null;
        if (!GITHUB_TOKEN) { woken = false; wakeError = 'GITHUB_TOKEN absent'; }
        else {
            try { await wakeRoutine(); } catch (e) { woken = false; wakeError = String(e); }
        }

        res.status(200).json({ request_id: requestId, woken, wake_error: wakeError });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
