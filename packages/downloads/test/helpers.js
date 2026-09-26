import { createServer, connect } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempDataDir() {
  const dir = mkdtempSync(join(tmpdir(), "kiwi-downloads-"));
  process.env.KIWI_DATA_DIR = dir;
  return dir;
}

// Minimal SOCKS5 server (RFC 1928/1929) that records every destination it is asked to reach.
export async function startSocks({ username, password, port = 0 } = {}) {
  const requests = [];
  const server = createServer(socket => {
    socket.once("data", greeting => {
      const methods = [...greeting.subarray(2, 2 + greeting[1])];
      const method = username ? 2 : 0;
      if (!methods.includes(method)) return socket.end(Buffer.from([5, 0xff]));
      socket.write(Buffer.from([5, method]));
      const request = () => socket.once("data", data => {
        let host, offset;
        if (data[3] === 3) { host = data.subarray(5, 5 + data[4]).toString(); offset = 5 + data[4]; }
        else if (data[3] === 1) { host = [...data.subarray(4, 8)].join("."); offset = 8; }
        else { host = "ipv6"; offset = 20; }
        const targetPort = data.readUInt16BE(offset);
        requests.push({ host, port: targetPort });
        const upstream = connect({ host, port: targetPort }, () => {
          socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          socket.pipe(upstream); upstream.pipe(socket);
        });
        upstream.on("error", () => socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])));
        socket.on("error", () => upstream.destroy());
      });
      if (!username) return request();
      socket.once("data", auth => {
        const user = auth.subarray(2, 2 + auth[1]).toString();
        const pass = auth.subarray(3 + auth[1], 3 + auth[1] + auth[2 + auth[1]]).toString();
        const ok = user === username && pass === password;
        socket.write(Buffer.from([1, ok ? 0 : 1]));
        if (ok) request(); else socket.end();
      });
    });
    socket.on("error", () => {});
  });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  return { port: server.address().port, requests, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }) };
}

// Serves files from a map of path → Buffer | handler.
export async function startHttp(routes) {
  const server = createHttpServer((req, res) => {
    const route = routes[req.url.split("?")[0]];
    if (typeof route === "function") return route(req, res);
    if (!route) { res.writeHead(404); return res.end("missing"); }
    res.writeHead(200, { "content-length": route.length, "content-type": "application/octet-stream" });
    res.end(route);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

export async function until(check, timeout = 10_000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for condition");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
