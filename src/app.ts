import { CAISO_ALIASES, isCaisoNode, type Caiso } from "./caiso.ts";
import { isAddress, weiToGwei, type Chain } from "./chain.ts";
import { ERCOT_POINTS, type ErcotArchive } from "./ercot.ts";
import { FX_CURRENCIES, type Fx } from "./fx.ts";
import { parseInstant } from "./time.ts";

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
