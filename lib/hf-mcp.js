// Client MCP Higgsfield utilisable depuis une fonction serveur.
//
// Le serveur MCP est la seule surface qui expose gpt_image_2 et le Reference
// Element de Nova (l'API REST publique n'ouvre que Soul, qui ne respecte pas
// la reference). Il est protege par OAuth utilisateur, mais accorde le scope
// offline_access : l'admin a autorise une fois, on garde le jeton de
// rafraichissement et on s'en sert indefiniment. Voir api/hf-oauth.js.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MCP_URL = 'https://mcp.higgsfield.ai/mcp';
const TOKEN_URL = 'https://mcp.higgsfield.ai/oauth2/token';
const CLIENT_ID = process.env.HF_OAUTH_CLIENT_ID || 'BD2qx2uxD9iyDNEB';
const PROTOCOL_VERSION = '2025-06-18';

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

async function getSecret(key) {
    const rows = await sbFetch(`nova_secrets?key=eq.${encodeURIComponent(key)}&select=value`);
    return rows && rows[0] ? rows[0].value : null;
}

async function putSecret(key, value) {
    await sbFetch('nova_secrets', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ key, value, updated_at: new Date().toISOString() }])
    });
}

// Le jeton d'acces est mis en cache : une fonction serverless repart de zero a
// chaque appel, sans cache on referait un echange OAuth a chaque slide.
async function getAccessToken() {
    const cached = await getSecret('hf_access_token');
    const expires = await getSecret('hf_access_expires');
    if (cached && expires && Date.now() < parseInt(expires, 10) - 60000) return cached;

    const refresh = await getSecret('hf_refresh_token');
    if (!refresh) throw new Error('Higgsfield non connecté — va dans Réglages et clique « Connecter Higgsfield ».');

    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: CLIENT_ID }).toString()
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`Rafraîchissement du jeton Higgsfield -> ${res.status}: ${raw.slice(0, 300)}`);
    const tokens = JSON.parse(raw);
    if (!tokens.access_token) throw new Error('Higgsfield n\'a pas renvoyé de jeton d\'accès.');

    await putSecret('hf_access_token', tokens.access_token);
    await putSecret('hf_access_expires', String(Date.now() + (tokens.expires_in || 3600) * 1000));
    // Le serveur peut faire tourner le jeton de rafraichissement : le perdre
    // obligerait l'admin a reautoriser, donc on le remplace des qu'il change.
    if (tokens.refresh_token && tokens.refresh_token !== refresh) await putSecret('hf_refresh_token', tokens.refresh_token);

    return tokens.access_token;
}

// Le transport accepte une reponse JSON simple ou un flux d'evenements : on
// accepte les deux et on en extrait le message portant notre identifiant.
function parseRpc(contentType, body, id) {
    if ((contentType || '').indexOf('text/event-stream') !== -1) {
        const messages = body.split('\n')
            .filter(line => line.indexOf('data:') === 0)
            .map(line => { try { return JSON.parse(line.slice(5).trim()); } catch (e) { return null; } })
            .filter(Boolean);
        return messages.find(m => m.id === id) || messages[messages.length - 1];
    }
    return JSON.parse(body);
}

async function rpc(token, sessionId, id, method, params) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    const payload = { jsonrpc: '2.0', method };
    if (id !== null) payload.id = id;
    if (params) payload.params = params;

    const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
    const body = await res.text();
    if (!res.ok) throw new Error(`MCP ${method} -> ${res.status}: ${body.slice(0, 400)}`);
    return { message: id === null ? null : parseRpc(res.headers.get('content-type'), body, id), sessionId: res.headers.get('mcp-session-id') || sessionId };
}

// Ouvre une session, execute les appels demandes, et rend les resultats.
// `calls` : [{ name, arguments }]
async function callTools(calls) {
    const token = await getAccessToken();

    const init = await rpc(token, null, 1, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'nova-admin', version: '1.0.0' }
    });
    if (init.message && init.message.error) throw new Error('MCP initialize: ' + JSON.stringify(init.message.error).slice(0, 300));
    const sessionId = init.sessionId;

    await rpc(token, sessionId, null, 'notifications/initialized').catch(function () {});

    const results = [];
    let nextId = 2;
    for (const call of calls) {
        const out = await rpc(token, sessionId, nextId++, 'tools/call', { name: call.name, arguments: call.arguments || {} });
        const msg = out.message;
        if (msg && msg.error) throw new Error(`MCP ${call.name}: ` + JSON.stringify(msg.error).slice(0, 300));
        results.push(msg && msg.result);
    }
    return results;
}

async function listTools() {
    const token = await getAccessToken();
    const init = await rpc(token, null, 1, 'initialize', {
        protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'nova-admin', version: '1.0.0' }
    });
    if (init.message && init.message.error) throw new Error('MCP initialize: ' + JSON.stringify(init.message.error).slice(0, 300));
    await rpc(token, init.sessionId, null, 'notifications/initialized').catch(function () {});
    const out = await rpc(token, init.sessionId, 2, 'tools/list', {});
    if (out.message && out.message.error) throw new Error('MCP tools/list: ' + JSON.stringify(out.message.error).slice(0, 300));
    return ((out.message && out.message.result && out.message.result.tools) || []).map(t => t.name);
}

// Un resultat d'outil MCP arrive en blocs de contenu.
function resultText(result) {
    const block = result && Array.isArray(result.content) ? result.content.find(c => c.type === 'text') : null;
    return block ? block.text : '';
}

function resultJson(result) {
    const text = resultText(result);
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { return { raw: text }; }
}

// Decoupe une ligne de valeurs separees par des virgules, en respectant les
// guillemets (les URL en contiennent parfois).
function splitRow(line) {
    const out = [];
    let field = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { quoted = !quoted; continue; }
        if (ch === ',' && !quoted) { out.push(field.trim()); field = ''; continue; }
        field += ch;
    }
    out.push(field.trim());
    return out;
}

// Forme tabulaire des outils Higgsfield :
//   jobs[8](index,job_id,status,type,model,result_url):
//     0,1c73bf67-...,completed,image,gpt_image_2,"https://..."
// L'en-tete declare lui-meme ses colonnes, on s'y fie plutot que de deviner.
// L'en-tete encadre ses colonnes d'accolades ou de parentheses selon l'outil :
// on accepte les deux plutot que de parier sur l'une.
const TABLE_HEADER = /\[\d+\]\s*[({]([^)}]*)[)}]\s*:/;

function parseTabular(text) {
    const lines = String(text || '').split('\n');
    const headerIndex = lines.findIndex(l => TABLE_HEADER.test(l));
    if (headerIndex === -1) return null;

    const columns = lines[headerIndex].match(TABLE_HEADER)[1].split(',').map(c => c.trim());
    const rows = [];
    for (let i = headerIndex + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        if (TABLE_HEADER.test(line)) break; // un autre tableau commence
        const values = splitRow(line);
        if (values.length < 2) continue;
        const row = {};
        columns.forEach((col, ci) => { row[col] = values[ci]; });
        rows.push(row);
    }
    return rows;
}

// Les outils Higgsfield ne repondent pas toujours en JSON : generate_image_batch
// et jobs_wait renvoient un compte rendu lisible du genre
//   Submitted 8/8 image generations.
//   - index 0: 31b1c6cd-... (pending)
//   - index 3: ab0821a8-... (completed) https://.../image.png
// On accepte les deux formes et on en tire toujours la meme liste de travaux.
function parseJobs(result) {
    const parsed = resultJson(result);
    if (parsed && Array.isArray(parsed.jobs)) return parsed.jobs;
    if (parsed && Array.isArray(parsed.items)) {
        return parsed.items.map((it, i) => ({
            index: typeof it.index === 'number' ? it.index : i,
            job_id: it.job_id || it.id,
            status: it.status,
            result_url: it.result_url || (it.results && it.results[0] && it.results[0].url)
        }));
    }

    const tabular = parseTabular(resultText(result));
    if (tabular && tabular.length) {
        return tabular.map((row, i) => ({
            index: row.index !== undefined ? parseInt(row.index, 10) : i,
            job_id: row.job_id || row.id,
            status: row.status ? String(row.status).toLowerCase() : undefined,
            result_url: row.result_url || row.url || undefined
        })).filter(j => j.job_id);
    }

    const jobs = [];
    resultText(result).split('\n').forEach(line => {
        const m = line.match(/index\s+(\d+)\s*:\s*([0-9a-fA-F-]{36})/);
        if (!m) return;
        const status = (line.match(/\((pending|queued|in_progress|processing|completed|succeeded|failed|canceled|nsfw)\)/i) || [])[1];
        const url = (line.match(/https?:\/\/\S+/) || [])[0];
        jobs.push({
            index: parseInt(m[1], 10),
            job_id: m[2],
            status: status ? status.toLowerCase() : undefined,
            result_url: url ? url.replace(/[),.]+$/, '') : undefined
        });
    });
    return jobs;
}

module.exports = { callTools, listTools, resultJson, resultText, parseJobs, getAccessToken };
