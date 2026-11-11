/**
 * MISO's public market reports. Keyless: plain CSV files on docs.misoenergy.org, one per operating day,
 * with a row per node and report type and a column per hour ending.
 */
const REPORTS = "https://docs.misoenergy.org/marketreports/";

export const MISO_HUBS = new Set([
  "ARKANSAS.HUB", "ILLINOIS.HUB", "INDIANA.HUB", "LOUISIANA.HUB", "MICHIGAN.HUB", "MINN.HUB", "MS.HUB", "TEXAS.HUB",
]);

/** Node names are letters, digits and `. _ -`; anything else cannot be in the file. */
export function isMisoNodeName(point: string): boolean {
  return /^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(point);
}

export type MisoMarket = "day-ahead" | "real-time";

export type MisoResult =
  | { status: "ok"; price: number; report: string }
  | { status: "unknown_node" }
  | { status: "unpublished" };

interface Report {
  /** LMP row per node, upper-cased; index 0 is hour ending 1. */
  lmp: Map<string, (number | null)[]>;
  at: number;
}

const HOUR = 3_600_000;
/** Hours-ending are Eastern Standard Time all year round, with no daylight saving shift. */
const EST_OFFSET = -5 * HOUR;
/** Preliminary real-time files are replaced by the final file later, so do not keep them for long. */
const PRELIM_TTL_MS = 10 * 60_000;
const MISSING_TTL_MS = 60_000;

/** The EST operating day and hour ending (1 to 24) of the hour that contains `start`. */
export function misoHour(start: Date): { date: string; hourEnding: number } {
  const est = new Date(Math.floor((start.getTime() + EST_OFFSET) / HOUR) * HOUR);
  return { date: est.toISOString().slice(0, 10), hourEnding: est.getUTCHours() + 1 };
}

const REPORT_FILES: Record<MisoMarket, { file: string; title: RegExp; name: string }[]> = {
  "day-ahead": [{ file: "da_expost_lmp", title: /^Day Ahead Market ExPost LMPs/, name: "MISO Day-Ahead Market ExPost LMPs (da_expost_lmp)" }],
  // The final file appears weeks after the day; until then the preliminary file is the published value.
  "real-time": [
    { file: "rt_lmp_final", title: /^Realtime Market LMPs/, name: "MISO Real-Time Market final LMPs (rt_lmp_final)" },
    { file: "rt_lmp_prelim", title: /^Realtime Market LMPs/, name: "MISO Real-Time Market preliminary LMPs (rt_lmp_prelim)" },
  ],
};

export function createMiso(http: typeof fetch = fetch, now = () => Date.now()) {
  const reports = new Map<string, Report | null>();
  const missing = new Map<string, number>();
  const headers = { "user-agent": "Assize truth source (+https://github.com/nftkingiii)" };

  /** One report file, or null when MISO has not published it (404). */
  async function load(date: string, spec: (typeof REPORT_FILES)["day-ahead"][number]): Promise<Report | null> {
    const url = `${REPORTS}${date.replaceAll("-", "")}_${spec.file}.csv`;
    const hit = reports.get(url);
    if (hit && (spec.file !== "rt_lmp_prelim" || now() - hit.at < PRELIM_TTL_MS)) return hit;
    const gone = missing.get(url);
    if (gone !== undefined && now() - gone < MISSING_TTL_MS) return null;

    const res = await http(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) {
      missing.set(url, now());
      return null;
    }
    if (!res.ok) throw new Error(`MISO market report answered ${res.status}`);
    const lines = (await res.text()).split(/\r?\n/);
    if (!spec.title.test(lines[0] ?? "")) throw new Error("MISO market report was not the expected file");
    // Line 2 is the operating day, M/D/YYYY. A file for another day is never a stand-in.
    const [m, d, y] = (lines[1] ?? "").split("/");
    if (`${y}-${(m ?? "").padStart(2, "0")}-${(d ?? "").padStart(2, "0")}` !== date) return null;
    // Four preamble lines (title, day, blank, time-zone note), then the column header, then the rows.
    const header = lines.findIndex((line) => line.startsWith("Node,Type,Value,HE 1,"));
    if (header < 0 || header > 6) throw new Error("MISO market report has an unexpected header");

    const lmp = new Map<string, (number | null)[]>();
    for (const line of lines.slice(header + 1)) {
      const cells = line.split(",");
      if (cells[2]?.trim() !== "LMP") continue;
      lmp.set(
        (cells[0] ?? "").trim().toUpperCase(),
        Array.from({ length: 24 }, (_, i) => {
          const cell = (cells[3 + i] ?? "").trim();
          return cell === "" || !Number.isFinite(Number(cell)) ? null : Number(cell);
        }),
      );
    }
    if (reports.size > 12) reports.clear();
    const report = { lmp, at: now() };
    reports.set(url, report);
    return report;
  }

  return {
    /** The hourly LMP (not the MCC or MLC rows) for the EST hour that contains `start`. */
    async price(market: MisoMarket, point: string, start: Date): Promise<MisoResult> {
      const { date, hourEnding } = misoHour(start);
      let published = false;
      let found = false;
      for (const spec of REPORT_FILES[market]) {
        const report = await load(date, spec);
        if (!report) continue;
        published = true;
        const row = report.lmp.get(point);
        if (!row) continue;
        found = true;
        const price = row[hourEnding - 1];
        if (price !== null && price !== undefined) return { status: "ok", price, report: spec.name };
      }
      // A node absent from a file that was published does not exist; a missing hour or file is just unpublished.
      return published && !found ? { status: "unknown_node" } : { status: "unpublished" };
    },
  };
}

export type Miso = ReturnType<typeof createMiso>;
