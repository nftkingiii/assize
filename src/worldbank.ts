/**
 * MACRO_ECONOMIC_INDICATOR: unemployment rate (% of total labour force, modeled ILO estimate, SL.UEM.TOTL.ZS)
 * from the World Bank Indicators API, which is keyless and published under CC BY 4.0.
 */
const BASE = "https://api.worldbank.org/v2";
const UA = "assize/0.1 (+https://assize.up.railway.app)";

interface Country {
  id: string;
  iso2Code: string;
  name: string;
  region: { value: string };
}

const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function createWorldBank(http: typeof fetch = fetch) {
  let countries: Promise<Country[]> | null = null;
  const cache = new Map<string, number>();

  async function json(url: string): Promise<unknown> {
    const res = await http(url, { headers: { accept: "application/json", "user-agent": UA }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`api.worldbank.org answered ${res.status}`);
    return res.json();
  }

  function loadCountries(): Promise<Country[]> {
    countries ??= json(`${BASE}/country?format=json&per_page=400`)
      .then((body) => {
        const rows = (body as [unknown, Country[]])?.[1];
        if (!Array.isArray(rows) || rows.length < 200) throw new Error("World Bank returned no country list");
        // Aggregates (World, Euro area, ...) are not countries.
        return rows.filter((c) => c.region?.value !== "Aggregates");
      })
      .catch((e) => {
        countries = null;
        throw e;
      });
    return countries;
  }

  return {
    /** The ISO3 code for an ISO2/ISO3 code or a country name as the World Bank spells it, or null. */
    async resolve(input: string): Promise<{ iso3: string; name: string } | null> {
      const list = await loadCountries();
      const key = norm(input);
      const hit = list.find((c) => norm(c.id) === key || norm(c.iso2Code) === key || norm(c.name) === key);
      return hit ? { iso3: hit.id, name: hit.name } : null;
    },
    /** The published value for that year, or null when the World Bank has none. */
    async unemployment(iso3: string, year: number): Promise<number | null> {
      const key = `${iso3}|${year}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const body = (await json(`${BASE}/country/${iso3}/indicator/SL.UEM.TOTL.ZS?format=json&date=${year}`)) as [{ total?: number } | undefined, { value: number | null; date: string }[] | null];
      if (!Array.isArray(body) || typeof body[0]?.total !== "number") throw new Error("World Bank returned an unreadable reply");
      const row = body[1]?.find((r) => r.date === String(year));
      const value = row && typeof row.value === "number" ? row.value : null;
      // A missing value may be filled by the next data release; only a published one is cached.
      if (value !== null) cache.set(key, value);
      return value;
    },
  };
}

export type WorldBank = ReturnType<typeof createWorldBank>;
