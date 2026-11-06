/**
 * Ethereum mainnet balances at a pinned block, read with eth_getBalance from a keyless archive RPC.
 * A pinned block never changes, so answers are cached for good.
 */
const RPC = "https://eth.drpc.org";

export function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** Wei to Gwei, splitting with bigint first so the 9 fractional digits are not rounded away early. */
export function weiToGwei(wei: bigint): number {
  const whole = wei / 1_000_000_000n;
  const frac = (wei % 1_000_000_000n).toString().padStart(9, "0");
  return Number(`${whole}.${frac}`);
}

export function createChain(http: typeof fetch = fetch, rpc = RPC) {
  const cache = new Map<string, bigint>();

  async function call(method: string, params: unknown[]): Promise<string> {
    const res = await http(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Ethereum RPC answered ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`Ethereum RPC error: ${body.error.message}`);
    return body.result;
  }

  return {
    async head(): Promise<number> {
      return Number(BigInt(await call("eth_blockNumber", [])));
    },
    /** Balance in wei of `address` at the end of `block`. */
    async balanceAt(address: string, block: number): Promise<bigint> {
      const key = `${address.toLowerCase()}|${block}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const wei = BigInt(await call("eth_getBalance", [address, `0x${block.toString(16)}`]));
      if (cache.size > 50_000) cache.clear();
      cache.set(key, wei);
      return wei;
    },
  };
}

export type Chain = ReturnType<typeof createChain>;
