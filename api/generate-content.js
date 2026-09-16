// Génère un carrousel complet (texte + prompts image) via Claude, puis
// soumet chaque slide à Higgsfield (fond SANS TEXTE, le texte est habillé
// à part en vraie typographie côté client, comme pour Score Master) et
// dépose un brouillon "generating" dans pending_posts pour validation admin.
//
// POST /api/generate-content
// Auth : Authorization: Bearer <access_token admin>
// Body : { dateStr? } (jour ciblé, "demain" par défaut)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HF_KEY_ID = process.env.HF_KEY_ID;
const HF_KEY_SECRET = process.env.HF_KEY_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// 3 créneaux/jour minimum (heure de Paris), assignés à tour de rôle selon
// combien de posts existent déjà ce jour-là -- publish.js ne publie une
// ligne "approved" qu'une fois son heure atteinte.
const DAILY_TIMES = ['10:00', '15:00', '20:00'];

const MASCOT_DESC = 'a stylized minimalist golden owl mascot character with big round black eyes, simple geometric feathers, no visible text or logo on its body, cute but sharp/confident expression';

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

async function nextScheduledTime(dateStr) {
    const rows = await sbFetch(`pending_posts?scheduled_for=eq.${dateStr}&select=id`).catch(() => []);
    return DAILY_TIMES[(rows || []).length % DAILY_TIMES.length];
}

async function draftCarouselWithClaude(recentHooks) {
    const prompt = `Tu écris pour "Hibou Empire", une page Instagram/TikTok sur la monétisation en ligne et le mindset business (niche : construire des revenus/pages anonymes sur les réseaux sociaux, discipline, argent, liberté financière). Mascotte récurrente : un hibou doré stylisé, sage et malin.

Format à produire : un carrousel de 6 slides qui raconte une progression ou une révélation courte et percutante (style "petit boulot payé à l'heure VS revenu en ligne qui grandit", ou toute autre accroche forte de cette niche), TRÈS proche du format qui fonctionne sur les comptes _mind_vision_ et empire.abondance (phrases courtes, gros mots-clés, contraste, chute qui donne envie de suivre).

Ne répète pas ces accroches déjà utilisées récemment :
${recentHooks.length ? recentHooks.map(h => `- ${h}`).join('\n') : '(aucun historique)'}

Réponds UNIQUEMENT avec un objet JSON strict, sans texte autour, au format :
{
  "caption": "légende Instagram/TikTok en français avec emojis, quelques hashtags pertinents (business, mindset, argent), prête à poster",
  "slides": [
    { "text": "texte court affiché sur la slide 1 (accroche/question)", "scene": "prompt image en anglais décrivant la scène, incluant TOUJOURS le hibou doré mascotte comme personnage principal, sans aucun texte/logo dans l'image" },
    ... (6 slides au total)
  ]
}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'claude-sonnet-5',
            max_tokens: 2048,
            messages: [{ role: 'user', content: prompt }]
        })
    });
    if (!res.ok) throw new Error(`Anthropic API -> ${res.status}: ${await res.text()}`);
    const data = await res.json();
    // Le premier bloc de `content` peut être un bloc de réflexion (thinking),
    // pas forcément du texte -- on cherche le premier bloc réellement textuel.
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) throw new Error('Réponse Claude sans bloc texte: ' + JSON.stringify(data).slice(0, 300));
    const text = textBlock.text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Réponse Claude non-JSON: ' + text.slice(0, 300));
    return JSON.parse(jsonMatch[0]);
}

function buildSlidePrompt(scene) {
    return `A stylized, hand-drawn illustrated scene, dark bold ink outlines, high-contrast ink wash, premium comic book / graphic novel art style. NOT photorealistic, NOT 3D render, NOT a photo.

ABSOLUTE RULE: NO text, NO numbers, NO letters, NO typography, NO lettering, NO writing, NO signage, NO labels, NO watermark, NO logo, NO illegible or gibberish scribbles that could be mistaken for text — anywhere in the image, on any surface, under any circumstance.

Scene: ${scene}. Character: ${MASCOT_DESC}. Deep navy/black background with warm gold accent lighting, premium aesthetic.

Style: cinematic, moody, generous empty negative space in the bottom third of the frame for a text overlay to be added afterward — this area must stay visually calm and uncluttered.`;
}

async function submitHiggsfield(prompt) {
    const res = await fetch('https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard', {
        method: 'POST',
        headers: { Authorization: `Key ${HF_KEY_ID}:${HF_KEY_SECRET}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, aspect_ratio: '3:4' })
    });
    if (!res.ok) throw new Error(`Higgsfield submit -> ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (!data.status_url) throw new Error('Higgsfield: pas de status_url dans la réponse: ' + JSON.stringify(data));
    return data.status_url;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !HF_KEY_ID || !HF_KEY_SECRET || !ANTHROPIC_API_KEY) {
        return res.status(500).json({ error: 'Variables d\'environnement manquantes (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, HF_KEY_ID, HF_KEY_SECRET, ANTHROPIC_API_KEY).' });
    }

    const authHeader = req.headers.authorization || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '');

    try {
        const isAdmin = await verifyAdmin(accessToken);
        if (!isAdmin) return res.status(403).json({ error: 'Accès refusé' });

        const today = new Date().toISOString().slice(0, 10);
        const dateStr = (req.body && req.body.dateStr) || today;

        const recentRows = await sbFetch(`pending_posts?select=overlay_data&order=created_at.desc&limit=12`).catch(() => []);
        const recentHooks = (recentRows || []).map(r => r.overlay_data && r.overlay_data.slides && r.overlay_data.slides[0] && r.overlay_data.slides[0].text).filter(Boolean);

        const draft = await draftCarouselWithClaude(recentHooks);
        if (!draft.slides || !draft.slides.length) throw new Error('Claude n\'a renvoyé aucune slide.');

        const statusUrls = await Promise.all(draft.slides.map(s => submitHiggsfield(buildSlidePrompt(s.scene))));
        const scheduledTime = await nextScheduledTime(dateStr);

        const rows = await sbFetch('pending_posts', {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify([{
                scheduled_for: dateStr,
                scheduled_time: scheduledTime,
                caption: draft.caption,
                status: 'generating',
                hf_status_urls: statusUrls,
                overlay_data: { slides: draft.slides }
            }])
        });

        res.status(200).json({ id: rows[0].id, statusUrls, slides: draft.slides });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
