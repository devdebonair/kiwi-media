import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KIWI_DATA_DIR = mkdtempSync(join(tmpdir(), "kiwi-http-"));
const { createProviderClient, ProviderError, clearHttpCache, cacheSummary } = await import("../src/http.js");

const reply = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
const clock = () => { let time = 1_000_000; return { now: () => time, advance: ms => { time += ms; }, wait: async ms => { time += ms; } }; };
const make = (fetchImpl, options = {}, time = clock()) => ({ client: createProviderClient({ name: `t${Math.random()}`, baseUrl: "https://api.test", fetchImpl, now: time.now, wait: time.wait, retries: 2, ...options }), time });

test("identical requests in flight share one call and later ones come from the cache", async () => {
  let calls = 0;
  const { client } = make(async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return reply({ n: calls }); });
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => client.json("/x", { ttl: 60 })));
  assert.deepEqual([a, b, c], [{ n: 1 }, { n: 1 }, { n: 1 }]);
  assert.deepEqual(await client.json("/x", { ttl: 60 }), { n: 1 });
  assert.equal(calls, 1);
  assert.equal(client.stats.hits, 1);
});

test("stale answers are served while they refresh, and when the service is failing", async () => {
  let calls = 0, failing = false;
  const { client, time } = make(async () => { calls++; if (failing) return new Response("no", { status: 500 }); return reply({ n: calls }); }, { retries: 0 });
  assert.deepEqual(await client.json("/y", { ttl: 10, swr: 100 }), { n: 1 });
  time.advance(20_000);
  assert.deepEqual(await client.json("/y", { ttl: 10, swr: 100 }), { n: 1 }, "stale copy returned at once");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await client.json("/y", { ttl: 10, swr: 100 }), { n: 2 }, "refreshed in the background");
  failing = true;
  time.advance(500_000);
  assert.deepEqual(await client.json("/y", { ttl: 10, swr: 0 }), { n: 2 }, "an outage falls back to the last good answer");
});

test("429 and server errors retry with backoff, honoring Retry-After", async () => {
  const waits = [];
  const time = clock();
  let calls = 0;
  const client = createProviderClient({ name: "retry", baseUrl: "https://api.test", now: time.now, wait: async ms => { waits.push(ms); time.advance(ms); }, retries: 2,
    fetchImpl: async () => { calls++; return calls < 3 ? new Response("slow down", { status: 429, headers: { "retry-after": "2" } }) : reply({ ok: true }); } });
  assert.deepEqual(await client.json("/z"), { ok: true });
  assert.equal(calls, 3);
  assert.ok(waits.filter(ms => ms === 2000).length >= 2, `waited for Retry-After: ${waits}`);
  assert.equal(client.stats.rateLimited, 2);
});

test("a token bucket spaces requests out instead of bursting past the limit", async () => {
  const time = clock();
  const starts = [];
  const client = createProviderClient({ name: "bucket", baseUrl: "https://api.test", now: time.now, wait: async ms => { time.advance(ms); }, ratePerSecond: 2, burst: 2, concurrency: 10,
    fetchImpl: async () => { starts.push(time.now()); return reply({}); } });
  await Promise.all(Array.from({ length: 6 }, (_, index) => client.json(`/p${index}`)));
  const span = starts.at(-1) - starts[0];
  assert.ok(span >= 1400, `six calls at 2/second with a burst of 2 are spread over about 2s, took ${span}ms`);
});

test("repeated failures open a breaker so a struggling service is left alone", async () => {
  let calls = 0;
  const { client } = make(async () => { calls++; throw new Error("down"); }, { retries: 0 });
  for (let index = 0; index < 5; index++) await assert.rejects(client.json(`/f${index}`), ProviderError);
  const before = calls;
  await assert.rejects(client.json("/g"), /temporarily unavailable/);
  assert.equal(calls, before, "no request is made while the breaker is open");
});

test("missing credentials are reported as such, not as a network failure", async () => {
  const client = createProviderClient({ name: "auth", baseUrl: "https://api.test", fetchImpl: async () => reply({}), headers: () => { throw new ProviderError("Add your key", { status: 400 }); } });
  await assert.rejects(client.json("/a"), error => error.statusCode === 400 && /Add your key/.test(error.message));
});

test("the cache can be cleared and reports what it holds", async () => {
  const { client } = make(async () => reply({ big: "x".repeat(100) }), {});
  await client.json("/c", { ttl: 60 });
  assert.ok(cacheSummary().providers.some(item => item.entries >= 1));
  clearHttpCache();
  assert.deepEqual(cacheSummary().providers, []);
});
