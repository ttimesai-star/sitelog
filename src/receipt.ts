import { binToHex, hexToBin, sha256, utf8ToBin } from '@bitauth/libauth';

/** OP_RETURN PUSH4 "LSH1" PUSH32 — the 7-byte prefix the contract enforces. */
export const RECEIPT_PREFIX_HEX = '6a044c53483120';
export const RECEIPT_LENGTH = 39;

/** Locking bytecode of the receipt output: OP_RETURN "LSH1" <requestHash32>. */
export function receiptLockingBytecode(requestHash: Uint8Array | string): Uint8Array {
  const h = typeof requestHash === 'string' ? hexToBin(requestHash) : requestHash;
  if (h.length !== 32) throw new Error('requestHash must be 32 bytes');
  const out = new Uint8Array(RECEIPT_LENGTH);
  out.set(hexToBin(RECEIPT_PREFIX_HEX), 0);
  out.set(h, 7);
  return out;
}

/** Returns the request hash (hex) if `lockingBytecode` is a well-formed LSH1 receipt, else undefined. */
export function parseReceipt(lockingBytecode: Uint8Array | string): string | undefined {
  const b = typeof lockingBytecode === 'string' ? hexToBin(lockingBytecode) : lockingBytecode;
  if (b.length !== RECEIPT_LENGTH) return undefined;
  if (binToHex(b.slice(0, 7)) !== RECEIPT_PREFIX_HEX) return undefined;
  return binToHex(b.slice(7));
}

/**
 * requestHash = sha256(challengeNonce || method || url || sha256(body)), the binding between a
 * paid HTTP request and its on-chain receipt. Fields are length-prefixed (1 byte for nonce and
 * method, 2 bytes BE for url) so different splits can never collide.
 */
export function computeRequestHash(args: { challengeNonce: string; method: string; url: string; body?: Uint8Array | string }): string {
  const nonce = hexToBin(args.challengeNonce);
  const method = utf8ToBin(args.method.toUpperCase());
  const url = utf8ToBin(args.url);
  const body = typeof args.body === 'string' ? utf8ToBin(args.body) : (args.body ?? new Uint8Array());
  if (nonce.length > 255 || method.length > 255 || url.length > 65535) throw new Error('request field too long');
  const parts = [
    Uint8Array.of(nonce.length), nonce,
    Uint8Array.of(method.length), method,
    Uint8Array.of(url.length >> 8, url.length & 0xff), url,
    sha256.hash(body),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return binToHex(sha256.hash(buf));
}
