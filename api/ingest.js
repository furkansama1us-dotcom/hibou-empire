// Point d'entrée interne pour la routine Claude Code planifiée "Nova" (le
// seul contexte qui a accès au Reference Element Higgsfield de la mascotte).
// La routine lit le calendrier/banque de contenu depuis ce repo (git
// checkout), génère les slides via le MCP Higgsfield, puis pousse le
// carrousel fini ici -- jamais de clé Supabase exposée dans le prompt de
// la routine, uniquement ce secret partagé dédié.
//
// GET  /api/ingest  (header x-internal-secret) -> { next_jour } : le prochain
//   jour du calendrier (1-50) à générer, pour que la routine sache où reprendre.
// POST /api/ingest  (header x-internal-secret) -> pousse un carrousel déjà
//   entièrement généré (images finies) dans pending_posts, status 'pending'
//   (prêt à approuver -- pas de polling/composition côté client pour ce flux,
//   contrairement à l'ancien /api/generate-content).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INTERNAL_INGEST_SECRET = process.env.INTERNAL_INGEST_SECRET;

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

async function getNextJour() {
    const rows = await sbFetch('nova_progress?id=eq.1&select=next_jour');
    if (rows && rows[0]) return rows[0].next_jour;
    await sbFetch('nova_progress', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ id: 1, next_jour: 1 }]) });
    return 1;
}

module.exports = async function handler(req, res) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !INTERNAL_INGEST_SECRET) {
        return res.status(500).json({ error: 'Variables d\'environnement manquantes (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, INTERNAL_INGEST_SECRET).' });
    }
    if (req.headers['x-internal-secret'] !== INTERNAL_INGEST_SECRET) {
        return res.status(401).json({ error: 'Secret invalide' });
    }

    try {
        if (req.method === 'GET') {
            const next_jour = await getNextJour();
            return res.status(200).json({ next_jour });
        }

        if (req.method === 'POST') {
            const { jour, id_contenu, titre_interne, format, caption, scheduled_for, scheduled_time, carousel_images } = req.body || {};
            if (!jour || !caption || !scheduled_for || !Array.isArray(carousel_images) || !carousel_images.length || !carousel_images.every(Boolean)) {
                return res.status(400).json({ error: 'jour, caption, scheduled_for et carousel_images (tableau complet) requis' });
            }

            await sbFetch('pending_posts', {
                method: 'POST',
                headers: { Prefer: 'return=minimal' },
                body: JSON.stringify([{
                    scheduled_for,
                    scheduled_time: scheduled_time || null,
                    caption,
                    status: 'pending',
                    carousel_images,
                    overlay_data: { jour, id_contenu, titre_interne, format }
                }])
            });

            // N'avance le curseur qu'après un push réussi -- si la génération
            // échoue en cours de route côté routine, le prochain passage
            // retentera le MÊME jour plutôt que d'en sauter un.
            const currentNext = await getNextJour();
            if (jour >= currentNext) {
                await sbFetch('nova_progress?id=eq.1', {
                    method: 'PATCH',
                    body: JSON.stringify({ next_jour: jour + 1 })
                });
            }

            return res.status(200).json({ ok: true });
        }

        return res.status(405).json({ error: 'Méthode non autorisée' });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
