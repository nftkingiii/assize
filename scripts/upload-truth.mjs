// Uploads one truth-source YAML to a Telegraph evaluation pool, signed as the contributor.
// Usage: ASSIZE_EVM_PRIVATE_KEY=0x... node upload-truth.mjs <INTENT> <file.yaml>
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";

const NODE = process.env.TELEGRAPH_NODE_URL ?? "https://devnode.telegraphprotocol.com";
const CHAIN_ID = 11155111;
const [, , intent, file] = process.argv;
if (!intent || !file) throw new Error("usage: upload-truth.mjs <INTENT> <file.yaml>");

const account = privateKeyToAccount(process.env.ASSIZE_EVM_PRIVATE_KEY.trim());
const body = `${JSON.stringify({ label_kind: "truth_source", source: readFileSync(file, "utf8") })}\n`;
const nonce = randomBytes(16).toString("hex");
const message = [
  "Telegraph eval-pool submission v1",
  `intent_id: ${intent}`,
  `body_sha256: ${createHash("sha256").update(body).digest("hex")}`,
  `nonce: ${nonce}`,
  `chain_id: ${CHAIN_ID}`,
].join("\n");

const res = await fetch(`${NODE}/api/evalpool/submissions?intent_id=${intent}&submitter=${account.address}`, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-ndjson",
    "X-Evalpool-Signature": await account.signMessage({ message }),
    "X-Evalpool-Nonce": nonce,
  },
  body,
});
console.log(account.address, res.status, await res.text());
