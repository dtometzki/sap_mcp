import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Credentials } from "../autoLogin.js";
import { isUsableStorageState, type SessionState } from "../session.js";

export class WebError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}
export const locked = (): WebError => new WebError("LOCKED", "Bitte die App entsperren.", 401);
export const credentialsSchema = z.object({ username: z.string().trim().min(1).max(254), password: z.string().min(1).max(1024) }).strict();
export const masterSchema = z.string().min(12, "Mindestens 12 Zeichen verwenden.").max(1024);
export const historySchema = z.object({ id: z.string().uuid(), query: z.string().min(2).max(500), limit: z.number().int().min(1).max(25), count: z.number().int().min(0).max(25), at: z.string().datetime() });
export type HistoryEntry = z.infer<typeof historySchema>;
export interface VaultData { credentials?: Credentials; session?: SessionState; history: HistoryEntry[] }
const dataSchema = z.object({ credentials: credentialsSchema.optional(), session: z.custom<SessionState>(isUsableStorageState).optional(), history: z.array(historySchema) }).strict();
const envelopeSchema = z.object({ version: z.literal(1), salt: z.string().regex(/^[a-f0-9]{32}$/), iv: z.string().regex(/^[a-f0-9]{24}$/), tag: z.string().regex(/^[a-f0-9]{32}$/), ciphertext: z.string().regex(/^[a-f0-9]+$/) }).strict();
const aad = Buffer.from("sap-notes-web:v1");
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}

/** One encrypted document, atomic replacement, and an in-process mutation queue. */
export class Vault {
  private key?: Buffer;
  private salt?: Buffer;
  private data?: VaultData;
  private epoch = 0;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly path: string) {}
  get unlocked(): boolean { return this.key !== undefined && this.data !== undefined; }
  async exists(): Promise<boolean> {
    try { await readFile(this.path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  snapshot(): VaultData {
    if (!this.data || !this.key) throw locked();
    return structuredClone(this.data);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.then(fn);
    this.queue = task.catch(() => undefined);
    return task;
  }
  private async write(data: VaultData, key: Buffer, salt: Buffer, exclusive = false): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    cipher.setAAD(aad);
    const clear = Buffer.from(JSON.stringify(data));
    let ciphertext: Buffer;
    try { ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]); }
    finally { clear.fill(0); }
    const payload = JSON.stringify({ version: 1, salt: salt.toString("hex"), iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") });
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    const temporary = `${this.path}.${randomBytes(12).toString("hex")}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(payload);
        await file.sync();
      } finally { await file.close(); }
      if (exclusive && await this.exists()) throw new WebError("EXISTS", "Der Tresor existiert bereits.", 409);
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }
  async setup(password: string): Promise<void> {
    const epoch = this.epoch;
    return this.serial(async () => {
      if (await this.exists()) throw new WebError("EXISTS", "Der Tresor existiert bereits.", 409);
      const salt = randomBytes(16);
      const key = await derive(masterSchema.parse(password), salt);
      try {
        if (epoch !== this.epoch) throw locked();
        const data = { history: [] };
        await this.write(data, key, salt, true);
        if (epoch !== this.epoch) throw locked();
        this.key = Buffer.from(key); this.salt = salt; this.data = data;
      } finally { key.fill(0); }
    });
  }
  async unlock(password: string): Promise<void> {
    const epoch = this.epoch;
    return this.serial(async () => {
      // Bound input even when callers bypass the HTTP schema.
      masterSchema.parse(password);
      let key: Buffer | undefined;
      try {
        const envelope = envelopeSchema.parse(JSON.parse(await readFile(this.path, "utf8")) as unknown);
        const salt = Buffer.from(envelope.salt, "hex");
        key = await derive(password, salt);
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "hex"), { authTagLength: 16 });
        decipher.setAAD(aad);
        decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
        const clear = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "hex")), decipher.final()]);
        let data: VaultData;
        try { data = dataSchema.parse(JSON.parse(clear.toString("utf8")) as unknown); }
        finally { clear.fill(0); }
        if (epoch !== this.epoch) throw locked();
        this.key?.fill(0); this.key = Buffer.from(key); this.salt = salt; this.data = data;
      } catch (error) {
        if (error instanceof WebError) throw error;
        throw new WebError("UNLOCK_FAILED", "Master-Passwort falsch oder Tresor nicht lesbar.", 401);
      } finally { key?.fill(0); }
    });
  }
  async update(change: (data: VaultData) => void): Promise<void> {
    const epoch = this.epoch;
    return this.serial(async () => {
      if (epoch !== this.epoch || !this.key || !this.salt) throw locked();
      const next = this.snapshot();
      change(next);
      dataSchema.parse(next);
      await this.write(next, this.key, this.salt);
      if (epoch !== this.epoch) throw locked();
      this.data = next;
    });
  }
  async changePassword(current: string, next: string): Promise<void> {
    masterSchema.parse(current); masterSchema.parse(next);
    const epoch = this.epoch;
    return this.serial(async () => {
      if (!this.key || !this.salt || epoch !== this.epoch) throw locked();
      const verified = await derive(current, this.salt);
      const { timingSafeEqual } = await import("node:crypto");
      const valid = this.key !== undefined && timingSafeEqual(verified, this.key);
      verified.fill(0);
      if (!valid) throw new WebError("UNLOCK_FAILED", "Das aktuelle Master-Passwort stimmt nicht.", 401);
      const salt = randomBytes(16);
      const key = await derive(next, salt);
      try {
        if (epoch !== this.epoch) throw locked();
        await this.write(this.snapshot(), key, salt);
        if (epoch !== this.epoch) throw locked();
        this.key?.fill(0); this.key = Buffer.from(key); this.salt = salt;
      } finally { key.fill(0); }
    });
  }
  lock(): void { this.epoch++; this.key?.fill(0); this.key = undefined; this.salt = undefined; this.data = undefined; }
  async settled(): Promise<void> { await this.queue; }
}
