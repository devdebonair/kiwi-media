import test from "node:test";
import assert from "node:assert/strict";
import { configuredProviders } from "../src/providers.js";

const env = {
  STASH_BOX_ENDPOINT: "https://stashdb.example/graphql", STASH_BOX_API_KEY: "stash-secret",
  TPDB_ENDPOINT: "https://tpdb.example/graphql", TPDB_API_KEY: "tpdb-secret",
};

test("provider selection keeps credentials separate and preserves endpoint override", () => {
  const providers = configuredProviders({}, env);
  assert.deepEqual(providers.map(p => [p.name, p.client.endpoint, p.client.apiKey]), [
    ["stashdb", env.STASH_BOX_ENDPOINT, env.STASH_BOX_API_KEY],
    ["tpdb", env.TPDB_ENDPOINT, env.TPDB_API_KEY],
  ]);
  assert.equal(configuredProviders({ provider: "tpdb" }, env)[0].client.apiKey, env.TPDB_API_KEY);
  assert.equal(configuredProviders({ endpoint: "https://custom.example/graphql" }, env)[0].client.apiKey, env.STASH_BOX_API_KEY);
  assert.equal(configuredProviders({ provider: "tpdb" }, { TPDB_API_KEY: "token" })[0].client.endpoint, "https://theporndb.net/graphql");
});

test("missing optional token preserves StashDB and explicit selection requires its own key", () => {
  const withoutTpdb = { ...env, TPDB_API_KEY: "" };
  assert.deepEqual(configuredProviders({}, withoutTpdb).map(p => p.name), ["stashdb"]);
  assert.throws(() => configuredProviders({ provider: "tpdb" }, withoutTpdb), /TPDB_API_KEY/);
  assert.throws(() => configuredProviders({ provider: "other" }, env), /--provider/);
  assert.throws(() => configuredProviders({ provider: "all", endpoint: env.TPDB_ENDPOINT }, env), /single provider/);
});
