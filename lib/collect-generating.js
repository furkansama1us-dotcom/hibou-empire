// Récupération des images des générations en cours.
//
// Le suivi vivait uniquement dans le navigateur : fermer la page, ou lancer
// plusieurs générations à la suite, laissait des carrousels bloqués en
// "generating" alors que Higgsfield les avait terminés. La collecte est donc
// faite ici, et appelée aussi bien par l'appli (pour un post precis) que par
// les routines a chaque passage (pour tous ceux qui trainent).

const { callTools, parseJobs, resultText } = require('./hf-mcp');

const SUPABASE_URL = process.env.SUPABASE_URL;
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

async function collectOne(row) {
    const jobIds = Array.isArray(row.hf_status_urls) ? row.hf_status_urls : [];
    if (!jobIds.length) return { id: row.id, skipped: 'aucun travail de génération' };

    const images = Array.isArray(row.raw_images) ? row.raw_images.slice() : [];
    while (images.length < jobIds.length) images.push(null);

    const jobsArg = jobIds.map((job_id, index) => ({ index, job_id }));
    let [result] = await callTools([{ name: 'jobs_wait', arguments: { jobs: jobsArg, timeout_seconds: 5 } }]);
    let jobs = parseJobs(result);
    if (!jobs.length) {
        const [shown] = await callTools([{ name: 'show_generation_by_ids', arguments: { jobs: jobsArg } }]);
        const fallback = parseJobs(shown);
        if (fallback.length) jobs = fallback;
    }

    let failure = null, changed = false;
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
    if (Object.keys(patch).length) await sbFetch(`pending_posts?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify(patch) });

    return {
        id: row.id, done: images.filter(Boolean).length, total: jobIds.length,
        ready: ready && !failure, error: failure,
        statuses: jobs.map(j => j.status).join(','),
        // Rien de lu : on remonte la réponse telle quelle, seul moyen de voir
        // ce que Higgsfield a répondu.
        debug: jobs.length ? undefined : resultText(result).slice(0, 500)
    };
}

// Sans id, on ramasse toutes les generations en cours.
async function collectGenerating(id) {
    const filter = id ? `id=eq.${id}` : 'status=eq.generating';
    const rows = await sbFetch(`pending_posts?${filter}&select=*`);
    const results = [];
    for (const row of rows || []) {
        try { results.push(await collectOne(row)); }
        catch (e) { results.push({ id: row.id, error: String(e && e.message ? e.message : e) }); }
    }
    return results;
}

module.exports = { collectGenerating };
