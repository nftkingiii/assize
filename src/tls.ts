/**
 * SSL_VERIFICATION_CERT: is the TLS certificate of a host currently valid and trusted?
 * We open one TLS connection to port 443 with the system trust store and report what the handshake says.
 * The target must resolve to public addresses only, so the service cannot be pointed at private networks.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { connect } from "node:tls";

export interface TlsFacts {
  authorized: boolean;
  /** Why the chain or name was refused, when it was. */
  error: string | null;
  valid_from: string | null;
  valid_to: string | null;
  issuer: string | null;
  subject: string | null;
}

export type TlsProbe = (host: string) => Promise<TlsFacts>;

export function normalizeHost(raw: string): string | null {
  const host = raw.trim().replace(/\.$/, "").toLowerCase();
  if (!host || host.length > 253 || isIP(host)) return null;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
  return host;
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || address.startsWith("192.0.0."))) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  const v6 = address.toLowerCase();
  if (v6 === "::" || v6 === "::1" || v6.startsWith("fe80") || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("ff")) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  return mapped ? isPublicAddress(mapped[1]!) : true;
}

const label = (dn: unknown): string | null => {
  const o = dn as { CN?: string; O?: string } | undefined;
  return o?.CN ?? o?.O ?? null;
};

export const realProbe: TlsProbe = async (host) => {
  const addresses = await lookup(host, { all: true });
  if (addresses.length === 0 || !addresses.every((a) => isPublicAddress(a.address))) {
    throw new Error(`${host} does not resolve to a public address`);
  }
  return new Promise<TlsFacts>((resolve, reject) => {
    const socket = connect({ host: addresses[0]!.address, port: 443, servername: host, rejectUnauthorized: false, timeout: 15_000 }, () => {
      const cert = socket.getPeerCertificate();
      const facts: TlsFacts = {
        authorized: socket.authorized,
        error: socket.authorized ? null : String(socket.authorizationError),
        valid_from: cert?.valid_from ? new Date(cert.valid_from).toISOString() : null,
        valid_to: cert?.valid_to ? new Date(cert.valid_to).toISOString() : null,
        issuer: label(cert?.issuer),
        subject: label(cert?.subject),
      };
      socket.end();
      resolve(facts);
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error(`TLS handshake with ${host} timed out`));
    });
    socket.on("error", (e) => reject(new Error(`TLS handshake with ${host} failed: ${e.message}`)));
  });
};

export function createTls(probe: TlsProbe = realProbe, now: () => number = Date.now) {
  return {
    /** Valid means the handshake chained to a trusted root, the name matched, and the dates cover now. */
    async check(host: string): Promise<{ certificate_valid: boolean; checked_at: string } & TlsFacts> {
      const facts = await probe(host);
      const t = now();
      const inDates = !!facts.valid_from && !!facts.valid_to && Date.parse(facts.valid_from) <= t && t <= Date.parse(facts.valid_to);
      return { ...facts, certificate_valid: facts.authorized && inDates, checked_at: new Date(t).toISOString() };
    },
  };
}

export type Tls = ReturnType<typeof createTls>;
