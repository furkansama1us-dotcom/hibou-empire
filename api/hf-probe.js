// Outil de diagnostic temporaire : la spec OpenAPI publique de Higgsfield ne
// correspond pas toujours aux routes réellement ouvertes sur un compte
// (POST /nano-banana renvoie "model_not_found"). Cet endpoint essaie les
// routes candidates avec un corps minimal et rapporte le code/réponse de
// chacune, pour savoir laquelle utiliser sans déployer à l'aveugle.
//
// POST /api/hf-probe (admin) -> [{ path, status, body }]
// À supprimer une fois la bonne route identifiée.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HF_KEY_ID = process.env.HF_KEY_ID;
const HF_KEY_SECRET = process.env.HF_KEY_SECRET;

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://hibou-empire.vercel.app';
const REF = `${APP_BASE_URL}/nova-ref/nova-1.png`;
const PROMPT = 'A friendly navy blue paper-plane mascot waving, soft studio lighting, white background';

const CANDIDATES = [
    ['/nano-banana', { prompt: PROMPT, num_images: 1, aspect_ratio: '1:1', input_images: [{ type: 'image_url', image_url: REF }] }],
    ['/nano-banana/v1', { prompt: PROMPT, num_images: 1, aspect_ratio: '1:1', input_images: [{ type: 'image_url', image_url: REF }] }],
    ['/google/nano-banana', { prompt: PROMPT, num_images: 1, aspect_ratio: '1:1', input_images: [{ type: 'image_url', image_url: REF }] }],
    ['/nano-banana-2', { prompt: PROMPT, num_images: 1, aspect_ratio: '1:1', input_images: [{ type: 'image_url', image_url: REF }] }],
    ['/nano-banana/pro', { prompt: PROMPT, num_images: 1, aspect_ratio: '1:1', input_images: [{ type: 'image_url', image_url: REF }] }],
    ['/higgsfield-ai/soul/reference', { prompt: PROMPT, aspect_ratio: '1:1', image_reference_url: REF }],
    ['/higgsfield-ai/soul/v2/reference', { prompt: PROMPT, aspect_ratio: '1:1', image_reference_url: REF }],
    ['/flux-pro/kontext/max/text-to-image', { prompt: PROMPT }]
];

async function sbFetch(path, options) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, Object.assign({}, options, {
        headers: Object.assign({
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json'
        }, (options && options.headers) || {})
    }));
    if (!res.ok) throw new Error(`Supabase ${path} -> ${res.status}`);
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
    const authHeader = req.headers.authorization || '';
    const isAdmin = await verifyAdmin(authHeader.replace(/^Bearer\s+/i, ''));
    if (!isAdmin) return res.status(403).json({ error: 'Accès refusé' });

    const results = [];
    for (const [path, body] of CANDIDATES) {
        try {
            const r = await fetch('https://api.higgsfield.ai' + path, {
                method: 'POST',
                headers: { Authorization: `Key ${HF_KEY_ID}:${HF_KEY_SECRET}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            results.push({ path, status: r.status, body: (await r.text()).slice(0, 400) });
        } catch (e) {
            results.push({ path, status: 'ERR', body: String(e).slice(0, 200) });
        }
    }
    // Vérifie aussi que l'image de référence est bien servie publiquement :
    // si Higgsfield ne peut pas la lire, la cohérence de Nova tombe.
    const refRes = await fetch(REF, { method: 'HEAD' }).catch(e => ({ status: 'ERR: ' + e }));
    res.status(200).json({ reference_url: REF, reference_status: refRes.status, results });
};
