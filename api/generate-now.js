// Génération INSTANTANÉE d'un carrousel Nova, déclenchée depuis l'appli.
//
// Contrairement à api/ingest.js (routine Claude Code horaire, qui utilise le
// Reference Element Higgsfield via MCP), cet endpoint passe par l'API REST
// publique de Higgsfield : POST /nano-banana accepte jusqu'à 8 images de
// référence (`input_images`), ce qui suffit à garder Nova identique d'une
// slide à l'autre sans session Claude Code. L'admin voit donc l'aperçu tout
// de suite, et ne choisit l'heure/les plateformes qu'ensuite, à l'approbation.
//
// POST /api/generate-now { format, custom_theme? } -> { id }
// La ligne pending_posts est créée en status "generating" ; le client suit
// l'avancement via /api/generation-progress.

const calendar = require('../data/nova-calendar.json');
const formats = require('../data/nova-formats.json');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HF_KEY_ID = process.env.HF_KEY_ID;
const HF_KEY_SECRET = process.env.HF_KEY_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://hibou-empire.vercel.app';
// Vues de référence de la mascotte, servies en statique par Vercel depuis le
// repo. Passées telles quelles à Higgsfield à chaque slide : c'est ce qui
// garantit que Nova reste la même d'une image à l'autre.
const NOVA_REFERENCE_IMAGES = (process.env.NOVA_REFERENCE_IMAGES
    ? process.env.NOVA_REFERENCE_IMAGES.split(',').map(s => s.trim()).filter(Boolean)
    : ['1', '2', '3', '4', '5', '6', '7', '8'].map(n => `${APP_BASE_URL}/nova-ref/nova-${n}.png`));

const SLIDES_PER_POST = 8;

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

// Les prompts du calendrier commencent par le placeholder du Reference Element
// (<<<uuid>>>), compris uniquement par le MCP Higgsfield. En REST on le retire :
// la cohérence vient des input_images.
function stripElementPlaceholder(prompt) {
    return String(prompt || '').replace(/<<<[^>]*>>>/g, '').trim();
}

async function submitSlide(prompt) {
    const res = await fetch('https://api.higgsfield.ai/nano-banana', {
        method: 'POST',
        headers: { Authorization: `Key ${HF_KEY_ID}:${HF_KEY_SECRET}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            prompt: stripElementPlaceholder(prompt),
            num_images: 1,
            aspect_ratio: '1:1',
            output_format: 'jpeg',
            input_images: NOVA_REFERENCE_IMAGES.map(url => ({ type: 'image_url', image_url: url }))
        })
    });
    if (!res.ok) throw new Error(`Higgsfield submit -> ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const statusUrl = data.status_url || (data.request_id ? `https://api.higgsfield.ai/requests/${data.request_id}/status` : null);
    if (!statusUrl) throw new Error('Higgsfield: ni status_url ni request_id dans la réponse: ' + JSON.stringify(data).slice(0, 300));
    return statusUrl;
}

// Thème déjà écrit : on reprend la prochaine entrée non générée de ce format.
async function pickCalendarItem(format) {
    const ofFormat = calendar.items.filter(it => it.format === format);
    if (!ofFormat.length) throw new Error(`Format "${format}" absent du calendrier.`);

    const rows = await sbFetch('pending_posts?select=overlay_data&status=neq.rejected');
    const used = new Set();
    (rows || []).forEach(r => {
        const idx = r.overlay_data && r.overlay_data.index;
        if (idx) used.add(idx);
    });

    return ofFormat.find(it => !used.has(it.index)) || ofFormat[0];
}

// Thème personnalisé : Claude écrit 8 slides originales en respectant la
// mécanique narrative du format et la règle éditoriale du compte.
async function draftCustom(format, customTheme) {
    if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY manquante — impossible d\'écrire un thème personnalisé.');
    const f = formats.content_formats[format];
    if (!f) throw new Error(`Format "${format}" inconnu.`);
    const c = formats.character;

    const instructions = [
        `Tu écris un carrousel Instagram/TikTok de ${SLIDES_PER_POST} slides pour un compte francophone dont la mascotte est "${c.name}".`,
        ``,
        `MASCOTTE (à décrire dans chaque prompt image, en anglais) :`,
        `- tête : ${c.design_summary.head}`,
        `- yeux : ${c.design_summary.eyes}`,
        `- corps : ${c.design_summary.body}`,
        `- rendu : ${c.design_summary.style_de_rendu}`,
        ``,
        `FORMAT ${format} — ${f.nom} (pilier : ${f.pilier})`,
        `Mécanique narrative à respecter scrupuleusement : ${f.mecanique}`,
        f.ton ? `Ton : ${f.ton}` : '',
        f.objectif ? `Objectif : ${f.objectif}` : '',
        ``,
        `RÈGLE ÉDITORIALE : ${formats.ton_editorial}`,
        ``,
        `THÈME IMPOSÉ : ${customTheme}`,
        ``,
        `Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, de la forme :`,
        `{"titre_interne":"...","caption":"...","slides":[{"prompt":"...","overlay_text":"..."}]}`,
        `- "slides" contient exactement ${SLIDES_PER_POST} entrées, dans l'ordre narratif.`,
        `- "prompt" est en anglais, décrit Nova dans une scène cohérente avec la slide, et intègre explicitement le texte d'overlay à afficher en gros dans l'image (grand texte blanc ou jaune en bas, lisible en miniature).`,
        `- "overlay_text" est le texte français court affiché sur la slide.`,
        `- "caption" est la légende complète du post : accroche, corps, appel à l'action, puis quelques hashtags pertinents.`
    ].filter(Boolean).join('\n');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'claude-sonnet-5',
            max_tokens: 8000,
            messages: [{ role: 'user', content: instructions }]
        })
    });
    if (!res.ok) throw new Error(`Anthropic API -> ${res.status}: ${await res.text()}`);
    const data = await res.json();
    // Le modèle peut renvoyer un bloc "thinking" avant le texte : on prend le
    // premier bloc de type "text", jamais l'index 0 en aveugle.
    const block = (data.content || []).find(b => b.type === 'text');
    if (!block) throw new Error('Réponse Claude sans bloc texte.');
    const match = block.text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Réponse Claude non-JSON: ' + block.text.slice(0, 300));
    const draft = JSON.parse(match[0]);
    if (!Array.isArray(draft.slides) || draft.slides.length !== SLIDES_PER_POST) {
        throw new Error(`Claude a renvoyé ${draft.slides ? draft.slides.length : 0} slides au lieu de ${SLIDES_PER_POST}.`);
    }
    return draft;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !HF_KEY_ID || !HF_KEY_SECRET) {
        return res.status(500).json({ error: 'Variables d\'environnement manquantes (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, HF_KEY_ID, HF_KEY_SECRET).' });
    }

    const authHeader = req.headers.authorization || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '');

    try {
        const isAdmin = await verifyAdmin(accessToken);
        if (!isAdmin) return res.status(403).json({ error: 'Accès refusé' });

        const { format, custom_theme } = req.body || {};
        if (!format) return res.status(400).json({ error: 'format requis' });

        const theme = (custom_theme || '').trim();
        let slides, caption, titreInterne, sourceIndex = null;

        if (theme) {
            const draft = await draftCustom(format, theme);
            slides = draft.slides;
            caption = draft.caption;
            titreInterne = draft.titre_interne || `Format ${format} — ${theme.slice(0, 40)}`;
        } else {
            const item = await pickCalendarItem(format);
            slides = item.slides;
            caption = item.caption;
            titreInterne = item.titre_interne;
            sourceIndex = item.index;
        }

        const statusUrls = [];
        for (const slide of slides) statusUrls.push(await submitSlide(slide.prompt));

        const rows = await sbFetch('pending_posts', {
            method: 'POST', headers: { Prefer: 'return=representation' },
            body: JSON.stringify([{
                scheduled_for: null, scheduled_time: null,
                caption, status: 'generating', is_manual: true,
                carousel_images: slides.map(() => null),
                hf_status_urls: statusUrls,
                overlay_data: {
                    format, titre_interne: titreInterne, custom_theme: theme || null,
                    source_index: sourceIndex,
                    slides: slides.map(s => ({ overlay_text: s.overlay_text }))
                }
            }])
        });

        res.status(200).json({ id: rows && rows[0] && rows[0].id, slides: slides.length });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
