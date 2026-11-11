import { wallClock } from "./time.ts";
import { parseCsv } from "./zip.ts";

/** NYISO's public MIS CSV archive. Keyless: one day-ahead zonal LBMP file per day. */
const DAY_AHEAD = "https://mis.nyiso.com/public/csv/damlbmp/";
const TIME_ZONE = "America/New_York";
const HOUR = 3_600_000;

export const NYISO_ZONES = new Set([
  "CAPITL", "CENTRL", "DUNWOD", "GENESE", "H Q", "HUD VL", "LONGIL", "MHK VL", "MILLWD", "N.Y.C.", "NORTH", "NPX", "O H", "PJM", "WEST",
]);

/** Common spellings of zones whose official names are awkward in a URL. */
export const NYISO_ALIASES: Record<string, string> = {
  NYC: "N.Y.C.",
  HQ: "H Q",
  HUD_VL: "HUD VL",
  MHK_VL: "MHK VL",
  OH: "O H",
};

export function nyisoZone(point: string): string | null {
  const zone = NYISO_ALIASES[point] ?? point;
  return NYISO_ZONES.has(zone) ? zone : null;
}

export function createNyiso(http: typeof fetch = fetch, now = () => Date.now()) {
  const files = new Map<string, Record<string, string>[]>();
  const missing = new Map<string, number>();
  const headers = { "user-agent": "Assize truth source (+https://github.com/nftkingiii)" };

  /** The day's rows in file order, or null when NYISO has not published the file. */
  async function day(date: string): Promise<Record<string, string>[] | null> {
    const hit = files.get(date);
    if (hit) return hit;
    const gone = missing.get(date);
    if (gone !== undefined && now() - gone < 60_000) return null;

    const res = await http(`${DAY_AHEAD}${date.replaceAll("-", "")}damlbmp_zone.csv`, { headers, signal: AbortSignal.timeout(30_000) });
    const text = res.ok ? await res.text() : "";
    // NYISO answers a missing day with an error page, not necessarily a 404.
    if (!text.startsWith("Time Stamp,Name,PTID,LBMP ($/MWHr)")) {
      if (res.ok || res.status === 404) {
        missing.set(date, now());
        return null;
      }
      throw new Error(`NYISO MIS answered ${res.status}`);
    }
    const rows = parseCsv(text);
    if (files.size > 30) files.clear();
    files.set(date, rows);
    return rows;
  }

  return {
    /**
     * The day-ahead zonal LBMP for the Eastern hour that contains `start`, or null if unpublished.
     * Timestamps are hour-beginning Eastern prevailing time, so on the November clock change the
     * label 01:00 appears twice: the first row is EDT and the second is EST.
     */
    async dayAhead(zone: string, start: Date): Promise<number | null> {
      const hour = new Date(Math.floor(start.getTime() / HOUR) * HOUR);
      const clock = wallClock(hour, TIME_ZONE);
      const before = wallClock(new Date(hour.getTime() - HOUR), TIME_ZONE);
      const repeated = before.date === clock.date && before.hour === clock.hour;

      const rows = await day(clock.date);
      if (!rows) return null;
      const [y, m, d] = clock.date.split("-");
      const label = `${m}/${d}/${y} ${String(clock.hour).padStart(2, "0")}:00`;
      const matches = rows.filter((r) => r.Name === zone && r["Time Stamp"] === label);
      const price = Number(matches[repeated ? 1 : 0]?.["LBMP ($/MWHr)"]);
      return matches[repeated ? 1 : 0] && Number.isFinite(price) ? price : null;
    },
  };
}

export type Nyiso = ReturnType<typeof createNyiso>;
