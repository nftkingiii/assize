/**
 * Official central-bank reference rates against the US dollar, each from the bank that publishes it.
 * These are daily fixings, not intraday quotes; `as_of` says which day.
 */
export interface FxRate {
  rate: number;
  as_of: string;
  source: string;
}

export const FX_CURRENCIES = new Set(["CAD", "SEK", "EUR"]);

const DAY_MS = 86_400_000;

export function createFx(http: typeof fetch = fetch, ttlMs = 15 * 60_000) {
  const cache = new Map<string, { at: number; value: FxRate }>();

  async function text(url: string, accept: string): Promise<string> {
    // Name ourselves: Bank of Canada drops requests that carry no user agent.
    const res = await http(url, { headers: { accept, "user-agent": "assize/0.1 (+https://assize.up.railway.app)" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    const body = await res.text();
    if (!body.trim()) throw new Error(`${new URL(url).host} answered with an empty body`);
    return body;
  }

  const readers: Record<string, () => Promise<FxRate>> = {
    async CAD() {
      const body = JSON.parse(await text("https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1", "application/json"));
      const obs = body.observations?.[0];
      const rate = Number(obs?.FXUSDCAD?.v);
      if (!obs || !Number.isFinite(rate)) throw new Error("Bank of Canada returned no FXUSDCAD observation");
      return { rate, as_of: obs.d, source: "Bank of Canada Valet, FXUSDCAD daily average" };
    },
    async SEK() {
      const body = JSON.parse(await text("https://api.riksbank.se/swea/v1/Observations/Latest/SEKUSDPMI", "application/json"));
      const rate = Number(body.value);
      if (!Number.isFinite(rate)) throw new Error("Riksbank returned no SEKUSDPMI value");
      return { rate, as_of: body.date, source: "Sveriges Riksbank SWEA, SEKUSDPMI" };
    },
    async EUR() {
      const xml = await text("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml", "application/xml");
      const day = /time='(\d{4}-\d{2}-\d{2})'/.exec(xml)?.[1];
      const usdPerEur = Number(/currency='USD' rate='([\d.]+)'/.exec(xml)?.[1]);
      if (!day || !Number.isFinite(usdPerEur) || usdPerEur <= 0) throw new Error("ECB reference file has no USD rate");
      // The ECB publishes USD per EUR; the intent wants EUR per USD.
      return { rate: Number((1 / usdPerEur).toFixed(6)), as_of: day, source: "European Central Bank euro reference rate (1 / USD per EUR)" };
    },
  };

  return {
    /** How many units of `currency` one US dollar buys, from the latest official fixing. */
    async latest(currency: string): Promise<FxRate> {
      const hit = cache.get(currency);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value;
      const read = readers[currency];
      if (!read) throw new Error(`unsupported currency ${currency}`);
      const value = await read();
      if (Date.now() - Date.parse(value.as_of) > 7 * DAY_MS) throw new Error(`latest ${currency} fixing is stale (${value.as_of})`);
      cache.set(currency, { at: Date.now(), value });
      return value;
    },
  };
}

export type Fx = ReturnType<typeof createFx>;
