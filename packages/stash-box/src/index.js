import { fingerprintFile } from "./fingerprint.js";

export { computeOshash, fingerprintFile } from "./fingerprint.js";
export { StashBoxClient } from "./client.js";

export async function identifyFileWithProviders(path, { providers, ...fingerprintOptions } = {}) {
  if (!Array.isArray(providers) || !providers.length) throw new Error("At least one provider is required");
  const file = await fingerprintFile(path, fingerprintOptions);
  const results = [];
  for (const { name, client } of providers) {
    const source = { name, endpoint: client.endpoint, retrievedAt: new Date().toISOString() };
    try {
      const [candidates] = await client.findScenesByFingerprints([file.fingerprints]);
      results.push({ source, status: candidates.length === 0 ? "unmatched" : candidates.length === 1 ? "single_candidate" : "ambiguous", candidates });
    } catch (error) {
      results.push({ source, status: "error", error: error.message });
    }
  }
  return { ...file, status: results.some(result => result.status === "error") ? "partial_error" : "complete", providers: results };
}

export async function identifyFile(path, { client, ...fingerprintOptions } = {}) {
  if (!client) throw new Error("A StashBoxClient is required");
  const file = await fingerprintFile(path, fingerprintOptions);
  const [candidates] = await client.findScenesByFingerprints([file.fingerprints]);
  return {
    ...file,
    source: { endpoint: client.endpoint, retrievedAt: new Date().toISOString() },
    status: candidates.length === 0 ? "unmatched" : candidates.length === 1 ? "single_candidate" : "ambiguous",
    candidates,
  };
}
