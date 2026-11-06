import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createBalanceHandler, createFxHandler, createHandler } from "../src/app.ts";
import { createCaiso, oasisTime } from "../src/caiso.ts";
import { createChain } from "../src/chain.ts";
import { createErcotArchive } from "../src/ercot.ts";
import { createFx } from "../src/fx.ts";
import { firstFile, parseCsv } from "../src/zip.ts";

// Real public files, downloaded 2026-11-05.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const ERCOT_RT = fixture("ercot-rt.zip"); // NP6-905, interval ending 03:15 CT on 5 Nov 2026
const ERCOT_DAM = fixture("ercot-dam.zip"); // NP4-190, delivery 5 Nov 2026, published 4 Nov
const CAISO_DAM = fixture("caiso-dam.zip"); // PRC_LMP DAM, NP15, 3 Nov 2026 08:00 UTC

const listing = (docs: object[]) => new Response(JSON.stringify({ ListDocsByRptTypeRes: { DocumentList: docs.map((d) => ({ Document: d })) } }));

const fakeHttp = (async (url: string) => {
  const u = String(url);
  if (u.includes("reportTypeId=12301")) {
    return listing([{ DocID: "rt1", FriendlyName: "SPPHLZNP6905_20261105_0315_csv", PublishDate: "2026-11-05T03:17:05-06:00" }]);
  }
  if (u.includes("reportTypeId=12331")) {
    return listing([
      { DocID: "dam-xml", FriendlyName: "DAMSPNP4190_xml", PublishDate: "2026-11-04T12:32:44-06:00" },
      { DocID: "dam1", FriendlyName: "DAMSPNP4190_csv", PublishDate: "2026-11-04T12:32:44-06:00" },
    ]);
  }
  if (u.includes("doclookupId=rt1")) return new Response(ERCOT_RT);
  if (u.includes("doclookupId=dam1")) return new Response(ERCOT_DAM);
  if (u.includes("oasis.caiso.com")) return new Response(CAISO_DAM);
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const handle = createHandler({ ercot: createErcotArchive(fakeHttp), caiso: createCaiso(fakeHttp, 0) });
const ask = (q: Record<string, string>) => handle(new URLSearchParams(q));

test("reads the CSV out of a real ISO zip", () => {
  const rows = parseCsv(firstFile(ERCOT_RT));
  assert.ok(rows.length > 1000);
  assert.deepEqual(Object.keys(rows[0]!).slice(0, 4), ["DeliveryDate", "DeliveryHour", "DeliveryInterval", "SettlementPointName"]);
});

test("ERCOT real-time: picks the file whose stamp is the interval end", async () => {
  // 03:00-03:15 CT on 5 Nov 2026 is 09:00 UTC (CST).
  const { status, body } = await ask({ node_or_zone: "HB_WEST", interval_start: "2026-11-05T09:00:00Z" });
  assert.equal(status, 200);
  assert.equal(body.lmp_usd_per_mwh, 15.34);
  assert.equal(body.iso, "ERCOT");
});

test("ERCOT load zones use the LZ price, not the energy-weighted LZEW row", async () => {
  const { body } = await ask({ node_or_zone: "lz_west", interval_start: "2026-11-05T09:00:00Z" });
  const rows = parseCsv(firstFile(ERCOT_RT)).filter((r) => r.SettlementPointName === "LZ_WEST" && r.SettlementPointType === "LZ");
  assert.equal(body.lmp_usd_per_mwh, Number(rows[0]!.SettlementPointPrice));
});

test("ERCOT real-time: an interval with no published file is 404, never a neighbour", async () => {
  const { status, body } = await ask({ node_or_zone: "HB_WEST", interval_start: "2026-11-05T09:15:00Z" });
  assert.equal(status, 404);
  assert.equal(body.lmp_usd_per_mwh, undefined);
});

test("ERCOT day-ahead: reads hour ending 01 of the delivery date", async () => {
  // 00:00-01:00 CT on 5 Nov 2026 is 06:00 UTC.
  const { status, body } = await ask({ node_or_zone: "HB_WEST", market: "day-ahead", interval_start: "2026-11-05T06:00:00Z" });
  assert.equal(status, 200);
  assert.equal(body.lmp_usd_per_mwh, 10.38);
});

test("CAISO day-ahead: reads the LMP row for the hour, and accepts the NP15 alias", async () => {
  const { status, body } = await ask({ node_or_zone: "NP15", interval_start: "2026-11-03T08:30:00Z" });
  assert.equal(status, 200);
  assert.equal(body.lmp_usd_per_mwh, 56.42108);
  assert.equal(body.iso, "CAISO");
});

test("formats OASIS times the way OASIS expects", () => {
  assert.equal(oasisTime(new Date("2026-11-03T08:00:00Z")), "20261103T08:00-0000");
});

test("retries CAISO once after a 429", async () => {
  let calls = 0;
  const flaky = (async () => (++calls === 1 ? new Response("", { status: 429 }) : new Response(CAISO_DAM))) as unknown as typeof fetch;
  const price = await createCaiso(flaky, 0).dayAhead("NP15", new Date("2026-11-03T08:00:00Z"));
  assert.equal(price, 56.42108);
  assert.equal(calls, 2);
});

test("rejects unknown nodes, times without a zone, and CAISO real-time", async () => {
  assert.equal((await ask({ node_or_zone: "XYZ", interval_start: "2026-11-05T09:00:00Z" })).status, 400);
  assert.equal((await ask({ node_or_zone: "HB_WEST", interval_start: "2026-11-05T09:00:00" })).status, 400);
  assert.equal((await ask({ node_or_zone: "NP15", market: "real-time", interval_start: "2026-11-03T08:00:00Z" })).status, 400);
});

// Real central-bank responses, downloaded 2026-11-06 (fixing date 5 Nov 2026).
const fxHttp = (async (url: string) => {
  const u = String(url);
  if (u.includes("bankofcanada.ca")) return new Response(fixture("boc-fxusdcad.json"));
  if (u.includes("riksbank.se")) return new Response(fixture("riksbank-sekusdpmi.json"));
  if (u.includes("ecb.europa.eu")) return new Response(fixture("ecb-daily.xml"));
  return new Response("not found", { status: 404 });
}) as typeof fetch;
const fx = createFxHandler(createFx(fxHttp));
const askFx = (currency: string) => fx(new URLSearchParams({ currency }));

test("FX: Bank of Canada and Riksbank already quote per US dollar", async () => {
  const cad = await askFx("cad");
  assert.equal(cad.status, 200);
  assert.equal(cad.body.unit, "CAD per USD");
  assert.equal(cad.body.as_of, "2026-11-05");
  assert.ok((cad.body.rate as number) > 1 && (cad.body.rate as number) < 2);
  const sek = await askFx("SEK");
  assert.deepEqual([sek.body.rate, sek.body.as_of], [9.78662, "2026-11-05"]);
});

test("FX: the ECB's USD per EUR is inverted to EUR per USD", async () => {
  const eur = await askFx("EUR");
  assert.equal(eur.body.rate, Number((1 / 1.1224).toFixed(6)));
});

test("FX: unsupported currencies and stale fixings are refused", async () => {
  assert.equal((await askFx("JPY")).status, 400);
  const old = createFxHandler(createFx((async () => new Response('{"date":"2026-10-01","value":9.1}')) as typeof fetch));
  const reply = await old(new URLSearchParams({ currency: "SEK" }));
  assert.equal(reply.status, 502);
  assert.match(String(reply.body.error), /stale/);
});

// eth_getBalance for vitalik.eth at block 0x1500000, recorded from eth.drpc.org on 2026-11-06.
const rpcHttp = (async (_url: string, init?: RequestInit) => {
  const { method, params } = JSON.parse(String(init?.body));
  if (method === "eth_blockNumber") return Response.json({ jsonrpc: "2.0", id: 1, result: "0x19225a9" });
  if (method === "eth_getBalance" && params[1] === "0x1500000") return Response.json({ jsonrpc: "2.0", id: 1, result: "0x25fefa1a9e54db1f7c" });
  return Response.json({ jsonrpc: "2.0", id: 1, error: { message: "unexpected" } });
}) as typeof fetch;
const balance = createBalanceHandler(createChain(rpcHttp));
const askBalance = (q: Record<string, string>) => balance(new URLSearchParams(q));

test("balance: wei at a pinned block becomes exact Gwei", async () => {
  const reply = await askBalance({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", block: String(0x1500000) });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.balance_wei, "700902557624395571068");
  assert.equal(reply.body.balance_gwei, 700902557624.395571068);
});

test("balance: bad addresses, bad blocks and future blocks are refused", async () => {
  assert.equal((await askBalance({ address: "0x123", block: "1" })).status, 400);
  assert.equal((await askBalance({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", block: "latest" })).status, 400);
  assert.equal((await askBalance({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", block: String(0x19225a9 + 10) })).status, 404);
});
