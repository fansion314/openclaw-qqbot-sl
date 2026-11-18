import { createHash, randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { detectMime } from "openclaw/plugin-sdk/media-runtime";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import type { InboundMedia } from "./inbound.js";
import type { OneBotTransport } from "./onebot.js";
import { validateStickerId } from "./sticker-id.js";

export { validateStickerId } from "./sticker-id.js";
export interface StickerEntry {
  id: string;
  description: string;
}
interface StickerRow extends StickerEntry {
  hash: string;
  content_type: string;
}
export interface StickerSaveOptions {
  maxBytes?: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  /** Uses the public host loader in production. */
  load?: typeof loadWebMediaRaw;
}
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

function validateDescription(value: string): void {
  if (!value.trim() || [...value].length > 256 || /[\p{Cc}\p{Cf}]/u.test(value))
    throw new Error("Sticker description must be 1–256 characters without control characters");
}

/** A committed index entry always points to an immutable, complete local image. */
export class StickerStore {
  private readonly db: DatabaseSync;
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(root, "index.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS stickers (
        account_id TEXT NOT NULL,
        id TEXT NOT NULL,
        description TEXT NOT NULL,
        hash TEXT NOT NULL,
        content_type TEXT NOT NULL,
        PRIMARY KEY (account_id, id)
      );
    `);
  }
  close(): void {
    this.db.close();
  }
  list(accountId: string): StickerEntry[] {
    return this.db
      .prepare("SELECT id, description FROM stickers WHERE account_id = ? ORDER BY id")
      .all(accountId) as unknown as StickerEntry[];
  }
  private row(accountId: string, id: string): StickerRow | undefined {
    validateStickerId(id);
    return this.db
      .prepare(
        "SELECT id, description, hash, content_type FROM stickers WHERE account_id = ? AND id = ?",
      )
      .get(accountId, id) as unknown as StickerRow | undefined;
  }
  private imagePath(accountId: string, hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid stored sticker hash");
    return join(this.root, digest(accountId), hash);
  }
  has(accountId: string, id: string): boolean {
    return !!this.row(accountId, id);
  }
  updateDescription(accountId: string, id: string, description: string): StickerEntry | undefined {
    validateStickerId(id);
    validateDescription(description);
    const result = this.db
      .prepare(
        "UPDATE stickers SET description = ? WHERE account_id = ? AND id = ?",
      )
      .run(description, accountId, id);
    return result.changes ? { id, description } : undefined;
  }
  delete(accountId: string, id: string): boolean {
    validateStickerId(id);
    const [removed] = this.db
      .prepare("DELETE FROM stickers WHERE account_id = ? AND id = ? RETURNING hash")
      .all(accountId, id) as { hash: string }[];
    if (!removed) return false;

    // Commit the removal before unlinking. The write lock keeps a concurrent
    // save from publishing a new entry between the reference check and unlink.
    try {
      this.withWriteLock(() => {
        const reference = this.db
          .prepare("SELECT 1 FROM stickers WHERE account_id = ? AND hash = ? LIMIT 1")
          .get(accountId, removed.hash);
        if (!reference) rmSync(this.imagePath(accountId, removed.hash), { force: true });
      });
    } catch (cause) {
      throw new Error("表情已从收藏中删除，但清理本地图片失败。", { cause });
    }
    return true;
  }
  private withWriteLock<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get(
    accountId: string,
    id: string,
    maxBytes = 50 * 1024 * 1024,
  ): { buffer: Buffer; filename: string; contentType: string } {
    const row = this.row(accountId, id);
    if (!row)
      throw new Error(`Unknown sticker ID: ${id}. Use snowluma_stickers list to see saved IDs`);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error("Invalid sticker byte limit");
    const path = this.imagePath(accountId, row.hash);
    if (statSync(path).size > maxBytes) throw new Error("Sticker exceeds image byte limit");
    const buffer = readFileSync(path);
    if (buffer.length > maxBytes) throw new Error("Sticker exceeds image byte limit");
    if (digest(buffer) !== row.hash) throw new Error("Stored sticker image failed integrity check");
    const extension = row.content_type.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "image";
    return { buffer, filename: `${row.hash}.${extension}`, contentType: row.content_type };
  }
  save(
    accountId: string,
    id: string,
    description: string,
    buffer: Buffer,
    contentType: string,
  ): StickerEntry {
    validateStickerId(id);
    validateDescription(description);
    if (!buffer.length || !contentType.startsWith("image/"))
      throw new Error("Sticker must be an image");
    const hash = digest(buffer);
    return this.withWriteLock(() => {
      const existing = this.row(accountId, id);
      if (existing && existing.hash !== hash)
        throw new Error(`Sticker ID ${id} already names another image. Choose another ID`);
      this.saveImage(accountId, hash, buffer);
      if (existing) return { id, description: existing.description };
      this.db
        .prepare(
          "INSERT INTO stickers (account_id, id, description, hash, content_type) VALUES (?, ?, ?, ?, ?)",
        )
        .run(accountId, id, description, hash, contentType);
      return { id, description };
    });
  }
  private saveImage(accountId: string, hash: string, buffer: Buffer): void {
    const path = this.imagePath(accountId, hash);
    mkdirSync(join(this.root, digest(accountId)), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, buffer, { flag: "wx", mode: 0o600, flush: true });
    try {
      try {
        linkSync(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!readFileSync(path).equals(buffer))
          throw new Error("Stored sticker image conflicts with content hash");
      }
    } finally {
      unlinkSync(temporary);
    }
  }
  /** Caller proves that media.ref belongs to the active, authorized conversation. */
  async saveReceived(
    accountId: string,
    id: string,
    description: string,
    media: InboundMedia,
    transport: Pick<OneBotTransport, "downloadMedia">,
    options: StickerSaveOptions = {},
  ): Promise<StickerEntry> {
    validateStickerId(id);
    validateDescription(description);
    if (media.kind !== "image") throw new Error("Only received images can be saved as stickers");
    const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error("Invalid sticker byte limit");
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    let buffer: Buffer | undefined;
    if (media.url) {
      const url = new URL(media.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new Error("Invalid received image URL");
      try {
        const loaded = await (options.load ?? loadWebMediaRaw)(url.href, {
          maxBytes,
          optimizeImages: false,
          requestInit: { signal: options.signal },
        });
        buffer = loaded.buffer;
      } catch {
        options.signal?.throwIfAborted();
        if (!media.file) throw new Error("Received image could not be downloaded");
      }
    }
    if (!buffer) {
      if (!media.file) throw new Error("Received image has no accessible source");
      buffer = (
        await transport.downloadMedia(media.file, {
          kind: "image",
          maxBytes,
          signal: options.signal,
        })
      ).buffer;
    }
    options.signal?.throwIfAborted();
    if (!buffer.length || buffer.length > maxBytes)
      throw new Error("Sticker exceeds image byte limit");
    const contentType = await detectMime({ buffer });
    if (!contentType?.startsWith("image/")) throw new Error("Received resource is not an image");
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    return this.save(accountId, id, description, buffer, contentType);
  }
}
