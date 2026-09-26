import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fetch as undiciFetch } from "undici";
import { dispatcherFor, DownloadError } from "./http.js";

// Private Internet Access issues WireGuard peers per key through its "manual connections" API:
// https://github.com/pia-foss/manual-connections. No PIA app or kernel VPN is needed on the server.
const serverList = "https://serverlist.piaservers.net/vpninfo/servers/v6";
const tokenUrl = "https://www.privateinternetaccess.com/api/client/v2/token";
const piaCA = readFileSync(new URL("./pia-ca.crt", import.meta.url), "utf8");

let cachedRegions = null;
export async function piaServerList({ fetchImpl = undiciFetch } = {}) {
  if (cachedRegions && Date.now() - cachedRegions.at < 60 * 60_000) return cachedRegions.value;
  const response = await fetchImpl(serverList, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new DownloadError(`PIA server list responded ${response.status}`);
  // The body is one JSON line followed by a signature.
  let list;
  try { list = JSON.parse((await response.text()).split("\n")[0]); } catch { throw new DownloadError("PIA server list could not be read"); }
  if (!Array.isArray(list.regions)) throw new DownloadError("PIA server list could not be read");
  cachedRegions = { at: Date.now(), value: list };
  return list;
}

export async function piaRegions(options) {
  const { regions } = await piaServerList(options);
  return regions.filter(region => region.servers?.wg?.length && !region.offline)
    .map(region => ({ value: region.id, label: `${region.name}${region.geo ? " (virtual)" : ""}` }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

const rawKey = (key, part) => Buffer.from(key.export({ format: "jwk" })[part], "base64url").toString("base64");

// Registers a fresh key with a PIA WireGuard server and returns a wg-quick style config.
export async function piaWireguardConfig({ username, password, region }, { fetchImpl = undiciFetch } = {}) {
  // A plain form body: undici's fetch would not serialize Node's global FormData.
  const tokenBody = new URLSearchParams({ username, password });
  const tokenResponse = await fetchImpl(tokenUrl, { method: "POST", body: tokenBody, signal: AbortSignal.timeout(20_000) });
  const tokenJson = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenJson.token) throw new DownloadError(tokenResponse.status === 401 ? "PIA rejected the username or password" : `PIA login failed (${tokenResponse.status})`);

  const { regions } = await piaServerList({ fetchImpl });
  const match = regions.find(item => item.id === region);
  if (!match?.servers?.wg?.length) throw new DownloadError(`PIA region ${region} has no WireGuard servers`);
  const server = match.servers.wg[Math.floor(Math.random() * match.servers.wg.length)];

  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const url = new URL(`https://${server.ip}:1337/addKey`);
  url.searchParams.set("pt", tokenJson.token); url.searchParams.set("pubkey", rawKey(publicKey, "x"));
  // PIA's own CA signs these servers; the certificate name is the server's common name, not its IP.
  const dispatcher = dispatcherFor(null, { ca: piaCA, servername: server.cn });
  let peer;
  try {
    const response = await fetchImpl(url, { dispatcher, signal: AbortSignal.timeout(20_000) });
    peer = await response.json();
  } catch (error) { throw new DownloadError(`PIA WireGuard server ${server.cn} could not be reached: ${error.cause?.message || error.message}`); }
  finally { dispatcher.close().catch(() => {}); }
  if (peer?.status !== "OK") throw new DownloadError(`PIA did not accept the WireGuard key${peer?.message ? `: ${peer.message}` : ""}`);
  return [
    "[Interface]", `Address = ${peer.peer_ip}`, `PrivateKey = ${rawKey(privateKey, "d")}`,
    ...(peer.dns_servers?.[0] ? [`DNS = ${peer.dns_servers[0]}`] : []),
    "", "[Peer]", `PublicKey = ${peer.server_key}`, "AllowedIPs = 0.0.0.0/0",
    `Endpoint = ${peer.server_ip || server.ip}:${peer.server_port}`, "PersistentKeepalive = 25", "",
  ].join("\n");
}
