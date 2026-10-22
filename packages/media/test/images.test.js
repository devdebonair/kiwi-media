import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const data = mkdtempSync(join(tmpdir(), "kiwi-img-"));
process.env.KIWI_DATA_DIR = data;
const { createImageStore, imageUrl } = await import("../src/images.js");
const { cacheDatabase } = await import("../src/http.js");

const png = Buffer.from("89504e470d0a1a0a", "hex");
const make = (handler, options = {}) => createImageStore({ directory: join(data, `images-${Math.random()}`), fetchImpl: handler, ...options });

test("an image is fetched once and then served from disk", async () => {
  let calls = 0;
  const store = make(async () => { calls++; return new Response(png, { headers: { "content-type": "image/png" } }); });
  const first = await store.get("w342", "/abcdef123.png");
  const second = await store.get("w342", "/abcdef123.png");
  assert.equal(calls, 1);
  assert.equal(first.path, second.path);
  assert.ok(existsSync(first.path));
  assert.equal(first.contentType, "image/png");
});

test("simultaneous requests for the same image share one download", async () => {
  let calls = 0;
  const store = make(async () => { calls++; await new Promise(resolve => setTimeout(resolve, 20)); return new Response(png); });
  await Promise.all([1, 2, 3, 4].map(() => store.get("w185", "/sharedimage1.jpg")));
  assert.equal(calls, 1);
});

test("a missing image is remembered so it is not requested on every render", async () => {
  let calls = 0;
  const store = make(async () => { calls++; return new Response("", { status: 404 }); });
  assert.equal(await store.get("w500", "/nothere12345.jpg"), null);
  assert.equal(await store.get("w500", "/nothere12345.jpg"), null);
  assert.equal(calls, 1);
});

test("only known sizes and plain file names are fetched", async () => {
  const store = make(async () => { throw new Error("must not fetch"); });
  assert.equal(await store.get("w9999", "/abcdef123.png"), null);
  assert.equal(await store.get("w342", "/../../etc/passwd"), null);
  assert.equal(await store.get("w342", "/a/b/c.png"), null);
  assert.equal(imageUrl("/abcdef123.png", "w342"), "/api/v1/images/tmdb/w342/abcdef123.png");
  assert.equal(imageUrl("../x", "w342"), null);
  assert.equal(imageUrl(null), null);
});

test("browse-only artwork is evicted oldest first once the cache is full; pinned library artwork stays", async () => {
  const big = Buffer.alloc(1000, 1);
  const store = make(async () => new Response(big), { maxBytes: 2500 });
  await store.get("w92", "/pinned12345.jpg", { pin: true });
  for (const name of ["one12345", "two12345", "three12345", "four12345"]) await store.get("w92", `/${name}.jpg`);
  store.evict();
  const rows = cacheDatabase().prepare("SELECT key, pinned FROM image_cache WHERE bytes>0 ORDER BY last_access").all();
  assert.ok(rows.some(row => row.key.includes("pinned12345") && row.pinned === 1), "pinned stays");
  assert.ok(rows.filter(row => !row.pinned).length < 4, "some browse-only images were evicted");
});
