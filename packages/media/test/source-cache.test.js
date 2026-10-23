import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const data = mkdtempSync(join(tmpdir(), "kiwi-streams-"));
process.env.KIWI_DATA_DIR = data;
const { createSourceCache } = await import("../src/source-cache.js");

const file = Buffer.from(Array.from({ length: 1000 }, (_, index) => index % 251));

// A remote file that honours byte ranges and records what was asked of it.
function remote({ refuse = () => false } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const [, from, to] = /bytes=(\d+)-(\d*)/.exec(init.headers.range);
    requests.push({ url, from: Number(from), to: to === "" ? file.length - 1 : Number(to) });
    if (refuse(url)) return new Response("expired", { status: 403 });
    const end = to === "" ? file.length - 1 : Math.min(Number(to), file.length - 1);
    return new Response(file.subarray(Number(from), end + 1), { status: 206, headers: { "content-range": `bytes ${from}-${end}/${file.length}`, "content-type": "video/x-matroska" } });
  };
  return { requests, fetchImpl };
}

const make = (upstream, options = {}) => createSourceCache({
  directory: join(data, `cache-${Math.random()}`), resolve: async () => "https://cdn.example/file.mkv", fetchImpl: upstream.fetchImpl,
  block: 16, headBytes: 64, tailBytes: 32, ...options,
});

const read = async (cache, range) => {
  const response = await fetch(await cache.address("source-1"), range ? { headers: { range } } : {});
  return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
};

test("byte ranges come back exactly as the remote file has them", async () => {
  const cache = make(remote());
  for (const [range, from, to] of [["bytes=0-9", 0, 9], ["bytes=10-200", 10, 200], ["bytes=60-70", 60, 70], ["bytes=950-", 950, 999], ["bytes=-20", 980, 999], ["bytes=0-", 0, 999]]) {
    const { status, headers, body } = await read(cache, range);
    assert.equal(status, 206, range);
    assert.equal(headers.get("content-range"), `bytes ${from}-${to}/1000`, range);
    assert.deepEqual(body, file.subarray(from, to + 1), range);
  }
  const whole = await read(cache);
  assert.equal(whole.status, 200);
  assert.deepEqual(whole.body, file);
  cache.close();
});

test("the start and end of the file are fetched once, the middle every time", async () => {
  const upstream = remote();
  const cache = make(upstream);
  await read(cache, "bytes=0-63");
  await read(cache, "bytes=970-999");
  const before = upstream.requests.length;
  assert.deepEqual((await read(cache, "bytes=5-40")).body, file.subarray(5, 41));
  assert.deepEqual((await read(cache, "bytes=975-990")).body, file.subarray(975, 991));
  assert.equal(upstream.requests.length, before, "head and tail come from disk");
  await read(cache, "bytes=400-450");
  await read(cache, "bytes=400-450");
  assert.equal(upstream.requests.length, before + 2, "the middle is passed through");
  cache.close();
});

test("an expired link is refreshed once and the read carries on", async () => {
  const upstream = remote({ refuse: url => url.includes("old") });
  const forced = [];
  const cache = make(upstream, { resolve: async (key, { force }) => { forced.push(force); return force ? "https://cdn.example/new" : "https://cdn.example/old"; } });
  const { status, body } = await read(cache, "bytes=100-120");
  assert.equal(status, 206);
  assert.deepEqual(body, file.subarray(100, 121));
  assert.ok(forced.includes(true));
  cache.close();
});

test("the cache keeps itself under its size limit, dropping the least recently used source", async () => {
  const upstream = remote();
  const directory = join(data, "evict");
  const cache = createSourceCache({ directory, resolve: async () => "https://cdn.example/f", fetchImpl: upstream.fetchImpl, block: 16, headBytes: 64, tailBytes: 32, maxBytes: 150 });
  for (const key of ["first", "second", "third"]) {
    await fetch(await cache.address(key), { headers: { range: "bytes=0-63" } }).then(response => response.arrayBuffer());
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  cache.evict();
  const left = readdirSync(directory);
  assert.ok(!left.includes("first"), "the oldest source is removed");
  assert.ok(left.includes("third"));
  assert.ok(existsSync(join(directory, "third", "0")));
  cache.close();
});

test("unknown addresses are refused", async () => {
  const cache = make(remote());
  const address = await cache.address("source-1");
  assert.equal((await fetch(address.replace(/\/[a-f0-9]+\//, "/0000/"))).status, 404);
  await assert.rejects(cache.address("../escape"));
  cache.close();
});
