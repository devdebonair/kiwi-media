import test from "node:test";
import assert from "node:assert/strict";
import { StashBoxClient } from "../src/index.js";

const groups = [[{ algorithm: "OSHASH", hash: "6a0eba04654d0b9b" }]];
const options = { endpoint: "https://catalog.example/graphql", apiKey: "secret-test-key" };
const response = results => Response.json({ data: { findScenesBySceneFingerprints: results } });

test("sends authenticated, read-only, nested fingerprint query and preserves ambiguous candidates", async () => {
  const client = new StashBoxClient({ ...options, fetchImpl: async (url, request) => {
    assert.equal(url, options.endpoint);
    assert.equal(request.headers.ApiKey, options.apiKey);
    assert.equal(request.redirect, "error");
    const body = JSON.parse(request.body);
    assert.match(body.query, /^query KiwiFingerprintLookup/);
    assert.deepEqual(body.variables, { fingerprints: [...groups, [{ algorithm: "PHASH", hash: "0000000000000001" }]] });
    assert.ok(!request.body.includes("private.mp4"));
    return response([[{ id: "one" }, null, { id: "two" }, { id: "one" }, { id: "deleted", deleted: true }], []]);
  } });
  assert.deepEqual(await client.findScenesByFingerprints([
    [{ ...groups[0][0], path: "/private.mp4" }], [{ algorithm: "PHASH", hash: "0000000000000001" }],
  ]), [[{ id: "one" }, { id: "two" }], []]);
});

test("retries rate limits, honors Retry-After, and returns no-match normally", async () => {
  let calls = 0;
  const client = new StashBoxClient({ ...options, fetchImpl: async () => {
    if (++calls === 1) return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
    return response([[]]);
  } });
  assert.deepEqual(await client.findScenesByFingerprints(groups), [[]]);
  assert.equal(calls, 2);
});

test("HTTP, GraphQL, network, and malformed-response failures do not become no-match results", async () => {
  const cases = [
    [() => new Response("secret-test-key", { status: 401 }), /HTTP 401/],
    [() => new Response("oops", { status: 503 }), /HTTP 503/],
    [() => Response.json({ data: { findScenesBySceneFingerprints: [[]] }, errors: [{ message: "secret-test-key" }] }), /GraphQL/],
    [() => new Response("not json"), /invalid JSON/],
    [() => response([]), /unexpected/],
    [() => response([null]), /unexpected/],
    [() => response([[{}]]), /without an ID/],
    [() => { throw new Error("secret-test-key"); }, /connection, timeout/],
  ];
  for (const [fetchImpl, expected] of cases) {
    const client = new StashBoxClient({ ...options, retries: 0, fetchImpl });
    await assert.rejects(client.findScenesByFingerprints(groups), error => {
      assert.match(error.message, expected);
      assert.ok(!error.message.includes(options.apiKey));
      return true;
    });
  }
});

test("rejects invalid configuration and fingerprints before sending a request", async () => {
  assert.throws(() => new StashBoxClient(), /endpoint/);
  assert.throws(() => new StashBoxClient({ ...options, apiKey: "" }), /API key/);
  assert.throws(() => new StashBoxClient({ ...options, endpoint: "https://user:password@example.org/graphql" }), /without credentials/);
  const client = new StashBoxClient({ ...options, fetchImpl: () => assert.fail("must not request") });
  for (const input of [[], [[]], [[{ algorithm: "SHA256", hash: "0".repeat(64) }]], [[{ algorithm: "PHASH", hash: "xyz" }]]]) {
    await assert.rejects(client.findScenesByFingerprints(input));
  }
});

test("does not shorten a provider's long rate-limit delay", async () => {
  const client = new StashBoxClient({ ...options, fetchImpl: () => new Response("", { status: 429, headers: { "Retry-After": "120" } }) });
  await assert.rejects(client.findScenesByFingerprints(groups), /retry later/);
});
