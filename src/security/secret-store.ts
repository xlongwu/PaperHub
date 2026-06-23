import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "@/config";

export interface SecretStore {
  get(reference: string): string | undefined;
  set(reference: string, value: string): void;
  delete(reference: string): void;
  has(reference: string): boolean;
}

class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  get(reference: string): string | undefined {
    return this.values.get(reference);
  }

  set(reference: string, value: string): void {
    this.values.set(reference, value);
  }

  delete(reference: string): void {
    this.values.delete(reference);
  }

  has(reference: string): boolean {
    return this.values.has(reference);
  }
}

interface EncryptedSecret {
  iv: string;
  tag: string;
  ciphertext: string;
}

class EncryptedFileSecretStore implements SecretStore {
  private readonly key: Buffer;
  private readonly filePath: string;
  private values: Record<string, EncryptedSecret>;

  constructor(masterKey: Buffer, filePath: string) {
    if (masterKey.byteLength < 32) {
      throw new Error("PaperHub secret-store master key must contain at least 32 bytes.");
    }
    this.key = createHash("sha256").update(masterKey).digest();
    this.filePath = filePath;
    this.values = this.readFile();
  }

  get(reference: string): string | undefined {
    const value = this.values[reference];
    if (!value) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(value.iv, "base64"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  set(reference: string, value: string): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    this.values[reference] = {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    this.persist();
  }

  delete(reference: string): void {
    if (!(reference in this.values)) return;
    delete this.values[reference];
    this.persist();
  }

  has(reference: string): boolean {
    return reference in this.values;
  }

  private readFile(): Record<string, EncryptedSecret> {
    if (!fs.existsSync(this.filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("PaperHub secret store is malformed.");
    }
    return parsed as Record<string, EncryptedSecret>;
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.values), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, this.filePath);
  }
}

let store: SecretStore | undefined;
let warnedAboutMemoryStore = false;

export function getSecretStore(): SecretStore {
  if (store) return store;
  const encodedKey = process.env["PAPERHUB_SECRET_KEY_B64"]?.trim();
  if (encodedKey) {
    const filePath =
      process.env["PAPERHUB_SECRET_STORE_PATH"]?.trim() ||
      path.join(getDataDir(), "secrets", "credentials.json");
    store = new EncryptedFileSecretStore(Buffer.from(encodedKey, "base64"), filePath);
    return store;
  }

  store = new MemorySecretStore();
  if (!warnedAboutMemoryStore && process.env["NODE_ENV"] !== "test" && process.env["VITEST"] !== "true") {
    warnedAboutMemoryStore = true;
    console.warn("[security] Persistent SecretStore is unavailable; credentials will remain in memory only.");
  }
  return store;
}

export function setSecretStoreForTests(value?: SecretStore): void {
  store = value ?? new MemorySecretStore();
}

export function createMemorySecretStore(): SecretStore {
  return new MemorySecretStore();
}
