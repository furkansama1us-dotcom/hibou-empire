// Point d'entrée interne pour la routine Claude Code planifiée "Nova"
// (toutes les heures -- seul contexte avec accès au MCP Higgsfield et au
// Reference Element de la mascotte, voir data/nova-calendar.json et
// data/nova-formats.json dans ce même repo).
//
// GET  /api/ingest  (header x-internal-secret) -> la liste de travail :
//   { due_scheduled: [{index, scheduled_for}], manual_requests: [...] }
//   -- plafonnée pour rester raisonnable sur un seul passage de routine.
// POST /api/ingest  (header x-internal-secret) -> pousse UN carrousel déjà
//   entièrement généré (images finies), soit pour une publication planifiée
//   (kind:"scheduled"), soit pour une demande manuelle (kind:"manual" ou
//   "manual_failed" en cas d'échec).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INTERNAL_INGEST_SECRET = process.env.INTERNAL_INGEST_SECRET;

const TOTAL_ITEMS = 150;
const MAX_DUE_SCHEDULED_PER_CALL = 3; // borne un passage horaire de routine
const MAX_MANUAL_PER_CALL = 2;
const LOOKAHEAD_DAYS = 2; // génère au plus tôt 2 jours avant la date prévue

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

function parisTodayStr() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const get = (t) => parts.find(p => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
}

function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

async function getProgress() {
    const rows = await sbFetch('nova_progress?id=eq.1&select=next_index,start_date');
    if (rows && rows[0]) return rows[0];
    const start_date = addDays(parisTodayStr(), 1);
    await sbFetch('nova_progress', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ id: 1, next_index: 1, start_date }]) });
    return { next_index: 1, start_date };
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
            const progress = await getProgress();
            const today = parisTodayStr();
            const dueScheduled = [];
            if (progress.next_index <= TOTAL_ITEMS) {
                // On ne connaît le "jour" (1-50) exact de chaque index qu'en lisant
                // data/nova-calendar.json (côté routine) -- ici on ne fait que
                // proposer les prochains index en séquence, plafonnés, avec leur
                // date cible calculée depuis start_date. La routine confirmera le
                // format/jour réel en lisant le fichier, et peut s'arrêter plus tôt
                // si la date dépasse encore le lookahead.
                for (let i = 0; i < MAX_DUE_SCHEDULED_PER_CALL && progress.next_index + i <= TOTAL_ITEMS; i++) {
                    const index = progress.next_index + i;
                    // jour = ceil(index/3), les 3 items d'un jour partagent la même date
                    const jour = Math.ceil(index / 3);
                    const scheduled_for = addDays(progress.start_date, jour - 1);
                    if (scheduled_for > addDays(today, LOOKAHEAD_DAYS)) break;
                    dueScheduled.push({ index, jour, scheduled_for });
                }
            }

            const manualRows = await sbFetch(`nova_manual_requests?status=eq.pending&select=*&order=created_at.asc&limit=${MAX_MANUAL_PER_CALL}`);

            return res.status(200).json({
                total_items: TOTAL_ITEMS,
                next_index: progress.next_index,
                completed: progress.next_index > TOTAL_ITEMS,
                due_scheduled: dueScheduled,
                manual_requests: manualRows || []
            });
        }

        if (req.method === 'POST') {
            const body = req.body || {};
            const kind = body.kind;

            if (kind === 'scheduled') {
                const { index, caption, scheduled_for, scheduled_time, carousel_images, publish_instagram, publish_tiktok } = body;
                if (!index || !caption || !scheduled_for || !Array.isArray(carousel_images) || !carousel_images.length || !carousel_images.every(Boolean)) {
                    return res.status(400).json({ error: 'index, caption, scheduled_for et carousel_images (tableau complet) requis' });
                }
                // Les images arrivent nues : elles restent en raw_images et ne
                // deviennent publiables qu'une fois le texte incruste par l'appli.
                await sbFetch('pending_posts', {
                    method: 'POST', headers: { Prefer: 'return=minimal' },
                    body: JSON.stringify([{
                        scheduled_for, scheduled_time: scheduled_time || null, caption, status: 'pending',
                        raw_images: carousel_images, carousel_images: null, is_manual: false,
                        publish_instagram: publish_instagram !== false, publish_tiktok: publish_tiktok !== false,
                        overlay_data: {
                            index, format: body.format, id_contenu: body.id_contenu, titre_interne: body.titre_interne,
                            slides: Array.isArray(body.slides) ? body.slides : null
                        }
                    }])
                });
                const progress = await getProgress();
                if (index >= progress.next_index) {
                    await sbFetch('nova_progress?id=eq.1', { method: 'PATCH', body: JSON.stringify({ next_index: index + 1 }) });
                }
                return res.status(200).json({ ok: true });
            }

            if (kind === 'manual') {
                const { request_id, caption, scheduled_for, scheduled_time, carousel_images, publish_instagram, publish_tiktok } = body;
                if (!request_id || !caption || !Array.isArray(carousel_images) || !carousel_images.length || !carousel_images.every(Boolean)) {
                    return res.status(400).json({ error: 'request_id, caption et carousel_images (tableau complet) requis' });
                }
                // Pas de date ici : l'admin la choisit dans l'appli, devant l'aperçu.
                const rows = await sbFetch('pending_posts', {
                    method: 'POST', headers: { Prefer: 'return=representation' },
                    body: JSON.stringify([{
                        scheduled_for: scheduled_for || null, scheduled_time: scheduled_time || null, caption, status: 'pending',
                        raw_images: carousel_images, carousel_images: null, is_manual: true,
                        publish_instagram: publish_instagram !== false, publish_tiktok: publish_tiktok !== false,
                        overlay_data: {
                            manual_request_id: request_id, format: body.format, titre_interne: body.titre_interne,
                            slides: Array.isArray(body.slides) ? body.slides : null
                        }
                    }])
                });
                const newId = rows && rows[0] && rows[0].id;
                await sbFetch(`nova_manual_requests?id=eq.${request_id}`, {
                    method: 'PATCH', body: JSON.stringify({ status: 'done', pending_post_id: newId })
                });
                return res.status(200).json({ ok: true });
            }

            if (kind === 'manual_failed') {
                const { request_id, error } = body;
                if (!request_id) return res.status(400).json({ error: 'request_id requis' });
                await sbFetch(`nova_manual_requests?id=eq.${request_id}`, {
                    method: 'PATCH', body: JSON.stringify({ status: 'failed', error: String(error || 'échec de génération') })
                });
                return res.status(200).json({ ok: true });
            }

            // Déclenché par les routines à chaque passage : c'est ce qui fait
            // réellement partir les publications approuvées dont l'heure est
            // atteinte. Sans lui, elles restent "approved" indéfiniment.
            if (kind === 'publish_due') {
                const summary = await require('../lib/publish-due').publishDue();
                return res.status(200).json(summary);
            }

            // Ramasse les générations que le navigateur n'a pas suivies jusqu'au
            // bout : sans cela, fermer la page laisse un carrousel bloqué alors
            // que Higgsfield l'a terminé.
            // Diagnostic : quelles URL d'images sont réellement envoyées à
            // Postiz, et sont-elles téléchargeables depuis l'extérieur.
            if (kind === 'debug_images') {
                const rows = await sbFetch('pending_posts?status=in.(approved,published,failed)&select=id,status,carousel_images,raw_images&order=created_at.desc&limit=4');
                const out = [];
                for (const row of rows || []) {
                    const first = (row.carousel_images || [])[0] || null;
                    let reachable = null;
                    if (first) {
                        const head = await fetch(first, { method: 'GET', headers: { Range: 'bytes=0-0' } }).catch(e => ({ status: 'ERR ' + e }));
                        reachable = `${head.status} ${head.headers ? head.headers.get('content-type') : ''}`;
                    }
                    out.push({
                        id: row.id, status: row.status,
                        composed: (row.carousel_images || []).filter(Boolean).length,
                        first_url: first, reachable
                    });
                }
                return res.status(200).json({ posts: out });
            }

            if (kind === 'collect_generating') {
                const results = await require('../lib/collect-generating').collectGenerating();
                return res.status(200).json({ collected: results });
            }

            return res.status(400).json({ error: 'kind invalide (attendu: scheduled, manual, manual_failed, publish_due)' });
        }

        return res.status(405).json({ error: 'Méthode non autorisée' });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
