// Suivi d'une génération lancée par /api/generate-now.
//
// Interroge Higgsfield sur l'état des 8 travaux et range les images prêtes
// dans raw_images. Quand les 8 sont là, le post passe en "pending" : il attend
// alors l'incrustation du texte puis l'approbation, dans l'application.
//
// POST /api/generation-progress { id } -> { status, done, total, ready, error }

const { callTools, parseJobs, resultText } = require('../lib/hf-mcp');

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

    try {
        const isAdmin = await verifyAdmin(authHeader.replace(/^Bearer\s+/i, ''));
        if (!isAdmin) return res.status(403).json({ error: 'Accès refusé' });

        const { id } = req.body || {};
        if (!id) return res.status(400).json({ error: 'id requis' });

        const rows = await sbFetch(`pending_posts?id=eq.${id}&select=*`);
        const row = rows && rows[0];
        if (!row) return res.status(404).json({ error: 'Génération introuvable' });

        const jobIds = Array.isArray(row.hf_status_urls) ? row.hf_status_urls : [];
        const images = Array.isArray(row.raw_images) ? row.raw_images.slice() : [];
        while (images.length < jobIds.length) images.push(null);

        if (!jobIds.length) return res.status(400).json({ error: 'Aucun travail de génération sur ce post.' });

        // Court délai d'attente : on veut l'état courant pour l'aperçu, pas
        // bloquer la requête jusqu'à la fin des 8 images.
        const jobsArg = jobIds.map((job_id, index) => ({ index, job_id }));
        let [waited] = await callTools([{ name: 'jobs_wait', arguments: { jobs: jobsArg, timeout_seconds: 5 } }]);
        let jobs = parseJobs(waited);

        // jobs_wait peut ne renvoyer qu'un compte rendu global, sans le detail
        // par slide : on retombe alors sur la consultation explicite.
        if (!jobs.length) {
            const [shown] = await callTools([{ name: 'show_generation_by_ids', arguments: { jobs: jobsArg } }]);
            const fallback = parseJobs(shown);
            if (fallback.length) { jobs = fallback; waited = shown; }
        }
        let failure = null;
        let changed = false;

        jobs.forEach(job => {
            const i = job.index;
            if (typeof i !== 'number' || i >= images.length) return;
            if (job.status === 'completed' || job.status === 'succeeded') {
                const url = job.result_url || (job.results && job.results[0] && job.results[0].url);
                if (url && !images[i]) { images[i] = url; changed = true; }
            } else if (job.status === 'failed' || job.status === 'canceled' || job.status === 'nsfw') {
                failure = `Slide ${i + 1} : ${job.status}${job.error ? ' — ' + job.error : ''}`;
            }
        });

        const ready = images.length === jobIds.length && images.every(Boolean);

        const patch = {};
        if (changed) patch.raw_images = images;
        if (failure) { patch.status = 'failed'; patch.error = failure; }
        else if (ready && row.status === 'generating') patch.status = 'pending';
        if (Object.keys(patch).length) await sbFetch(`pending_posts?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

        res.status(200).json({
            status: patch.status || row.status,
            done: images.filter(Boolean).length,
            total: jobIds.length,
            ready: ready && !failure,
            error: failure,
            // Tant qu'aucune slide n'est lue, on renvoie la réponse brute :
            // c'est le seul moyen de voir ce que Higgsfield a réellement dit.
            debug: jobs.length ? undefined : resultText(waited).slice(0, 400)
        });
    } catch (error) {
        res.status(500).json({ error: String(error && error.message ? error.message : error) });
    }
};
