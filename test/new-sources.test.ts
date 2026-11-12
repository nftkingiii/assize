import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createDnsHandler, createTlsHandler, createWorldBankHandler } from "../src/app.ts";
import { createDns } from "../src/dns.ts";
import { createTls, isPublicAddress, normalizeHost, type TlsFacts } from "../src/tls.ts";
import { createWorldBank } from "../src/worldbank.ts";

// Real public responses, recorded 2026-11-12.
const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const json = (body: string, status = 200) => new Response(body, { status });

// ---- DNS over HTTPS ----
const dnsFixtures: Record<string, [string, string]> = {
  "example.com|A": ["dns-google-example-a.json", "dns-cf-example-a.json"],
  "example.com|MX": ["dns-google-example-mx.json", "dns-cf-example-mx.json"],
  "nxdomain-assize-test.invalid|A": ["dns-google-nxdomain.json", "dns-cf-nxdomain.json"],
  "www.github.com|CNAME": ["dns-google-cname.json", "dns-cf-cname.json"],
};
const dnsHttp = (async (url: string) => {
  const u = new URL(url);
  const key = `${u.searchParams.get("name")}|${u.searchParams.get("type")}`;
  const pair = dnsFixtures[key];
  if (!pair) return json("{}", 500);
  return json(fx(u.host === "dns.google" ? pair[0] : pair[1]));
}) as typeof fetch;
const askDns = (q: Record<string, string>) => createDnsHandler(createDns(dnsHttp))(new URLSearchParams(q));

test("DNS: a record that exists is true, from two agreeing resolvers", async () => {
  const { status, body } = await askDns({ name: "Example.com.", record_type: "a" });
  assert.equal(status, 200);
  assert.equal(body.has_record, true);
  assert.equal(body.name, "example.com");
  assert.equal(body.record_type, "A");
  assert.equal((await askDns({ name: "example.com", record_type: "MX" })).body.has_record, true);
});

test("DNS: NXDOMAIN is false, and a CNAME does not count as an A record", async () => {
  assert.equal((await askDns({ name: "nxdomain-assize-test.invalid", record_type: "A" })).body.has_record, false);
  assert.equal((await askDns({ name: "www.github.com", record_type: "CNAME" })).body.has_record, true);
});

test("DNS: disagreement or a failing resolver is a 502, bad input a 400", async () => {
  const split = (async (url: string) => {
    const u = new URL(url);
    return json(fx(u.host === "dns.google" ? "dns-google-example-a.json" : "dns-cf-nxdomain.json"));
  }) as typeof fetch;
  const disagree = await createDnsHandler(createDns(split))(new URLSearchParams({ name: "example.com", record_type: "A" }));
  assert.equal(disagree.status, 502);
  const servfail = (async () => json(JSON.stringify({ Status: 2 }))) as typeof fetch;
  assert.equal((await createDnsHandler(createDns(servfail))(new URLSearchParams({ name: "example.com", record_type: "A" }))).status, 502);
  assert.equal((await askDns({ name: "bad name!", record_type: "A" })).status, 400);
  assert.equal((await askDns({ name: "example.com", record_type: "DNSKEY" })).status, 400);
});

// ---- TLS ----
const recorded = JSON.parse(fx("tls-probes.json")) as { recorded_at: string; probes: Record<string, TlsFacts> };
const RECORDED_AT = Date.parse(recorded.recorded_at);
const tlsFor = (nowMs: number) => createTlsHandler(createTls(async (h) => recorded.probes[h]!, () => nowMs));
const askTls = (host: string, nowMs = RECORDED_AT) => tlsFor(nowMs)(new URLSearchParams({ host }));

test("TLS: trusted, in-date certificates are valid", async () => {
  for (const host of ["example.com", "github.com"]) {
    const { status, body } = await askTls(host);
    assert.equal(status, 200);
    assert.equal(body.certificate_valid, true, host);
    assert.equal(body.reason, null);
  }
});

test("TLS: expired, self-signed, wrong-host and untrusted-root certificates are invalid with the reason", async () => {
  const reasons: Record<string, string> = {
    "expired.badssl.com": "CERT_HAS_EXPIRED",
    "self-signed.badssl.com": "DEPTH_ZERO_SELF_SIGNED_CERT",
    "wrong.host.badssl.com": "ERR_TLS_CERT_ALTNAME_INVALID",
    "untrusted-root.badssl.com": "SELF_SIGNED_CERT_IN_CHAIN",
  };
  for (const [host, reason] of Object.entries(reasons)) {
    const { body } = await askTls(host);
    assert.equal(body.certificate_valid, false, host);
    assert.equal(body.reason, reason);
  }
});

test("TLS: a trusted chain whose dates do not cover now is invalid (clock past not-after, and before not-before)", async () => {
  assert.equal((await askTls("example.com", Date.parse("2027-01-01T00:00:00Z"))).body.certificate_valid, false);
  assert.equal((await askTls("example.com", Date.parse("2026-01-01T00:00:00Z"))).body.certificate_valid, false);
});

test("TLS: refuses IP literals, single labels and private addresses; a failed handshake is a 502", async () => {
  assert.equal(normalizeHost("10.0.0.1"), null);
  assert.equal(normalizeHost("localhost"), null);
  assert.equal(normalizeHost("https://example.com"), null);
  assert.equal(normalizeHost("Example.COM."), "example.com");
  for (const a of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPublicAddress(a), false, a);
  }
  assert.equal(isPublicAddress("93.184.216.34"), true);
  assert.equal(isPublicAddress("2606:4700::1111"), true);
  const failing = createTlsHandler(createTls(async () => { throw new Error("TLS handshake with x.example failed: ECONNREFUSED"); }));
  assert.equal((await failing(new URLSearchParams({ host: "x.example" }))).status, 502);
  assert.equal((await askTls("1.2.3.4")).status, 400);
});

// ---- World Bank ----
const wbHttp = (async (url: string) => {
  const u = String(url);
  if (u.includes("/country?")) return json(fx("worldbank-countries.json"));
  if (u.includes("/country/DEU/") && u.includes("date=2023")) return json(fx("worldbank-unemp-deu-2023.json"));
  if (u.includes("/country/DEU/") && u.includes("date=2030")) return json(fx("worldbank-unemp-deu-2030.json"));
  return json("{}", 500);
}) as typeof fetch;
const askWb = (q: Record<string, string>) => createWorldBankHandler(createWorldBank(wbHttp))(new URLSearchParams(q));

test("World Bank: unemployment for a country by name, ISO2 or ISO3", async () => {
  for (const country of ["Germany", "DE", "deu"]) {
    const { status, body } = await askWb({ indicator: "unemployment rate", country, year: "2023" });
    assert.equal(status, 200, country);
    assert.equal(body.rate_pct, 3.071);
    assert.equal(body.country, "DEU");
  }
});

test("World Bank: a year with no value is 404, an unknown country or odd input is 400, aggregates are not countries", async () => {
  assert.equal((await askWb({ country: "Germany", year: "2030" })).status, 404);
  assert.equal((await askWb({ country: "Atlantis", year: "2023" })).status, 400);
  assert.equal((await askWb({ country: "World", year: "2023" })).status, 400);
  assert.equal((await askWb({ country: "Germany", year: "23" })).status, 400);
  assert.equal((await askWb({ indicator: "gdp", country: "Germany", year: "2023" })).status, 400);
  assert.equal((await askWb({ country: "Germany", year: "2021" })).status, 502);
});
