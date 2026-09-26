#!/usr/bin/env node
// Stands in for wireproxy in tests: reads the generated config and serves its [Socks5] section.
import { readFileSync, appendFileSync } from "node:fs";
import { startSocks } from "./helpers.js";

const config = readFileSync(process.argv[process.argv.indexOf("-c") + 1], "utf8");
const value = key => config.match(new RegExp(`^${key} = (.+)$`, "m"))?.[1];
if (process.env.FAKE_WIREPROXY_LOG) appendFileSync(process.env.FAKE_WIREPROXY_LOG, `${JSON.stringify(config)}\n`);
if (!value("PrivateKey")) { console.error("missing private key"); process.exit(1); }
await startSocks({ port: Number(value("BindAddress").split(":")[1]), username: value("Username"), password: value("Password") });
