import { StashBoxClient } from "@kiwi/stash-box";

export function configuredProviders({ provider, endpoint } = {}, env = process.env) {
  if (provider && !["stashdb", "tpdb", "all"].includes(provider)) {
    throw new Error("--provider must be stashdb, tpdb, or all");
  }
  if (endpoint && provider === "all") throw new Error("--endpoint requires a single provider");
  const definitions = {
    stashdb: { endpoint: env.STASH_BOX_ENDPOINT, apiKey: env.STASH_BOX_API_KEY },
    tpdb: { endpoint: env.TPDB_ENDPOINT || "https://theporndb.net/graphql", apiKey: env.TPDB_API_KEY },
  };
  // Preserve the original --endpoint + STASH_BOX_API_KEY interface.
  const names = endpoint ? [provider || "stashdb"] : provider && provider !== "all" ? [provider]
    : ["stashdb", "tpdb"].filter(name => definitions[name].apiKey?.trim());
  if (!names.length) throw new Error("An API key is required: set STASH_BOX_API_KEY and STASH_BOX_ENDPOINT, or TPDB_API_KEY");
  return names.map(name => {
    const settings = definitions[name];
    if (!settings.apiKey?.trim()) throw new Error(`Set ${name === "tpdb" ? "TPDB_API_KEY" : "STASH_BOX_API_KEY"} for ${name}`);
    return { name, client: new StashBoxClient({ ...settings, endpoint: endpoint || settings.endpoint }) };
  });
}
