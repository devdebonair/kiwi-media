import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "kiwi-scanner-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "clip.mp4");
  await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1", "-c:v", "mpeg4", path]);
  return { dir, path };
}

test("CLI handles folders, recursive traversal, deduplication, and per-file errors", async t => {
  const { dir, path } = await fixture(t);
  await mkdir(join(dir, "nested"));
  await writeFile(join(dir, "nested", "broken.mp4"), "not a video");
  await writeFile(join(dir, "notes.txt"), "ignored");
  const { stdout } = await exec(process.execPath, [cli, "fingerprint", "--no-cache", dir, path]);
  assert.equal(stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(stdout).path, path);
  await assert.rejects(exec(process.execPath, [cli, "fingerprint", "--recursive", "--no-cache", dir]), error => {
    assert.equal(error.code, 1);
    const records = error.stdout.trim().split("\n").map(JSON.parse);
    assert.equal(records.length, 2);
    assert.equal(records.filter(record => record.status === "error").length, 1);
    assert.equal(records.filter(record => record.fingerprints).length, 1);
    return true;
  });
});

test("CLI lookup reaches a mock stash-box and reports single, ambiguous, and missing candidates", async t => {
  const { path } = await fixture(t);
  let candidates = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.url, "/graphql");
    assert.equal(request.headers.apikey, "test-key");
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.equal(JSON.parse(body).variables.fingerprints[0][0].algorithm, "OSHASH");
    assert.ok(!body.includes(path));
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: { findScenesBySceneFingerprints: [candidates] } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/graphql`;
  for (const [scenes, status] of [[[], "unmatched"], [[{ id: "one", title: "Fixture" }], "single_candidate"], [[{ id: "one" }, { id: "two" }], "ambiguous"]]) {
    candidates = scenes;
    const { stdout } = await exec(process.execPath, [cli, "lookup", "--no-cache", path], {
      env: { ...process.env, TPDB_API_KEY: "", STASH_BOX_ENDPOINT: endpoint, STASH_BOX_API_KEY: "test-key" },
    });
    const result = JSON.parse(stdout);
    assert.equal(result.status, status);
    assert.deepEqual(result.candidates, scenes);
    assert.equal(result.source.endpoint, endpoint);
    assert.ok(result.source.retrievedAt);
    assert.ok(!stdout.includes("test-key"));
  }
});

test("CLI help works without configuration and lookup validates credentials before scanning", async () => {
  assert.match((await exec(process.execPath, [cli, "--help"])).stdout, /fingerprint\|lookup/);
  await assert.rejects(exec(process.execPath, [cli, "lookup", "/missing.mp4"], {
    env: { ...process.env, TPDB_API_KEY: "", STASH_BOX_ENDPOINT: "https://example.org/graphql", STASH_BOX_API_KEY: "" },
  }), error => {
    assert.match(error.stderr, /API key/);
    assert.equal(error.stdout, "");
    return true;
  });
});

test("multi-provider lookup reuses fingerprints, isolates keys and preserves results when one provider fails", async t => {
  const { path } = await fixture(t);
  const requests = [];
  let failStash = false;
  const server = createServer(async (request, response) => {
    const stash = request.url === "/stash";
    assert.equal(request.headers.apikey, stash ? "stash-key" : "tpdb-key");
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body).variables.fingerprints);
    if (stash && failStash) { response.writeHead(401); response.end(); return; }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: { findScenesBySceneFingerprints: [[{ id: "same-id", title: stash ? "First catalog" : "Second catalog" }]] } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, STASH_BOX_ENDPOINT: `${base}/stash`, STASH_BOX_API_KEY: "stash-key", TPDB_ENDPOINT: `${base}/tpdb`, TPDB_API_KEY: "tpdb-key" };
  const args = [cli, "lookup", "--no-cache", path];
  const result = JSON.parse((await exec(process.execPath, args, { env })).stdout);
  assert.equal(result.status, "complete");
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(result.providers.map(p => p.source.name), ["stashdb", "tpdb"]);
  assert.deepEqual(result.providers.map(p => p.candidates[0].title), ["First catalog", "Second catalog"]);
  failStash = true;
  await assert.rejects(exec(process.execPath, args, { env }), error => {
    assert.equal(error.code, 1);
    const partial = JSON.parse(error.stdout);
    assert.equal(partial.status, "partial_error");
    assert.equal(partial.providers[0].status, "error");
    assert.equal(partial.providers[1].status, "single_candidate");
    assert.ok(!error.stdout.includes("stash-key") && !error.stdout.includes("tpdb-key"));
    return true;
  });
});
