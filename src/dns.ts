/**
 * DNS_RECORD_LOOKUP: does a name have at least one record of a type, asked of two public DNS-over-HTTPS resolvers.
 * Google Public DNS and Cloudflare 1.1.1.1 both offer keyless JSON endpoints. We only answer when both agree,
 * so a half-propagated change or a single resolver's glitch is a 502 rather than a guess.
 */
export const DNS_TYPES: Record<string, number> = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, CAA: 257 };

const UA = "assize/0.1 (+https://assize.up.railway.app)";

/** A DNS name in presentation form: dot-separated labels of 1-63 characters, 253 in all. Underscores allowed for SRV/TXT names. */
export function normalizeDnsName(raw: string): string | null {
  const name = raw.trim().replace(/\.$/, "").toLowerCase();
  if (!name || name.length > 253) return null;
  const labels = name.split(".");
  if (!labels.every((l) => /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/.test(l))) return null;
  return name;
}

interface DohReply {
  Status: number;
  Answer?: { type: number }[];
}

export function createDns(http: typeof fetch = fetch) {
  async function resolver(url: string, type: number): Promise<boolean> {
    const host = new URL(url).host;
    const res = await http(url, { headers: { accept: "application/dns-json", "user-agent": UA }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${host} answered ${res.status}`);
    const body = (await res.json()) as DohReply;
    if (typeof body?.Status !== "number") throw new Error(`${host} returned no DNS status`);
    // 0 NOERROR and 3 NXDOMAIN are answers; SERVFAIL, REFUSED and the rest are resolver failures, not "no record".
    if (body.Status !== 0 && body.Status !== 3) throw new Error(`${host} answered DNS status ${body.Status}`);
    // A CNAME chain precedes the records of the type asked for, so count only that type.
    return (body.Answer ?? []).some((a) => a.type === type);
  }

  return {
    /** True when the name has at least one record of `type`; throws when a resolver fails or the two disagree. */
    async hasRecord(name: string, type: string): Promise<{ has_record: boolean; resolvers: string[] }> {
      const code = DNS_TYPES[type];
      if (!code) throw new Error(`unsupported record type ${type}`);
      const q = `name=${encodeURIComponent(name)}&type=${type}`;
      const [google, cloudflare] = await Promise.all([
        resolver(`https://dns.google/resolve?${q}`, code),
        resolver(`https://cloudflare-dns.com/dns-query?${q}`, code),
      ]);
      if (google !== cloudflare) throw new Error("Google and Cloudflare resolvers disagree; refusing to answer");
      return { has_record: google, resolvers: ["dns.google", "cloudflare-dns.com"] };
    },
  };
}

export type Dns = ReturnType<typeof createDns>;
