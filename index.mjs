// magpie-x-search: a magpie tools plugin that adds X (Twitter) search (x_search) and single-post reading (x_read)
// for every agent behind magpie.
// The tool is served by magpie itself at /mcp/magpie/tools (and through the MCP router), so any agent that
// can reach magpie's MCP endpoint can search X, whatever model it runs on. Searching is done by Grok's
// server-side `x_search` through the Grok (SuperGrok) provider already signed in to magpie: this plugin only
// calls the local gateway (POST /v1/responses) and never sees or stores credentials.
//
// NOTE: magpie calls every function a plugin module exports as a plugin, so only ONE export lives here.

const DEF = { gateway: `http://${process.env.MAGPIE_ADDR || '127.0.0.1:3425'}`, maxToolCalls: 3, cacheSec: 300, perMinute: 6, perDay: 200, concurrency: 2, budgetMs: 50_000 };

// Per-instance state (limits, cache, model lookup) lives on cfg.st, created in XSearchTools below.
const newState = () => ({
  cache: new Map(), inflight: new Map(), calls: [], day: { key: '', n: 0 },
  active: 0, queue: [], model: { at: 0, id: '' },
});

class UserError extends Error {}

const handles = (v, name) => {
  if (v == null) return undefined;
  if (!Array.isArray(v) || !v.length || v.length > 20) throw new UserError(`${name} must be 1-20 handles`);
  const out = [...new Set(v.map(h => String(h).trim().replace(/^@/, '')))];
  for (const h of out) if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) throw new UserError(`${name}: invalid handle "${h}"`);
  return out;
};

function parse(a) {
  const query = typeof a?.query === 'string' ? a.query.trim() : '';
  if (!query || query.length > 8000) throw new UserError('query must be a non-empty string (max 8000 chars)');
  const allowed = handles(a.allowed_x_handles, 'allowed_x_handles');
  const excluded = handles(a.excluded_x_handles, 'excluded_x_handles');
  if (allowed && excluded) throw new UserError('allowed_x_handles and excluded_x_handles are mutually exclusive');
  for (const k of ['from_date', 'to_date']) {
    if (a[k] != null && !(/^\d{4}-\d{2}-\d{2}$/.test(a[k]) && !Number.isNaN(Date.parse(a[k])))) throw new UserError(`${k} must be YYYY-MM-DD`);
  }
  if (a.from_date && a.to_date && a.from_date > a.to_date) throw new UserError('from_date is after to_date');
  const max = a.max_results == null ? 5 : Number(a.max_results);
  if (!Number.isInteger(max) || max < 1 || max > 20) throw new UserError('max_results must be an integer 1-20');
  return { query, allowed, excluded, from: a.from_date, to: a.to_date, max, image: a.enable_image_understanding === true, video: a.enable_video_understanding === true, refresh: a.refresh === true };
}

async function pickModel(cfg, signal) {
  if (cfg.model) return cfg.model;
  if (cfg.st.model.id && Date.now() - cfg.st.model.at < 300_000) return cfg.st.model.id;
  const r = await fetch(`${cfg.gateway}/v1/models`, { headers: { authorization: 'Bearer magpie-x-search' }, signal });
  if (!r.ok) throw new Error(`magpie gateway /v1/models HTTP ${r.status}`);
  const grok = ((await r.json()).data ?? []).filter(m => /^grok\//i.test(m.id) && (m.native_endpoints ?? ['/v1/responses']).includes('/v1/responses'));
  if (!grok.length) throw new UserError('X search needs the Grok (SuperGrok) provider in magpie: add it under Providers, sign in, and keep at least one Grok model ticked (Models → Picked only). Or set the plugin option "model".');
  const ver = m => Number(m.id.match(/[\d.]+/g)?.pop() ?? 0);
  grok.sort((a, b) => ver(b) - ver(a));
  cfg.st.model = { at: Date.now(), id: grok[0].id };
  return grok[0].id;
}

function budget(cfg) {
  const now = Date.now();
  while (cfg.st.calls.length && now - cfg.st.calls[0] > 60_000) cfg.st.calls.shift();
  const key = new Date().toLocaleDateString('sv');
  if (cfg.st.day.key !== key) cfg.st.day = { key, n: 0 };
  if (cfg.st.calls.length >= cfg.perMinute) throw new UserError(`Rate limit: ${cfg.perMinute} X searches/minute. Retry in ~${Math.ceil((60_000 - (now - cfg.st.calls[0])) / 1000)}s or reuse an earlier result.`);
  if (cfg.st.day.n >= cfg.perDay) throw new UserError(`Daily cap of ${cfg.perDay} X searches reached (protects the shared SuperGrok quota); resets at local midnight.`);
  cfg.st.calls.push(now); cfg.st.day.n++;
}

async function slot(cfg, fn) {
  if (cfg.st.active >= cfg.concurrency) await new Promise(r => cfg.st.queue.push(r));
  cfg.st.active++;
  try { return await fn(); } finally { cfg.st.active--; cfg.st.queue.shift()?.(); }
}

// One Responses call to Grok with a server-side x_search tool. Returns the cleaned text, cited URLs and the raw reply.
async function callGrok(cfg, { input, tool, maxToolCalls }, abort, what) {
  const signal = abort ? AbortSignal.any([abort, AbortSignal.timeout(cfg.budgetMs)]) : AbortSignal.timeout(cfg.budgetMs);
  try {
    const model = await pickModel(cfg, signal);
    const r = await fetch(`${cfg.gateway}/v1/responses`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer magpie-x-search' },
      body: JSON.stringify({ model, input, tools: [tool], tool_choice: 'required', max_tool_calls: maxToolCalls, stream: false }),
    });
    const raw = await r.text();
    if (!r.ok) {
      if (r.status === 429) throw new UserError('Grok quota/rate limit hit upstream (HTTP 429). Try again later.');
      throw new Error(`magpie gateway HTTP ${r.status}: ${raw.slice(0, 300)}`);
    }
    const d = JSON.parse(raw);
    if (d.status && d.status !== 'completed') throw new Error(`upstream status "${d.status}"`);
    let text = ''; const src = new Set();
    for (const o of d.output ?? []) {
      if (o.type !== 'message') continue;
      for (const c of o.content ?? []) {
        if (typeof c.text !== 'string') continue;
        text += c.text;
        for (const a of c.annotations ?? []) if (a.type === 'url_citation' && a.url) src.add(a.url);
      }
    }
    text = text.replace(/\s*\[\[\d+\]\]\(https?:\/\/[^)]+\)/g, '').trim();
    if (!text) throw new Error('Grok returned no text (it may not have used X). Try rephrasing.');
    return { text, src, d };
  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError') throw new UserError(`${what} timed out (magpie tools have a 55s limit). ${what === 'X search' ? 'Narrow the query with handles/dates or lower max_results.' : 'Try again, or turn off replies/media understanding.'}`);
    if (e.cause?.code === 'ECONNREFUSED') throw new Error(`Cannot reach magpie gateway at ${cfg.gateway}`);
    throw e;
  }
}

const withSources = (text, src) => text + (src.size ? `\n\nSources:\n${[...src].map(u => `- ${u}`).join('\n')}` : '');

async function search(cfg, p, abort) {
  const tool = { type: 'x_search' };
  if (p.allowed) tool.allowed_x_handles = p.allowed;
  if (p.excluded) tool.excluded_x_handles = p.excluded;
  if (p.from) tool.from_date = p.from;
  if (p.to) tool.to_date = p.to;
  if (p.image) tool.enable_image_understanding = true;
  if (p.video) tool.enable_video_understanding = true;
  const input = [
    'Search X (Twitter) for the request below, then answer only from what the search returned. Do not invent posts.',
    `List up to ${p.max} of the most relevant posts: @handle, date, a short faithful quote or paraphrase, and the post URL.`,
    'Then give a 2-3 sentence summary. If nothing relevant was found, say so plainly.',
    '', `Request: ${p.query}`,
  ].join('\n');
  const { text, src } = await callGrok(cfg, { input, tool, maxToolCalls: cfg.maxToolCalls }, abort, 'X search');
  for (const m of text.matchAll(/https?:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/\d+/g)) src.add(m[0]);
  return withSources(text, src);
}

// ---- x_read: fetch one post by URL/ID (Grok's server-side x_thread_fetch, reached through the same x_search tool) ----

const READ_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.twitter.com', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com', 'fixvx.com']);

function parseRead(a) {
  const raw = typeof a?.url === 'number' ? String(a.url) : typeof a?.url === 'string' ? a.url.trim() : '';
  if (!raw || raw.length > 500) throw new UserError('url must be an X post URL (https://x.com/<handle>/status/<id>) or a numeric post id');
  let id, handle;
  if (/^\d{1,25}$/.test(raw)) id = raw;
  else {
    let u;
    try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { throw new UserError(`not a valid URL: ${raw.slice(0, 80)}`); }
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (!READ_HOSTS.has(host)) throw new UserError(`x_read only reads X/Twitter posts (x.com, twitter.com, fxtwitter.com, …), not ${host}`);
    const m = u.pathname.match(/^\/(?:([A-Za-z0-9_]{1,15})|i(?:\/web)?)\/status(?:es)?\/(\d{1,25})(?:\/|$)/);
    if (!m) throw new UserError('that URL is not a post link; expected https://x.com/<handle>/status/<id>');
    handle = m[1]; id = m[2];
  }
  const rep = a.include_replies;
  const replies = rep === true ? 5 : rep == null || rep === false ? 0 : Number(rep);
  if (!Number.isInteger(replies) || replies < 0 || replies > 20) throw new UserError('include_replies must be true or an integer 0-20');
  return { id, url: `https://x.com/${handle ?? 'i'}/status/${id}`, replies, image: a.enable_image_understanding === true, video: a.enable_video_understanding === true, refresh: a.refresh === true };
}

async function read(cfg, p, abort) {
  const tool = { type: 'x_search' };
  if (p.image) tool.enable_image_understanding = true;
  if (p.video) tool.enable_video_understanding = true;
  const input = [
    'Open this exact X post (post id ' + p.id + ') with your post-fetch tool; do not search for other posts. Report only what the tool returned.',
    '- author @handle and display name, post time (UTC)',
    '- the full post text VERBATIM (every character, no truncation, no paraphrase), including any long-form / note text',
    '- if it replies to or quotes another post: that post\'s author, time and text',
    '- if the author\'s own follow-up posts of the same thread were returned: list them in order, verbatim',
    '- media (photos / videos / link cards): URL and, only if the tool described it, what it shows',
    '- counts (replies, reposts, quotes, likes, bookmarks, views) as returned',
    p.replies ? `- then up to ${p.replies} of the most relevant replies from other accounts (@handle, text)` : '- do NOT list replies from other accounts',
    'If the post could not be retrieved (deleted, protected, unavailable), say that plainly and stop. Never fill gaps from memory.',
    '', `Post: ${p.url}`,
  ].join('\n');
  const { text, src, d } = await callGrok(cfg, { input, tool, maxToolCalls: 1 }, abort, 'X post read');
  // Guard against a made-up answer: Grok must really have run its post-fetch tool on this id.
  const fetched = (d.output ?? []).some(o => o.type === 'custom_tool_call' && o.name === 'x_thread_fetch' && String(o.input).includes(p.id));
  if (!fetched) throw new UserError(`Grok did not fetch post ${p.id} (the post may be deleted, protected or unreachable), so no content is returned rather than a guess. Try refresh:true or x_search.`);
  const urls = new Set([p.url]);
  for (const m of text.matchAll(/https?:\/\/(?:pbs|video)\.twimg\.com\/[^\s)\]>"']+/g)) urls.add(m[0].replace(/[.,;]+$/, ''));
  return withSources(text, urls);
}

// Shared by both tools: cache, in-flight merge, concurrency slot, rate/day budget.
async function guarded(cfg, key, abort, fn, refresh) {
  if (!refresh) {
    const hit = cfg.st.cache.get(key);
    if (hit && Date.now() - hit.at < cfg.cacheSec * 1000) return hit.v;
    const pending = cfg.st.inflight.get(key);
    if (pending) return pending;
  }
  const job = slot(cfg, async () => {
    budget(cfg);
    const v = await fn(abort);
    if (cfg.cacheSec > 0) {
      cfg.st.cache.set(key, { at: Date.now(), v });
      if (cfg.st.cache.size > 200) cfg.st.cache.delete(cfg.st.cache.keys().next().value);
    }
    return v;
  });
  cfg.st.inflight.set(key, job);
  try { return await job; } finally { cfg.st.inflight.delete(key); }
}

function run(cfg, args, abort) {
  const p = parse(args ?? {});
  return guarded(cfg, JSON.stringify(['search', p.query, p.allowed, p.excluded, p.from, p.to, p.max, p.image, p.video]), abort, a => search(cfg, p, a), p.refresh);
}

function runRead(cfg, args, abort) {
  const p = parseRead(args ?? {});
  return guarded(cfg, JSON.stringify(['read', p.id, p.replies, p.image, p.video]), abort, a => read(cfg, p, a), p.refresh);
}

export const XSearchTools = async (_input, options) => {
  const cfg = { ...DEF, ...(options && typeof options === 'object' ? options : {}), st: newState() };
  return {
    tool: {
      search: {
        description:
          "Search X (formerly Twitter) posts, i.e. tweets, with Grok's native real-time X/Twitter search. Use for current events, what people are saying about something, " +
          "a specific account's recent tweets, trends, or finding a post or thread. Returns a summary plus source post URLs. Slow (10-45s) and quota-limited: " +
          'make ONE well-formed query and use the handle/date filters instead of putting them in the query text.',
        args: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to look for, in natural language.' },
            allowed_x_handles: { type: 'array', items: { type: 'string' }, description: 'Only posts from these handles (max 20, @ optional). Exclusive with excluded_x_handles.' },
            excluded_x_handles: { type: 'array', items: { type: 'string' }, description: 'Ignore posts from these handles (max 20). Exclusive with allowed_x_handles.' },
            from_date: { type: 'string', description: 'Earliest post date, YYYY-MM-DD.' },
            to_date: { type: 'string', description: 'Latest post date, YYYY-MM-DD.' },
            max_results: { type: 'number', description: 'Roughly how many posts to list (1-20, default 5).' },
            enable_image_understanding: { type: 'boolean', description: 'Let Grok look at images in posts (slower, more quota).' },
            enable_video_understanding: { type: 'boolean', description: 'Let Grok look at videos in posts (slower, more quota).' },
            refresh: { type: 'boolean', description: 'Bypass the 5-minute result cache.' },
          },
          required: ['query'],
        },
        async execute(args, ctx) {
          return await run(cfg, args, ctx?.abort);
        },
      },
      read: {
        description:
          'Read ONE specific X (formerly Twitter) post, i.e. a tweet, from its URL or id: author, time, full verbatim text, quoted/replied-to post, thread continuation by the author, media URLs and counts. ' +
          'Use this whenever you are given an x.com / twitter.com status link and need its content (web fetch cannot read X). Pass replies only if you want the discussion. ' +
          'For finding posts, topics or an account\'s recent tweets use x_search instead. Takes 10-20s and uses SuperGrok quota.',
        args: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Post URL (https://x.com/<handle>/status/<id>; twitter.com, fxtwitter.com, vxtwitter.com also work) or the numeric post id.' },
            include_replies: { type: 'number', description: 'Also list this many replies from other accounts (1-20). Omit or 0 for the post only.' },
            enable_image_understanding: { type: 'boolean', description: 'Let Grok describe images in the post (slower, more quota).' },
            enable_video_understanding: { type: 'boolean', description: 'Let Grok describe videos in the post (slower, more quota).' },
            refresh: { type: 'boolean', description: 'Bypass the 5-minute result cache.' },
          },
          required: ['url'],
        },
        async execute(args, ctx) {
          return await runRead(cfg, args, ctx?.abort);
        },
      },
    },
  };
};
