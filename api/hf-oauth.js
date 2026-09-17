// Autorisation Higgsfield pour l'application elle-meme.
//
// Les modeles qui rendent Nova correctement (gpt_image_2 + Reference Element)
// ne sont exposes que par le serveur MCP de Higgsfield, protege par OAuth
// utilisateur -- d'ou le detour par une routine Claude Code, et l'attente
// jusqu'au prochain creneau. Ce serveur accepte toutefois le scope
// offline_access : une autorisation unique de l'admin suffit a obtenir un
// jeton de rafraichissement, que l'application reutilise ensuite sans fin.
// Elle peut alors generer elle-meme, immediatement.
//
// POST /api/hf-oauth { action: "start" }  (admin) -> { url } a ouvrir
// GET  /api/hf-oauth?code=...&state=...          -> echange et stockage
// POST /api/hf-oauth { action: "status" } (admin) -> { connected }

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://hibou-empire.vercel.app';
const REDIRECT_URI = `${APP_BASE_URL}/api/hf-oauth`;
const CLIENT_ID = process.env.HF_OAUTH_CLIENT_ID || 'BD2qx2uxD9iyDNEB';
const AUTHORIZE_URL = 'https://mcp.higgsfield.ai/oauth2/authorize';
const TOKEN_URL = 'https://mcp.higgsfield.ai/oauth2/token';
const SCOPE = 'openid email offline_access';

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

async function putSecret(key, value) {
    await sbFetch('nova_secrets', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ key, value, updated_at: new Date().toISOString() }])
    });
}

async function getSecret(key) {
    const rows = await sbFetch(`nova_secrets?key=eq.${encodeURIComponent(key)}&select=value`);
    return rows && rows[0] ? rows[0].value : null;
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

function base64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function page(title, body) {
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<body style="margin:0;background:#0b0e14;color:#f2f2f2;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;">
<div style="max-width:420px;text-align:center;">${body}</div></body>`;
}

async function handleCallback(req, res) {
    const { code, state, error, error_description } = req.query || {};
    if (error) {
        return res.status(400).send(page('Autorisation refusée',
            `<h1 style="font-size:20px;">Autorisation refusée</h1><p style="color:#8b93a7;font-size:14px;">${error}${error_description ? ' — ' + error_description : ''}</p>`));
    }
    if (!code || !state) return res.status(400).send(page('Requête invalide', '<h1 style="font-size:20px;">Requête invalide</h1>'));

    const verifier = await getSecret('hf_pkce_' + state);
    if (!verifier) {
        return res.status(400).send(page('Lien expiré',
            '<h1 style="font-size:20px;">Lien expiré</h1><p style="color:#8b93a7;font-size:14px;">Relance la connexion depuis les Réglages de l\'application.</p>'));
    }

    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier
    });
    const tokenRes = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });
    const raw = await tokenRes.text();
    if (!tokenRes.ok) {
        return res.status(502).send(page('Échec de l\'échange',
            `<h1 style="font-size:20px;">Échec de l'échange</h1><pre style="color:#8b93a7;font-size:11px;white-space:pre-wrap;text-align:left;">${raw.slice(0, 500)}</pre>`));
    }
    const tokens = JSON.parse(raw);
    if (!tokens.refresh_token) {
        return res.status(502).send(page('Pas de jeton durable',
            '<h1 style="font-size:20px;">Pas de jeton durable</h1><p style="color:#8b93a7;font-size:14px;">Higgsfield n\'a pas délivré de jeton de rafraîchissement : l\'accès permanent est impossible par cette voie.</p>'));
    }

    await putSecret('hf_refresh_token', tokens.refresh_token);
    await sbFetch(`nova_secrets?key=eq.${encodeURIComponent('hf_pkce_' + state)}`, { method: 'DELETE' });

    res.status(200).send(page('Higgsfield connecté',
        '<h1 style="font-size:20px;">✅ Higgsfield connecté</h1><p style="color:#8b93a7;font-size:14px;">L\'application peut désormais générer elle-même. Tu peux fermer cet onglet et revenir à Nova.</p>'));
}

module.exports = async function handler(req, res) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({ error: 'Variables d\'environnement manquantes.' });
    }

    try {
        // Le retour d'autorisation arrive dans le navigateur, sans en-tete :
        // c'est le `state` conserve cote serveur qui l'authentifie.
        if (req.method === 'GET') return await handleCallback(req, res);

        if (req.method === 'POST') {
            const authHeader = req.headers.authorization || '';
            const isAdmin = await verifyAdmin(authHeader.replace(/^Bearer\s+/i, ''));
            if (!isAdmin) return res.status(403).json({ error: 'Accès refusé' });

            const action = (req.body && req.body.action) || 'status';

            if (action === 'status') {
                return res.status(200).json({ connected: !!(await getSecret('hf_refresh_token')) });
            }

            // Verifie que le jeton stocke ouvre bien une session MCP et que
            // l'outil de generation y est accessible.
            if (action === 'test') {
                const tools = await require('../lib/hf-mcp').listTools();
                return res.status(200).json({
                    tools_count: tools.length,
                    has_generate: tools.indexOf('generate_image_batch') !== -1,
                    sample: tools.slice(0, 12)
                });
            }

            if (action === 'start') {
                const verifier = base64url(crypto.randomBytes(48));
                const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
                const state = base64url(crypto.randomBytes(16));
                await putSecret('hf_pkce_' + state, verifier);

                const url = AUTHORIZE_URL + '?' + new URLSearchParams({
                    response_type: 'code',
                    client_id: CLIENT_ID,
                    redirect_uri: REDIRECT_URI,
                    scope: SCOPE,
                    state,
                    code_challenge: challenge,
                    code_challenge_method: 'S256'
                }).toString();
                return res.status(200).json({ url });
            }

            return res.status(400).json({ error: 'action invalide' });
        }

        return res.status(405).json({ error: 'Méthode non autorisée' });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
