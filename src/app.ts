import { CAISO_ALIASES, isCaisoNode, type Caiso } from "./caiso.ts";
import { isAddress, weiToGwei, type Chain } from "./chain.ts";
import { ERCOT_POINTS, type ErcotArchive } from "./ercot.ts";
import { DNS_TYPES, normalizeDnsName, type Dns } from "./dns.ts";
import { FX_CURRENCIES, type Fx } from "./fx.ts";
import { MISO_HUBS, isMisoNodeName, type Miso, type MisoMarket } from "./miso.ts";
import { NYISO_ZONES, nyisoZone, type Nyiso } from "./nyiso.ts";
import { parseInstant } from "./time.ts";
import { normalizeHost, type Tls } from "./tls.ts";
import type { WorldBank } from "./worldbank.ts";

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

/** One answer shape for every grid, matching GRID_POWER_PRICE_GENERAL's fields. */
export function createHandler(sources: { ercot: ErcotArchive; caiso: Caiso }) {
  return async function handle(query: URLSearchParams): Promise<Reply> {
    const raw = (query.get("node_or_zone") ?? "").trim();
    const point = raw.toUpperCase();
    const start = parseInstant(query.get("interval_start") ?? "");
    if (!start) {
      return { status: 400, body: { error: "interval_start_needs_a_timezone", example: "2026-11-03T08:00:00Z" } };
    }
    const ercot = ERCOT_POINTS.has(point);
    const caiso = !ercot && isCaisoNode(point);
    if (!ercot && !caiso) {
      return {
        status: 400,
        body: { error: "unknown_node_or_zone", ercot: [...ERCOT_POINTS], caiso: [...Object.keys(CAISO_ALIASES), "any CAISO APnode id"] },
      };
    }
    const market = (query.get("market") ?? (ercot ? "real-time" : "day-ahead")).toLowerCase();
    if (caiso && market !== "day-ahead") return { status: 400, body: { error: "caiso_day_ahead_only" } };
    if (market !== "real-time" && market !== "day-ahead") return { status: 400, body: { error: "unknown_market" } };

    try {
      const price = ercot
        ? market === "real-time"
          ? await sources.ercot.realTime(point, start)
          : await sources.ercot.dayAhead(point, start)
        : await sources.caiso.dayAhead(point, start);
      if (price === null) {
        return { status: 404, body: { error: "interval_not_published", node_or_zone: point, interval_start: start.toISOString() } };
      }
      return {
        status: 200,
        body: {
          lmp_usd_per_mwh: price,
          node_or_zone: point,
          market,
          interval_start: start.toISOString(),
          currency: "USD",
          iso: ercot ? "ERCOT" : "CAISO",
          source: ercot
            ? `ERCOT public MIS archive, ${market === "real-time" ? "NP6-905-CD" : "NP4-190-CD"}`
            : "CAISO OASIS PRC_LMP (DAM)",
        },
      };
    } catch (error) {
      return { status: 502, body: { error: (error as Error).message } };
    }
  };
}

/** GRID_POWER_PRICE_GENERAL for CAISO real-time: the LMP row of the 15-minute RTPD interval that starts at interval_start. */
export function createCaisoRtHandler(caiso: Caiso) {
  return async function handle(query: URLSearchParams): Promise<Reply> {
    const point = (query.get("node_or_zone") ?? "").trim().toUpperCase();
    const start = parseInstant(query.get("interval_start") ?? "");
    if (!start) {
      return { status: 400, body: { error: "interval_start_needs_a_timezone", example: "2026-11-03T08:00:00Z" } };
    }
    if (!isCaisoNode(point)) {
      return { status: 400, body: { error: "unknown_node_or_zone", caiso: [...Object.keys(CAISO_ALIASES), "any CAISO APnode id"] } };
    }
    if ((query.get("market") ?? "real-time").toLowerCase() !== "real-time") {
      return { status: 400, body: { error: "caiso_rt_real_time_only" } };
    }

    try {
      const price = await caiso.realTime(point, start);
      if (price === null) {
        return { status: 404, body: { error: "interval_not_published", node_or_zone: point, interval_start: start.toISOString() } };
      }
      return {
        status: 200,
        body: {
          lmp_usd_per_mwh: price,
          node_or_zone: point,
          market: "real-time",
          interval_start: start.toISOString(),
          currency: "USD",
          iso: "CAISO",
          source: "CAISO OASIS PRC_RTPD_LMP (RTPD, 15-minute)",
        },
      };
    } catch (error) {
      return { status: 502, body: { error: (error as Error).message } };
    }
  };
}

/** GRID_POWER_PRICE_GENERAL for MISO: the hourly LMP row from MISO's day-ahead ex-post or real-time report. */
export function createMisoHandler(miso: Miso) {
  return async function handle(query: URLSearchParams): Promise<Reply> {
    const point = (query.get("node_or_zone") ?? "").trim().toUpperCase();
    const start = parseInstant(query.get("interval_start") ?? "");
    if (!start) {
      return { status: 400, body: { error: "interval_start_needs_a_timezone", example: "2026-11-03T08:00:00Z" } };
    }
    if (!isMisoNodeName(point)) {
      return { status: 400, body: { error: "unknown_node_or_zone", miso: [...MISO_HUBS, "any node name in the MISO report"] } };
    }
    const market = (query.get("market") ?? "day-ahead").toLowerCase();
    if (market !== "day-ahead" && market !== "real-time") return { status: 400, body: { error: "unknown_market" } };

    try {
      const result = await miso.price(market as MisoMarket, point, start);
      if (result.status === "unknown_node") {
        return { status: 400, body: { error: "unknown_node_or_zone", node_or_zone: point, miso: [...MISO_HUBS, "any node name in the MISO report"] } };
      }
      if (result.status === "unpublished") {
        return { status: 404, body: { error: "interval_not_published", node_or_zone: point, interval_start: start.toISOString() } };
      }
      return {
        status: 200,
        body: {
          lmp_usd_per_mwh: result.price,
          node_or_zone: point,
          market,
          interval_start: start.toISOString(),
          currency: "USD",
          iso: "MISO",
          source: result.report,
        },
      };
    } catch (error) {
      return { status: 502, body: { error: (error as Error).message } };
    }
  };
}

/** GRID_POWER_PRICE_GENERAL for NYISO: the day-ahead zonal LBMP from NYISO's public MIS archive. */
export function createNyisoHandler(nyiso: Nyiso) {
  return async function handle(query: URLSearchParams): Promise<Reply> {
    const point = (query.get("node_or_zone") ?? "").trim().toUpperCase();
    const start = parseInstant(query.get("interval_start") ?? "");
    if (!start) {
      return { status: 400, body: { error: "interval_start_needs_a_timezone", example: "2026-11-03T08:00:00Z" } };
    }
    const zone = nyisoZone(point);
    if (!zone) return { status: 400, body: { error: "unknown_node_or_zone", nyiso: [...NYISO_ZONES] } };
    if ((query.get("market") ?? "day-ahead").toLowerCase() !== "day-ahead") {
      return { status: 400, body: { error: "nyiso_day_ahead_only" } };
    }

    try {
      const price = await nyiso.dayAhead(zone, start);
      if (price === null) {
        return { status: 404, body: { error: "interval_not_published", node_or_zone: zone, interval_start: start.toISOString() } };
      }
      return {
        status: 200,
        body: {
          lmp_usd_per_mwh: price,
          node_or_zone: zone,
          market: "day-ahead",
          interval_start: start.toISOString(),
          currency: "USD",
          iso: "NYISO",
          source: "NYISO Day-Ahead Market zonal LBMP (damlbmp_zone.csv)",
        },
      };
    } catch (error) {
      return { status: 502, body: { error: (error as Error).message } };
    }
  };
}

/** FX_NOW_{CAD,SEK,EUR}: units of `currency` per US dollar, from that currency's central bank. */
export function createFxHandler(fx: Fx) {
  return async function handle(query: URLSearchParams): Promise<Reply> {
    const currency = (query.get("currency") ?? "").trim().toUpperCase();
    if (!FX_CURRENCIES.has(currency)) {
      return { status: 400, body: { error: "unsupported_currency", supported: [...FX_CURRENCIES] } };
    }
    try {
      const { rate, as_of, source } = await fx.latest(currency);
      return { status: 200, body: { rate, currency, unit: `${currency} per USD`, as_of, source } };
    } catch (error) {
      return { status: 502, body: { error: (error as Error).message } };
    }
  };
}

/** ONCHAIN_METRIC_VERIFY_GENERAL: Ethereum mainnet ETH balance at a pinned block, in Gwei. */
export function createBalanceHandler(chain: Chain) {
  return async function handle(query: URLSearchParams): Promise<Reply> {
    const address = (query.get("address") ?? "").trim();
    const blockText = (query.get("block") ?? "").trim();
    if (!isAddress(address)) return { status: 400, body: { error: "address_must_be_0x_and_40_hex" } };
    if (!/^\d+$/.test(blockText)) return { status: 400, body: { error: "block_must_be_a_number" } };
    const block = Number(blockText);
    try {
      if (block > (await chain.head())) return { status: 404, body: { error: "block_not_mined_yet", block } };
      const wei = await chain.balanceAt(address, block);
      return {
        status: 200,
        body: { balance_gwei: weiToGwei(wei), balance_wei: wei.toString(), address, block, chain: "ethereum", source: "eth_getBalance on a public Ethereum archive RPC" },
      };
    } catch (error) {
      return { status: 502, body: { error: (error as Error).message } };
    }
  };
}

/** DNS_RECORD_LOOKUP_GENERAL: whether a name has at least one record of a type, with Google and Cloudflare DoH in agreement. */
export function createDnsHandler(dns: Dns) {
  return async function handle(query: URLSearchParams): Promise<Reply> {
    const name = normalizeDnsName(query.get("name") ?? "");
    if (!name) return { status: 400, body: { error: "name_must_be_a_dns_name" } };
    const type = (query.get("record_type") ?? "").trim().toUpperCase();
    if (!(type in DNS_TYPES)) return { status: 400, body: { error: "unsupported_record_type", supported: Object.keys(DNS_TYPES) } };
    try {
      const { has_record, resolvers } = await dns.hasRecord(name, type);
      return { status: 200, body: { has_record, name, record_type: type, source: `DNS over HTTPS: ${resolvers.join(" and ")} agree` } };
    } catch (error) {
      return { status: 502, body: { error: (error as Error).message } };
    }
  };
}

/** SSL_VERIFICATION_CERT: whether the host presents a currently valid certificate that chains to a trusted root. */
export function createTlsHandler(tls: Tls) {
  return async function handle(query: URLSearchParams): Promise<Reply> {
    const host = normalizeHost(query.get("host") ?? "");
    if (!host) return { status: 400, body: { error: "host_must_be_a_public_hostname" } };
    try {
      const r = await tls.check(host);
      return {
        status: 200,
        body: {
          certificate_valid: r.certificate_valid,
          host,
          checked_at: r.checked_at,
          valid_from: r.valid_from,
          valid_to: r.valid_to,
          issuer: r.issuer,
          reason: r.certificate_valid ? null : (r.error ?? "certificate dates do not cover now"),
          source: "live TLS handshake on port 443 against the Node.js system trust store",
        },
      };
    } catch (error) {
      return { status: 502, body: { error: (error as Error).message } };
    }
  };
}

/** MACRO_ECONOMIC_INDICATOR_GENERAL: World Bank unemployment rate (SL.UEM.TOTL.ZS) for a country and year. */
export function createWorldBankHandler(wb: WorldBank) {
  return async function handle(query: URLSearchParams): Promise<Reply> {
    const indicator = (query.get("indicator") ?? "unemployment rate").trim().toLowerCase();
    if (indicator !== "unemployment rate") return { status: 400, body: { error: "unsupported_indicator", supported: ["unemployment rate"] } };
    const yearText = (query.get("year") ?? "").trim();
    if (!/^\d{4}$/.test(yearText)) return { status: 400, body: { error: "year_must_be_four_digits" } };
    const year = Number(yearText);
    try {
      const country = await wb.resolve(query.get("country") ?? "");
      if (!country) return { status: 400, body: { error: "unknown_country", hint: "use a World Bank country name or ISO 3166 code" } };
      const rate = await wb.unemployment(country.iso3, year);
      if (rate === null) return { status: 404, body: { error: "no_published_value", country: country.iso3, year } };
      return {
        status: 200,
        body: { rate_pct: rate, country: country.iso3, country_name: country.name, year, indicator: "SL.UEM.TOTL.ZS", source: "World Bank Indicators API, SL.UEM.TOTL.ZS (modeled ILO estimate)" },
      };
    } catch (error) {
      return { status: 502, body: { error: (error as Error).message } };
    }
  };
}
