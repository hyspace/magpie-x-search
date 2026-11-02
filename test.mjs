// Run: npm test   (node --test). Uses a fake magpie gateway; touches no network or credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { XSearchTools } from './index.mjs';

function fakeGateway({ models, onResponses }) {
  const seen = { responses: [], models: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      if (req.url === '/v1/models') { seen.models++; return res.end(JSON.stringify({ data: models })); }
      if (req.url === '/v1/responses') {
        const b = JSON.parse(body); seen.responses.push(b);
        const out = onResponses?.(b) ?? {
          status: 'completed',
          output: [
            { type: 'custom_tool_call', name: 'x_keyword_search' },
            { type: 'message', content: [{ type: 'output_text', text: '@a (Nov 1): hello https://x.com/a/status/1 [[1]](https://x.com/a/status/1)', annotations: [{ type: 'url_citation', url: 'https://x.com/a/status/1' }] }] },
          ],
        };
        return res.end(JSON.stringify(out));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

const GROK = [{ id: 'grok/grok-4.3', native_endpoints: ['/v1/responses'] }, { id: 'grok/grok-4.7', native_endpoints: ['/v1/responses'] }, { id: 'claude/claude-haiku-5-5' }];
const plugin = async (url, opts = {}) => (await XSearchTools({}, { gateway: url, ...opts })).tool.search;
const reader = async (url, opts = {}) => (await XSearchTools({}, { gateway: url, ...opts })).tool.read;
const fetched = id => ({
  status: 'completed',
  output: [
    { type: 'custom_tool_call', name: 'x_thread_fetch', input: JSON.stringify({ post_id: id }) },
    { type: 'message', content: [{ type: 'output_text', text: `Author: Jack (@jack)\nFull text: just setting up my twttr\nPhoto: https://pbs.twimg.com/media/abc.jpg.` }] },
  ],
});

test('exposes search with a description that covers twitter/tweets', async () => {
  const t = await plugin('http://127.0.0.1:1');
  assert.match(t.description, /Twitter/);
  assert.match(t.description, /tweets/);
  assert.deepEqual(t.args.required, ['query']);
});

test('calls Responses with x_search + filters, picks highest grok model, cleans output', async () => {
  const g = await fakeGateway({ models: GROK });
  try {
    const t = await plugin(g.url);
    const out = await t.execute({ query: 'ai news', allowed_x_handles: ['@karpathy'], from_date: '2026-10-25', to_date: '2026-11-01' }, {});
    const b = g.seen.responses[0];
    assert.equal(b.model, 'grok/grok-4.7');
    assert.equal(b.tool_choice, 'required');
    assert.deepEqual(b.tools, [{ type: 'x_search', allowed_x_handles: ['karpathy'], from_date: '2026-10-25', to_date: '2026-11-01' }]);
    assert.match(out, /@a \(Nov 1\): hello/);
    assert.ok(!out.includes('[[1]]'));
    assert.match(out, /Sources:\n- https:\/\/x\.com\/a\/status\/1/);
  } finally { g.server.close(); }
});

test('validates arguments', async () => {
  const t = await plugin('http://127.0.0.1:1');
  await assert.rejects(t.execute({}, {}), /query/);
  await assert.rejects(t.execute({ query: 'x', allowed_x_handles: ['a'], excluded_x_handles: ['b'] }, {}), /mutually exclusive/);
  await assert.rejects(t.execute({ query: 'x', from_date: '2026-13-45' }, {}), /YYYY-MM-DD/);
  await assert.rejects(t.execute({ query: 'x', from_date: '2026-11-02', to_date: '2026-11-01' }, {}), /after/);
  await assert.rejects(t.execute({ query: 'x', allowed_x_handles: ['bad handle!'] }, {}), /invalid handle/);
  await assert.rejects(t.execute({ query: 'x', max_results: 99 }, {}), /1-20/);
});

test('caches identical calls, refresh bypasses', async () => {
  const g = await fakeGateway({ models: GROK });
  try {
    const t = await plugin(g.url);
    await t.execute({ query: 'cache me' }, {});
    await t.execute({ query: 'cache me' }, {});
    assert.equal(g.seen.responses.length, 1);
    await t.execute({ query: 'cache me', refresh: true }, {});
    assert.equal(g.seen.responses.length, 2);
  } finally { g.server.close(); }
});

test('shared rate limit stops runaway callers; cache hits are free', async () => {
  const g = await fakeGateway({ models: GROK });
  try {
    const t = await plugin(g.url, { perMinute: 2 });
    await t.execute({ query: 'a' }, {});
    await t.execute({ query: 'b' }, {});
    await assert.rejects(t.execute({ query: 'c' }, {}), /Rate limit/);
    await t.execute({ query: 'a' }, {}); // cached: not counted
  } finally { g.server.close(); }
});

test('clear error when magpie has no Grok provider', async () => {
  const g = await fakeGateway({ models: [{ id: 'claude/claude-haiku-5-5' }, { id: 'cursor/grok-fast', native_endpoints: ['/v1/responses'] }] });
  try {
    const t = await plugin(g.url);
    await assert.rejects(t.execute({ query: 'x' }, {}), /Grok \(SuperGrok\) provider/);
    assert.equal(g.seen.responses.length, 0);
  } finally { g.server.close(); }
});

test('an empty upstream reply becomes a readable error', async () => {
  const g = await fakeGateway({ models: GROK, onResponses: () => ({ status: 'completed', output: [] }) });
  try {
    const t = await plugin(g.url);
    await assert.rejects(t.execute({ query: 'empty' }, {}), /no text/);
  } finally { g.server.close(); }
});

test('exposes x_read with a required url', async () => {
  const t = await reader('http://127.0.0.1:1');
  assert.deepEqual(t.args.required, ['url']);
  assert.match(t.description, /tweet/);
});

test('x_read: URL variants resolve to the post id and canonical URL', async () => {
  const g = await fakeGateway({ models: GROK, onResponses: () => fetched('20') });
  try {
    const t = await reader(g.url, { cacheSec: 0, perMinute: 100 });
    for (const u of ['https://x.com/jack/status/20', 'https://twitter.com/jack/status/20?s=46&t=x', 'mobile.twitter.com/jack/status/20/photo/1', 'https://fxtwitter.com/jack/status/20', 'https://x.com/i/web/status/20', 'https://x.com/i/status/20', '20', 20]) {
      const out = await t.execute({ url: u }, {});
      assert.match(out, /just setting up my twttr/, u);
    }
    const first = g.seen.responses[0];
    assert.equal(first.tool_choice, 'required');
    assert.equal(first.max_tool_calls, 1);
    assert.deepEqual(first.tools, [{ type: 'x_search' }]);
    assert.match(first.input, /Post: https:\/\/x\.com\/jack\/status\/20$/);
    assert.match(first.input, /do NOT list replies/);
    const out = await t.execute({ url: 'https://x.com/jack/status/20', include_replies: 3, enable_image_understanding: true }, {});
    const last = g.seen.responses.at(-1);
    assert.match(last.input, /up to 3 of the most relevant replies/);
    assert.deepEqual(last.tools, [{ type: 'x_search', enable_image_understanding: true }]);
    assert.match(out, /Sources:\n- https:\/\/x\.com\/jack\/status\/20\n- https:\/\/pbs\.twimg\.com\/media\/abc\.jpg$/);
  } finally { g.server.close(); }
});

test('x_read validates input', async () => {
  const t = await reader('http://127.0.0.1:1');
  await assert.rejects(t.execute({}, {}), /url must be/);
  await assert.rejects(t.execute({ url: 'https://example.com/jack/status/20' }, {}), /only reads X/);
  await assert.rejects(t.execute({ url: 'https://x.com/jack' }, {}), /not a post link/);
  await assert.rejects(t.execute({ url: 'https://x.com/jack/status/abc' }, {}), /not a post link/);
  await assert.rejects(t.execute({ url: 'https://x.com/jack/status/20', include_replies: 99 }, {}), /0-20/);
});

test('x_read refuses an answer when Grok never fetched the post', async () => {
  const noTool = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'I recall @jack tweeted something like...' }] }] };
  const g1 = await fakeGateway({ models: GROK, onResponses: () => noTool });
  const g2 = await fakeGateway({ models: GROK, onResponses: () => fetched('999') }); // fetched a different post
  try {
    await assert.rejects((await reader(g1.url)).execute({ url: '20' }, {}), /did not fetch post 20/);
    await assert.rejects((await reader(g2.url)).execute({ url: '20' }, {}), /did not fetch post 20/);
  } finally { g1.server.close(); g2.server.close(); }
});

test('x_read caches per post id and shares the rate limit with x_search', async () => {
  const g = await fakeGateway({ models: GROK, onResponses: b => (b.tools[0].type === 'x_search' && /Post:/.test(b.input) ? fetched('20') : undefined) });
  try {
    const p = await XSearchTools({}, { gateway: g.url, perMinute: 2 });
    await p.tool.read.execute({ url: 'https://x.com/jack/status/20' }, {});
    await p.tool.read.execute({ url: 'https://twitter.com/jack/status/20' }, {}); // same id: cached
    assert.equal(g.seen.responses.length, 1);
    await p.tool.search.execute({ query: 'a' }, {});
    await assert.rejects(p.tool.read.execute({ url: 'https://x.com/jack/status/20', refresh: true }, {}), /Rate limit/);
  } finally { g.server.close(); }
});
