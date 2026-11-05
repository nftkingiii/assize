import { CAISO_ALIASES, isCaisoNode, type Caiso } from "./caiso.ts";
import { ERCOT_POINTS, type ErcotArchive } from "./ercot.ts";
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
