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

test('exposes one tool whose description covers twitter/tweets', async () => {
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
