import { inflateRawSync } from "node:zlib";

/** Reads the first file of a ZIP archive. Enough for ISO report downloads, which hold one CSV. */
export function firstFile(archive: Buffer): string {
  if (archive.readUInt32LE(0) !== 0x04034b50) throw new Error("not a zip archive");
  const method = archive.readUInt16LE(8);
  const nameLength = archive.readUInt16LE(26);
  const extraLength = archive.readUInt16LE(28);
  const start = 30 + nameLength + extraLength;

  // Sizes in the local header can be zero when a data descriptor follows, so use the central directory.
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("zip has no central directory");
  const central = archive.readUInt32LE(end + 16);
  const compressedSize = archive.readUInt32LE(central + 20);

  const data = archive.subarray(start, start + compressedSize);
  if (method === 0) return data.toString("utf8");
  if (method === 8) return inflateRawSync(data).toString("utf8");
  throw new Error(`unsupported zip compression method ${method}`);
}

/** Splits a simple CSV (no quoted commas, which these reports never use) into header-keyed rows. */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const header = (lines.shift() ?? "").split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  return lines.map((line) => {
    const cells = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}
