import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const SCOPES = ["deploy", "logs"] as const;
export type Scope = (typeof SCOPES)[number];

export interface ApiKey {
  id: string;
  name: string;
  scopes: Scope[];
  /** sha256 of the secret part. The plaintext token is shown once at creation. */
  hash: string;
  createdAt: string;
}

const TOKEN_RE = /^hbr_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

/**
 * File-backed key store. The file is re-read on every lookup so that keys
 * created or revoked with the CLI take effect without restarting the relay.
 */
export class KeyStore {
  constructor(readonly path: string) {}

  async list(): Promise<ApiKey[]> {
    try {
      const data = JSON.parse(await readFile(this.path, "utf8")) as { keys?: ApiKey[] };
      return Array.isArray(data.keys) ? data.keys : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async create(name: string, scopes: Scope[]): Promise<{ key: ApiKey; token: string }> {
    if (!name.trim()) throw new Error("name is required");
    if (scopes.length === 0) throw new Error("at least one scope is required");
    const keys = await this.list();
    const id = randomBytes(6).toString("hex");
    const secret = randomBytes(32).toString("base64url");
    const key: ApiKey = {
      id,
      name: name.trim(),
      scopes: [...new Set(scopes)],
      hash: sha256(secret),
      createdAt: new Date().toISOString(),
    };
    await this.save([...keys, key]);
    return { key, token: `hbr_${id}_${secret}` };
  }

  async revoke(id: string): Promise<boolean> {
    const keys = await this.list();
    const next = keys.filter((k) => k.id !== id);
    if (next.length === keys.length) return false;
    await this.save(next);
    return true;
  }

  async verify(token: string): Promise<ApiKey | null> {
    const match = TOKEN_RE.exec(token);
    if (!match) return null;
    const key = (await this.list()).find((k) => k.id === match[1]);
    if (!key) return null;
    const expected = Buffer.from(key.hash, "hex");
    const actual = Buffer.from(sha256(match[2]!), "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual) ? key : null;
  }

  private async save(keys: ApiKey[]) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ keys }, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }
}
