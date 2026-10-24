import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { z } from "zod";

export class SecretError extends Error {}
export const SecretName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,79}$/, "Use letters, digits and underscores; start with a letter or underscore");
export const SecretValue = z.string().min(1).max(8_000).refine((value) => !value.includes("\0"), "A secret cannot contain a null byte");
// These belong to the launcher, rather than to an application's configuration.
const reserved = /^(?:PORT|HOST|BROWSER|ORCHESTRA_.*|PATH|HOME|SHELL|ENV|BASH_ENV|NODE_OPTIONS|BUN_OPTIONS|LD_.*|DYLD_.*)$/;
export const SecretBody = z.strictObject({ name: SecretName, value: SecretValue, environment: z.boolean().default(false) })
  .refine((secret) => !secret.environment || !reserved.test(secret.name), { path: ["name"], message: "This environment variable is reserved by Orchestra" });
export const SecretKey = z.strictObject({ name: SecretName, source: z.enum(["saved", "preview"]) });
export type SecretInput = z.infer<typeof SecretBody>;

/** The key is separate from SQLite, created only when the first value is saved. */
export function secretCipher(path: string | null) {
  let key: Buffer | undefined = path === null ? randomBytes(32) : undefined;
  const load = (create: boolean) => {
    if (key) return key;
    if (create) {
      try { writeFileSync(path!, randomBytes(32), { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new SecretError("Could not create the local secrets key"); }
    }
    try {
      const fd = openSync(path!, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size !== 32 || (stat.mode & 0o077)) throw new Error();
        key = readFileSync(fd);
        return key;
      } finally { closeSync(fd); }
    } catch { throw new SecretError("The local secrets key is missing or unreadable. Restore the original .secrets-key file with owner-only permissions."); }
  };
  return {
    seal(value: string, context: string, createKey = true) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", load(createKey), iv);
      cipher.setAAD(Buffer.from(context));
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
    },
    open(value: string, context: string) {
      const bytes = Buffer.from(value, "base64");
      const decipher = createDecipheriv("aes-256-gcm", load(false), bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(bytes.subarray(12, 28));
      try { return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"); }
      catch { throw new SecretError("Could not unlock this secret with the local secrets key"); }
    },
  };
}

/** Only the preview's designated private file is read, never arbitrary paths from output. */
export function readSecretReport(path: string): Record<string, string> {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64_000) return {};
    const bytes = Buffer.alloc(64_001);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > 64_000) return {};
    const parsed = z.record(SecretName, SecretValue).safeParse(JSON.parse(bytes.subarray(0, length).toString("utf8")));
    return parsed.success && Object.keys(parsed.data).length <= 100 ? parsed.data : {};
  } catch { return {}; }
  finally { if (fd !== undefined) closeSync(fd); }
}
