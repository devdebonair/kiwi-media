import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { SETTINGS_SECTIONS, searchSettings } from "../src/settings-index.mjs";

const sources = readdirSync(new URL("../src/", import.meta.url)).filter(name => name.endsWith(".jsx"))
  .map(name => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8")).join("\n");
// Ids are written literally (id="x"), or as id={`provider-${provider.id}`} for provider cards.
const rendered = id => sources.includes(`id="${id}"`) || sources.includes(`id={"${id}"}`) || (id.startsWith("provider-") && sources.includes("id={`provider-${provider.id}`}"));

test("every section and setting in the index points at an element the page renders", () => {
  for (const section of SETTINGS_SECTIONS) {
    assert.ok(rendered(section.id), `section #${section.id}`);
    for (const item of section.items) if (item.target) assert.ok(rendered(item.target), `${item.label} → #${item.target}`);
  }
  assert.equal(new Set(SETTINGS_SECTIONS.map(section => section.id)).size, SETTINGS_SECTIONS.length);
});

test("search finds settings by name, keyword, and section, best match first", () => {
  assert.equal(searchSettings("").length, 0);
  assert.equal(searchSettings("preferred qual")[0].target, "rule-preferred");
  assert.equal(searchSettings("tmdb")[0].target, "provider-tmdb");
  assert.equal(searchSettings("PIN")[0].label, "Profile PINs");
  assert.ok(searchSettings("nsfw").some(result => result.label === "Folder content rating"));
  assert.ok(searchSettings("wireguard").some(result => result.section === "vpn-profiles"));
  assert.ok(searchSettings("source rules hdr").some(result => result.target === "rule-hdr"));
  const dub = searchSettings("dub");
  assert.ok(dub.length && dub.every(result => result.target), "results carry a target");
  assert.deepEqual(searchSettings("zzzz"), []);
  // Sections are results too, so "vpn" offers both VPN sections.
  assert.ok(["vpn-profiles", "vpn-sites"].every(id => searchSettings("vpn").some(result => result.kind === "section" && result.target === id)));
});
