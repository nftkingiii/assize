import { firstFile, parseCsv } from "./zip.ts";

/** CAISO OASIS. Keyless; answers with a ZIP holding one CSV. */
const OASIS = "https://oasis.caiso.com/oasisapi/SingleZip";

/** Trading hub aliases. Any other node id is passed through as written. */
export const CAISO_ALIASES: Record<string, string> = {
  NP15: "TH_NP15_GEN-APND",
  SP15: "TH_SP15_GEN-APND",
  ZP26: "TH_ZP26_GEN-APND",
};

export function isCaisoNode(point: string): boolean {
  return point in CAISO_ALIASES || /-APND$|_APND$|-ASR-APND$/.test(point) || /^TH_/.test(point);
}

/** OASIS wants `20261103T08:00-0000`. */
export function oasisTime(d: Date): string {
  const s = d.toISOString();
  return `${s.slice(0, 4)}${s.slice(5, 7)}${s.slice(8, 10)}T${s.slice(11, 16)}-0000`;
}

/** OASIS refuses bursts with 429; keep at least this long between requests. */
const MIN_GAP_MS = 5_500;

export function createCaiso(http: typeof fetch = fetch, gapMs = MIN_GAP_MS) {
  const cache = new Map<string, number | null>();
  let nextSlot = 0;

  async function call(url: string): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const wait = Math.max(0, nextSlot - Date.now());
      nextSlot = Math.max(Date.now(), nextSlot) + gapMs;
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      const res = await http(url, { signal: AbortSignal.timeout(30_000) });
      if (res.status !== 429) return res;
    }
    throw new Error("CAISO OASIS is rate limiting; try again shortly");
  }
  return {
    /** Day-ahead LMP for the hour that contains `start`, or null if OASIS has none. */
    async dayAhead(point: string, start: Date): Promise<number | null> {
      const node = CAISO_ALIASES[point] ?? point;
      const hour = new Date(Math.floor(start.getTime() / 3_600_000) * 3_600_000);
      const key = `${node}|${hour.toISOString()}`;
      if (cache.has(key)) return cache.get(key) ?? null;

      const query = new URLSearchParams({
        queryname: "PRC_LMP",
        market_run_id: "DAM",
        startdatetime: oasisTime(hour),
        enddatetime: oasisTime(new Date(hour.getTime() + 3_600_000)),
        version: "12",
        node,
        resultformat: "6",
      });
      const res = await call(`${OASIS}?${query}`);
      if (!res.ok) throw new Error(`CAISO OASIS answered ${res.status}`);
      const archive = Buffer.from(await res.arrayBuffer());
      // OASIS reports errors as an XML file inside the ZIP.
      const text = firstFile(archive);
      if (!text.startsWith("INTERVALSTARTTIME_GMT")) {
        cache.set(key, null);
        return null;
      }
      const row = parseCsv(text).find(
        (r) => r.LMP_TYPE === "LMP" && r.NODE === node && new Date(r.INTERVALSTARTTIME_GMT ?? "").getTime() === hour.getTime(),
      );
      const price = row ? Number(row.MW) : NaN;
      const value = Number.isFinite(price) ? price : null;
      if (cache.size > 2_000) cache.clear();
      cache.set(key, value);
      return value;
    },
  };
}

export type Caiso = ReturnType<typeof createCaiso>;
