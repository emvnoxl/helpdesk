import { createHmac, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/* Passwords: scrypt (memory-hard). Sessions: HMAC-signed tokens. Nothing here needs a cloud service. */

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const N = 2 ** 15, R = 8, P = 1;
const maxmem = 128 * N * R * 2;

const b64 = (b: Buffer) => b.toString("base64url");

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, { N, r: R, p: P, maxmem });
  return `scrypt:${N}:${R}:${P}:${b64(salt)}:${b64(key)}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [scheme, n, r, p, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64url");
  const got = await scrypt(password, Buffer.from(salt, "base64url"), want.length, { N: Number(n), r: Number(r), p: Number(p), maxmem });
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A readable temporary password (no look-alike characters), e.g. "kdm7-Xq4t-w9Pe-n3vA". */
export function randomPassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const group = () => Array.from({ length: 4 }, () => chars[randomInt(chars.length)]).join("");
  return [group(), group(), group(), group()].join("-");
}

/** token = base64url(JSON payload) + "." + base64url(HMAC-SHA256) */
export function signToken(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function readToken<T extends { e: number }>(token: string | undefined, secret: string): T | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const want = createHmac("sha256", secret).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    return payload.e > Math.floor(Date.now() / 1000) ? payload : null;
  } catch {
    return null;
  }
}

/** Small in-memory fixed-window limiter, keyed by e.g. client IP. Enough to blunt guessing and spam on one server. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private max: number, private windowMs: number) {}
  /** true = allowed */
  take(key: string): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.reset < now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
      return true;
    }
    h.n += 1;
    return h.n <= this.max;
  }
}
