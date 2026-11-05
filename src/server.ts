import { createServer } from "node:http";
import { createHandler } from "./app.ts";
import { createCaiso } from "./caiso.ts";
import { createErcotArchive } from "./ercot.ts";

const handle = createHandler({ ercot: createErcotArchive(), caiso: createCaiso() });

const LIMIT_PER_MINUTE = 60;
const hits = new Map<string, { count: number; reset: number }>();
function allowed(ip: string): boolean {
  const now = Date.now();
  const hit = hits.get(ip);
  if (!hit || hit.reset < now) {
    if (hits.size > 10_000) hits.clear();
    hits.set(ip, { count: 1, reset: now + 60_000 });
    return true;
  }
  return ++hit.count <= LIMIT_PER_MINUTE;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://assize");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "GET") return send(405, { error: "method_not_allowed" });
  if (url.pathname === "/health") return send(200, { status: "ok" });
  // One path per grid, so each truth source upload is a distinct endpoint.
  const only = { "/price": null, "/ercot/price": "ERCOT", "/caiso/price": "CAISO" }[url.pathname];
  if (only === undefined) return send(404, { error: "not_found" });
  const forwarded = req.headers["x-real-ip"];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? req.socket.remoteAddress ?? "unknown";
  if (!allowed(ip)) return send(429, { error: "rate_limited" });
  const { status, body } = await handle(url.searchParams);
  if (only && status === 200 && body.iso !== only) {
    return send(400, { error: `this path serves ${only} nodes only`, node_or_zone: body.node_or_zone });
  }
  send(status, body);
}).listen(Number(process.env.PORT ?? 8095), () => console.log("assize listening"));
