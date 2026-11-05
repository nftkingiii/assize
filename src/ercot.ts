import { addDays, wallClock } from "./time.ts";
import { firstFile, parseCsv } from "./zip.ts";

/**
 * ERCOT's public Market Information System archive. Keyless: these are the same reports ERCOT
 * publishes on ercot.com, not the authenticated Public API.
 */
const LIST = "https://www.ercot.com/misapp/servlets/IceDocListJsonWS?reportTypeId=";
const DOWNLOAD = "https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId=";
const REAL_TIME = 12301; // NP6-905-CD, settlement point prices, every 15 minutes
const DAY_AHEAD = 12331; // NP4-190-CD, day-ahead settlement point prices, daily

export const ERCOT_POINTS = new Set([
  "HB_BUSAVG", "HB_HOUSTON", "HB_HUBAVG", "HB_NORTH", "HB_PAN", "HB_SOUTH", "HB_WEST",
  "LZ_AEN", "LZ_CPS", "LZ_HOUSTON", "LZ_LCRA", "LZ_NORTH", "LZ_RAYBN", "LZ_SOUTH", "LZ_WEST",
]);

/** Load zones appear twice; `LZ` is the zone's settlement point price, `LZEW` its energy-weighted variant. */
const PREFERRED_TYPES = ["HU", "SH", "AH", "LZ"];

interface Doc {
  DocID: string;
  FriendlyName: string;
  PublishDate: string;
}

type Fetch = typeof fetch;

export function createErcotArchive(http: Fetch = fetch, now = () => Date.now()) {
  const lists = new Map<number, { at: number; docs: Doc[] }>();
  const files = new Map<string, Record<string, string>[]>();
  const headers = { "user-agent": "Assize truth source (+https://github.com/nftkingiii)" };

  async function list(reportType: number): Promise<Doc[]> {
    const hit = lists.get(reportType);
    if (hit && now() - hit.at < 60_000) return hit.docs;
    const res = await http(LIST + reportType, { headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`ERCOT archive list answered ${res.status}`);
    const body = (await res.json()) as { ListDocsByRptTypeRes?: { DocumentList?: { Document: Doc }[] } };
    const docs = (body.ListDocsByRptTypeRes?.DocumentList ?? []).map((d) => d.Document);
    lists.set(reportType, { at: now(), docs });
    return docs;
  }

  async function rows(doc: Doc): Promise<Record<string, string>[]> {
    const hit = files.get(doc.DocID);
    if (hit) return hit;
    const res = await http(DOWNLOAD + doc.DocID, { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`ERCOT archive download answered ${res.status}`);
    const parsed = parseCsv(firstFile(Buffer.from(await res.arrayBuffer())));
    if (files.size > 200) files.clear();
    files.set(doc.DocID, parsed);
    return parsed;
  }

  function pick(candidates: Record<string, string>[], point: string, priceColumn: string) {
    const matches = candidates.filter((r) => (r.SettlementPointName ?? r.SettlementPoint) === point);
    const ranked = [...matches].sort(
      (a, b) => rank(a.SettlementPointType) - rank(b.SettlementPointType),
    );
    const price = Number(ranked[0]?.[priceColumn]);
    return Number.isFinite(price) && ranked.length ? price : null;
  }
  const rank = (type?: string) => {
    const i = PREFERRED_TYPES.indexOf(type ?? "");
    return i < 0 ? PREFERRED_TYPES.length : i;
  };

  return {
    /** The real-time price for the 15-minute interval that starts at `start`, or null if unpublished. */
    async realTime(point: string, start: Date): Promise<number | null> {
      const end = new Date(Math.floor(start.getTime() / 900_000) * 900_000 + 900_000);
      const clock = wallClock(end, "America/Chicago");
      const stamp = `${clock.date.replaceAll("-", "")}_${String(clock.hour).padStart(2, "0")}${String(clock.minute).padStart(2, "0")}`;
      const doc = (await list(REAL_TIME)).find((d) => d.FriendlyName.includes(`_${stamp}_csv`));
      if (!doc) return null;
      return pick(await rows(doc), point, "SettlementPointPrice");
    },

    /** The day-ahead price for the hour that contains `start`, or null if unpublished. */
    async dayAhead(point: string, start: Date): Promise<number | null> {
      const clock = wallClock(start, "America/Chicago");
      const hourEnding = `${String(clock.hour + 1).padStart(2, "0")}:00`;
      const [y, m, d] = clock.date.split("-");
      const deliveryDate = `${m}/${d}/${y}`;
      // Day-ahead prices for date D are published on D-1.
      const publishedOn = addDays(clock.date, -1);
      const docs = (await list(DAY_AHEAD)).filter(
        (doc) => doc.FriendlyName.endsWith("_csv") && doc.PublishDate.startsWith(publishedOn),
      );
      for (const doc of docs) {
        const day = (await rows(doc)).filter((r) => r.DeliveryDate === deliveryDate && r.HourEnding === hourEnding);
        if (day.length) return pick(day, point, "SettlementPointPrice");
      }
      return null;
    },
  };
}

export type ErcotArchive = ReturnType<typeof createErcotArchive>;
