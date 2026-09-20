import { setTimeout as sleep } from "node:timers/promises";

const QUERY = `query KiwiFingerprintLookup($fingerprints: [[FingerprintQueryInput!]!]!) {
  findScenesBySceneFingerprints(fingerprints: $fingerprints) {
    id title release_date duration code deleted
    urls { url }
    studio { id name }
    performers { as performer { id name } }
    tags { id name }
    images { id url width height }
  }
}`;

export class StashBoxClient {
  constructor({ endpoint, apiKey, timeoutMs = 30_000, retries = 2, fetchImpl = fetch } = {}) {
    let url;
    try { url = new URL(endpoint); } catch { throw new Error("A valid stash-box GraphQL endpoint is required"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Endpoint must be an HTTP(S) URL without credentials, query parameters, or fragment");
    }
    if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("A stash-box API key is required");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("timeoutMs must be a positive integer");
    if (!Number.isInteger(retries) || retries < 0 || retries > 5) throw new Error("retries must be between 0 and 5");
    this.endpoint = url.href;
    this.apiKey = apiKey.trim();
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.fetch = fetchImpl;
  }

  async findScenesByFingerprints(groups) {
    if (!Array.isArray(groups) || groups.length < 1 || groups.length > 100) {
      throw new Error("Supply between 1 and 100 fingerprint groups");
    }
    // Only hashes and algorithms leave this machine, never paths or video bytes.
    const fingerprints = groups.map(group => {
      if (!Array.isArray(group) || !group.length) throw new Error("Each file needs at least one fingerprint");
      return group.map(({ algorithm, hash }) => {
        const pattern = algorithm === "MD5" ? /^[a-f0-9]{32}$/i : /^[a-f0-9]{16}$/i;
        if (!["OSHASH", "PHASH", "MD5"].includes(algorithm) || typeof hash !== "string" || !pattern.test(hash)) {
          throw new Error("Invalid fingerprint algorithm or hexadecimal hash");
        }
        return { algorithm, hash: hash.toLowerCase() };
      });
    });
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await this.fetch(this.endpoint, {
          method: "POST", redirect: "error",
          headers: { "Content-Type": "application/json", ApiKey: this.apiKey },
          body: JSON.stringify({ query: QUERY, variables: { fingerprints } }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        // Don't expose headers, credentials, or server-controlled error text.
        throw new Error("stash-box request failed: connection, timeout, or redirect error");
      }
      if ([429, 502, 503, 504].includes(response.status) && attempt < this.retries) {
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        await response.body?.cancel();
        if (Number.isFinite(delay) && delay > 30_000) {
          throw new Error("stash-box requested a retry delay longer than 30 seconds; retry later");
        }
        await sleep(Math.max(0, Number.isFinite(delay) ? delay : 500 * 2 ** attempt));
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`stash-box HTTP ${response.status}${[401, 403].includes(response.status) ? ": check API key and READ access" : ""}`);
      }
      let payload;
      try { payload = await response.json(); } catch { throw new Error("stash-box returned invalid JSON or an incomplete response"); }
      if (payload.errors?.length) throw new Error("stash-box GraphQL request failed; check endpoint schema and API key permissions");
      const results = payload.data?.findScenesBySceneFingerprints;
      if (!Array.isArray(results) || results.length !== groups.length || !results.every(Array.isArray)) {
        throw new Error("stash-box returned an unexpected fingerprint result shape");
      }
      return results.map(scenes => {
        const unique = new Map();
        for (const scene of scenes) {
          if (scene === null || scene.deleted) continue;
          if (typeof scene.id !== "string" || !scene.id) throw new Error("stash-box returned a scene without an ID");
          unique.set(scene.id, scene);
        }
        return [...unique.values()];
      });
    }
  }
}
