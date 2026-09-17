// Génération manuelle immédiate, depuis l'application.
//
// L'admin clique, les 8 slides partent aussitôt chez Higgsfield via le serveur
// MCP (voir lib/hf-mcp.js) : plus d'attente du créneau d'une routine. Les
// images reviennent nues, sans texte -- l'application incruste la typo ensuite,
// ce qui garantit une police et une position identiques sur toutes les slides.
//
// POST /api/generate-now { format, custom_theme? } -> { id }
// Le suivi se fait ensuite sur /api/generation-progress.

const calendar = require('../data/nova-calendar.json');
const formats = require('../data/nova-formats.json');
const { callTools, resultJson } = require('../lib/hf-mcp');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SLIDES_PER_POST = 8;
// Réglages économiques : 4:5 est le format réellement publié, donc aucun pixel
// payé ne part au recadrage. La version 9:16 est fabriquée par le navigateur.
const IMAGE_PARAMS = { model: 'gpt_image_2', aspect_ratio: '4:5', resolution: '1k', quality: 'low' };
// Charte commune à toutes les slides : c'est elle, autant que la mascotte, qui
// rend le compte reconnaissable dans un fil.
const STYLE_SUFFIX = ', cinematic warm golden-hour lighting, amber and gold tones, deep navy shadows, rich painted environment with real depth, atmospheric, character small within a wider scene, calm uncluttered lower third, no text, no words, no letters, no numbers, no readable signage, no subtitles, no watermark';

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

// Les prompts du calendrier demandent souvent au modèle d'écrire le texte dans
// l'image. On retire ces segments : le texte est désormais incrusté au canvas.
const TEXT_CLAUSE = /\b(text|texts|lettering|letters|caption|captions|words|wording|subtitle|subtitles|typography|headline|written|reading|says|font)\b/i;

function cleanPrompt(prompt) {
    const kept = String(prompt || '')
        .split(',')
        .filter(segment => !TEXT_CLAUSE.test(segment))
        .map(segment => segment.trim())
        .filter(Boolean);
    return kept.join(', ') + STYLE_SUFFIX;
}

// Thème déjà écrit : on prend la prochaine entrée non utilisée de ce format.
async function pickCalendarItem(format) {
    const ofFormat = calendar.items.filter(it => it.format === format);
    if (!ofFormat.length) throw new Error(`Format "${format}" absent du calendrier.`);

    const rows = await sbFetch('pending_posts?select=overlay_data&status=neq.rejected');
    const used = new Set();
    (rows || []).forEach(r => {
        const od = r.overlay_data || {};
        if (od.index) used.add(od.index);
        if (od.source_index) used.add(od.source_index);
    });

    return ofFormat.find(it => !used.has(it.index)) || ofFormat[0];
}

// Thème personnalisé : Claude écrit 8 slides originales selon la mécanique du format.
async function draftCustom(format, customTheme) {
    if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY manquante — impossible d\'écrire un thème personnalisé.');
    const f = formats.content_formats[format];
    if (!f) throw new Error(`Format "${format}" inconnu.`);
    const c = formats.character;
    const da = formats.direction_artistique || {};

    const instructions = [
        `Tu écris un carrousel Instagram/TikTok de ${SLIDES_PER_POST} slides pour un compte francophone dont la mascotte est "${c.name}".`,
        ``,
        `MASCOTTE (à décrire dans chaque prompt image, en anglais) :`,
        `- tête : ${c.design_summary.head}`,
        `- yeux : ${c.design_summary.eyes}`,
        `- corps : ${c.design_summary.body}`,
        `- rendu : ${c.design_summary.style_de_rendu}`,
        ``,
        `DIRECTION ARTISTIQUE :`,
        `- ${da.composition || 'Des scènes, pas des portraits.'}`,
        `- ${da.lumiere_et_couleur || ''}`,
        `- ${da.cadrage || ''}`,
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
        `Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour :`,
        `{"titre_interne":"...","caption":"...","slides":[{"prompt":"...","overlay_text":"..."}]}`,
        `- "slides" contient exactement ${SLIDES_PER_POST} entrées, dans l'ordre narratif.`,
        `- "prompt" est en anglais et décrit UNIQUEMENT la scène. N'y fais JAMAIS écrire de texte : aucun mot, aucune lettre, aucun panneau lisible. Le texte est ajouté après coup.`,
        `- "overlay_text" est le texte français court affiché sur la slide (2 lignes maximum, séparées par \\n).`,
        `- "caption" est la légende complète : accroche, corps, appel à l'action, puis quelques hashtags.`
    ].filter(Boolean).join('\n');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8000, messages: [{ role: 'user', content: instructions }] })
    });
    if (!res.ok) throw new Error(`Anthropic API -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    // Le modèle peut renvoyer un bloc de réflexion avant le texte : on prend le
    // premier bloc de type "text", jamais l'index 0 en aveugle.
    const block = (data.content || []).find(b => b.type === 'text');
    if (!block) throw new Error('Réponse Claude sans bloc texte.');
    const match = block.text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Réponse Claude non-JSON : ' + block.text.slice(0, 200));
    const draft = JSON.parse(match[0]);
    if (!Array.isArray(draft.slides) || draft.slides.length !== SLIDES_PER_POST) {
        throw new Error(`Claude a renvoyé ${draft.slides ? draft.slides.length : 0} slides au lieu de ${SLIDES_PER_POST}.`);
    }
    return draft;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({ error: 'Variables d\'environnement manquantes (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).' });
    }

    const authHeader = req.headers.authorization || '';

    try {
        const isAdmin = await verifyAdmin(authHeader.replace(/^Bearer\s+/i, ''));
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

        // Un carrousel = 8 images = exactement le plafond de générations
        // simultanées du plan Higgsfield : un seul lot, jamais deux en parallèle.
        const [batch] = await callTools([{
            name: 'generate_image_batch',
            arguments: {
                requests: slides.map((slide, index) => ({
                    index,
                    params: Object.assign({ prompt: cleanPrompt(slide.prompt) }, IMAGE_PARAMS)
                }))
            }
        }]);

        const parsed = resultJson(batch);
        const jobs = (parsed && parsed.jobs) || [];
        const jobIds = slides.map((_, i) => {
            const job = jobs.find(j => j.index === i);
            return job ? job.job_id : null;
        });
        if (!jobIds.every(Boolean)) {
            throw new Error('Higgsfield n\'a accepté que ' + jobIds.filter(Boolean).length + '/' + slides.length + ' slides : ' + JSON.stringify(parsed).slice(0, 300));
        }

        const rows = await sbFetch('pending_posts', {
            method: 'POST', headers: { Prefer: 'return=representation' },
            body: JSON.stringify([{
                scheduled_for: null, scheduled_time: null,
                caption, status: 'generating', is_manual: true,
                raw_images: slides.map(() => null),
                carousel_images: null,
                hf_status_urls: jobIds,
                overlay_data: {
                    format, titre_interne: titreInterne, custom_theme: theme || null, source_index: sourceIndex,
                    slides: slides.map(s => ({ overlay_text: s.overlay_text }))
                }
            }])
        });

        res.status(200).json({ id: rows && rows[0] && rows[0].id, slides: slides.length });
    } catch (error) {
        res.status(500).json({ error: String(error && error.message ? error.message : error) });
    }
};
