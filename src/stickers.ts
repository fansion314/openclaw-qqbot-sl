import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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
  emoji_id: string | null;
}
export type StickerTransport = Pick<
  OneBotTransport,
  "downloadMedia" | "addCustomFace" | "fetchCustomFaceIds" | "deleteCustomFace"
>;
export interface StickerSaveOptions {
  maxBytes?: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  /** Uses the public host loader in production. */
  load?: typeof loadWebMediaRaw;
}
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const mutations = new Map<string, Promise<unknown>>();

function validateDescription(value: string): void {
  if (!value.trim() || [...value].length > 256 || /[\p{Cc}\p{Cf}]/u.test(value))
    throw new Error("Sticker description must be 1–256 characters without control characters");
}
function assertCurrent(options: StickerSaveOptions): void {
  options.signal?.throwIfAborted();
  options.assertCurrent?.();
}
function byteLimit(options: StickerSaveOptions): number {
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error("Invalid sticker byte limit");
  return maxBytes;
}

/** Local names refer to QQ favorites; old image files remain available for lazy migration. */
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
        emoji_id TEXT,
        PRIMARY KEY (account_id, id)
      );
      CREATE TABLE IF NOT EXISTS sticker_accounts (
        account_id TEXT PRIMARY KEY,
        self_id TEXT NOT NULL
      );
    `);
    this.withWriteLock(() => {
      const columns = this.db.prepare("PRAGMA table_info(stickers)").all();
      if (!columns.some((column) => column.name === "emoji_id"))
        this.db.exec("ALTER TABLE stickers ADD COLUMN emoji_id TEXT");
    });
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
        "SELECT id, description, hash, emoji_id FROM stickers WHERE account_id = ? AND id = ?",
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
      .prepare("UPDATE stickers SET description = ? WHERE account_id = ? AND id = ?")
      .run(description, accountId, id);
    return result.changes ? { id, description } : undefined;
  }
  private bindAccount(accountId: string, selfId: string): void {
    if (!/^[1-9]\d*$/.test(selfId)) throw new Error("Invalid QQ account identity");
    this.db
      .prepare("INSERT OR IGNORE INTO sticker_accounts (account_id, self_id) VALUES (?, ?)")
      .run(accountId, selfId);
    this.assertAccount(accountId, selfId);
  }
  assertAccount(accountId: string, selfId: string): void {
    const binding = this.db
      .prepare("SELECT self_id FROM sticker_accounts WHERE account_id = ?")
      .get(accountId);
    if (binding && binding.self_id !== selfId)
      throw new Error("Sticker collection belongs to another QQ account");
  }
  private mutate<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([resolve(this.root), accountId]);
    const previous = mutations.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    mutations.set(key, current);
    void current
      .finally(() => {
        if (mutations.get(key) === current) mutations.delete(key);
      })
      .catch(() => {});
    return current;
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
  private legacyImage(accountId: string, row: StickerRow, options: StickerSaveOptions): Buffer {
    const maxBytes = byteLimit(options);
    const path = this.imagePath(accountId, row.hash);
    if (statSync(path).size > maxBytes) throw new Error("Sticker exceeds image byte limit");
    const buffer = readFileSync(path);
    if (!buffer.length || buffer.length > maxBytes)
      throw new Error("Sticker exceeds image byte limit");
    if (digest(buffer) !== row.hash) throw new Error("Stored sticker image failed integrity check");
    return buffer;
  }
  private async favorite(
    accountId: string,
    selfId: string,
    hash: string,
    buffer: Buffer,
    contentType: string,
    transport: StickerTransport,
    options: StickerSaveOptions,
  ): Promise<string> {
    assertCurrent(options);
    const ids = await transport.fetchCustomFaceIds(options);
    assertCurrent(options);
    const alias = this.db
      .prepare(
        "SELECT emoji_id FROM stickers WHERE account_id = ? AND hash = ? AND emoji_id IS NOT NULL LIMIT 1",
      )
      .get(accountId, hash);
    if (typeof alias?.emoji_id === "string" && ids.includes(alias.emoji_id)) return alias.emoji_id;
    // SnowLuma 2.3.4 derives this identifier from QQ identity and the original bytes.
    // Checking it also reconciles an earlier add whose response was lost.
    const md5 = createHash("md5").update(buffer).digest("hex").toUpperCase();
    const expected = `${selfId}_0_0_0_${md5}_0_0`;
    if (ids.includes(expected)) return expected;
    const extension = contentType.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "image";
    const emojiId = await transport.addCustomFace(buffer, `${hash}.${extension}`, options);
    if (!emojiId.trim()) throw new Error("QQ returned an empty sticker identity");
    return emojiId;
  }
  private mapAliases(accountId: string, hash: string, emojiId: string): void {
    this.db
      .prepare("UPDATE stickers SET emoji_id = ? WHERE account_id = ? AND hash = ?")
      .run(emojiId, accountId, hash);
  }
  resolveForSend(
    accountId: string,
    selfId: string,
    id: string,
    transport: StickerTransport,
    options: StickerSaveOptions = {},
  ): Promise<string> {
    return this.mutate(accountId, async () => {
      assertCurrent(options);
      this.bindAccount(accountId, selfId);
      const row = this.row(accountId, id);
      if (!row)
        throw new Error(`Unknown sticker ID: ${id}. Use snowluma_stickers list to see saved IDs`);
      if (row.emoji_id) return row.emoji_id;
      const buffer = this.legacyImage(accountId, row, options);
      const contentType = await detectMime({ buffer });
      if (!contentType?.startsWith("image/")) throw new Error("Stored resource is not an image");
      const emojiId = await this.favorite(
        accountId,
        selfId,
        row.hash,
        buffer,
        contentType,
        transport,
        options,
      );
      this.mapAliases(accountId, row.hash, emojiId);
      return emojiId;
    });
  }
  delete(
    accountId: string,
    selfId: string,
    id: string,
    transport: StickerTransport,
    options: StickerSaveOptions = {},
  ): Promise<boolean> {
    return this.mutate(accountId, async () => {
      assertCurrent(options);
      this.bindAccount(accountId, selfId);
      const row = this.row(accountId, id);
      if (!row) return false;
      const alias =
        row.emoji_id &&
        this.db
          .prepare(
            "SELECT 1 FROM stickers WHERE account_id = ? AND id != ? AND (emoji_id = ? OR hash = ?) LIMIT 1",
          )
          .get(accountId, id, row.emoji_id, row.hash);
      if (row.emoji_id && !alias) {
        const ids = await transport.fetchCustomFaceIds(options);
        assertCurrent(options);
        if (ids.includes(row.emoji_id)) await transport.deleteCustomFace(row.emoji_id, options);
      }
      this.db.prepare("DELETE FROM stickers WHERE account_id = ? AND id = ?").run(accountId, id);
      try {
        this.withWriteLock(() => {
          const reference = this.db
            .prepare("SELECT 1 FROM stickers WHERE account_id = ? AND hash = ? LIMIT 1")
            .get(accountId, row.hash);
          if (!reference) rmSync(this.imagePath(accountId, row.hash), { force: true });
        });
      } catch (cause) {
        throw new Error("表情已从收藏中删除，但清理旧版图片文件失败。", { cause });
      }
      return true;
    });
  }
  /** Caller proves that media.ref belongs to the active, authorized conversation. */
  async saveReceived(
    accountId: string,
    selfId: string,
    id: string,
    description: string,
    media: InboundMedia,
    transport: StickerTransport,
    options: StickerSaveOptions = {},
  ): Promise<StickerEntry> {
    validateStickerId(id);
    validateDescription(description);
    if (media.kind !== "image") throw new Error("Only received images can be saved as stickers");
    const maxBytes = byteLimit(options);
    assertCurrent(options);
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
    assertCurrent(options);
    if (!buffer.length || buffer.length > maxBytes)
      throw new Error("Sticker exceeds image byte limit");
    const contentType = await detectMime({ buffer });
    if (!contentType?.startsWith("image/")) throw new Error("Received resource is not an image");
    const image = buffer;
    const hash = digest(image);
    return this.mutate(accountId, async () => {
      assertCurrent(options);
      this.bindAccount(accountId, selfId);
      const existing = this.row(accountId, id);
      if (existing && existing.hash !== hash)
        throw new Error(`Sticker ID ${id} already names another image. Choose another ID`);
      const emojiId = await this.favorite(
        accountId,
        selfId,
        hash,
        image,
        contentType,
        transport,
        options,
      );
      return this.withWriteLock(() => {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO stickers (account_id, id, description, hash, content_type, emoji_id) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(accountId, id, description, hash, contentType, emojiId);
        this.mapAliases(accountId, hash, emojiId);
        return { id, description: this.row(accountId, id)!.description };
      });
    });
  }
}
