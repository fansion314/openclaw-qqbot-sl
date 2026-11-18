import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { StickerStore, validateStickerId, type StickerTransport } from "../src/stickers.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII=",
  "base64",
);
const gif = Buffer.from(
  "47494638396101000100800000000000ffffff21f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024c01003b",
  "hex",
);
const roots: string[] = [];
const stores: StickerStore[] = [];
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const remoteId = (bytes: Buffer, selfId = "10001") =>
  `${selfId}_0_0_0_${createHash("md5").update(bytes).digest("hex").toUpperCase()}_0_0`;
function root() {
  const path = mkdtempSync(join(tmpdir(), "snowluma-stickers-"));
  roots.push(path);
  return path;
}
function open(path = root()) {
  const store = new StickerStore(path);
  stores.push(store);
  return store;
}
function close(store: StickerStore) {
  stores.splice(stores.indexOf(store), 1);
  store.close();
}
function transport(selfId = "10001") {
  const ids = new Set<string>();
  return {
    ids,
    downloadMedia: vi.fn(async () => ({ buffer: gif, filename: "source.gif" })),
    fetchCustomFaceIds: vi.fn(async () => [...ids]),
    addCustomFace: vi.fn(async (bytes: Uint8Array) => {
      const id = remoteId(Buffer.from(bytes), selfId);
      ids.add(id);
      return id;
    }),
    deleteCustomFace: vi.fn(async (id: string) => {
      ids.delete(id);
    }),
  };
}
const media = { kind: "image", ref: "1:0", messageId: "1", file: "received-id" };
function save(store: StickerStore, bot: StickerTransport, id = "好棒", description = "夸人和捧场") {
  return store.saveReceived("bot", "10001", id, description, media, bot);
}
function seedLegacy(path: string, id: string, bytes = gif, accountId = "bot") {
  const db = new DatabaseSync(join(path, "index.sqlite"));
  db.exec(`CREATE TABLE IF NOT EXISTS stickers (
    account_id TEXT NOT NULL, id TEXT NOT NULL, description TEXT NOT NULL,
    hash TEXT NOT NULL, content_type TEXT NOT NULL, PRIMARY KEY(account_id, id)
  )`);
  db.prepare("INSERT INTO stickers VALUES (?, ?, ?, ?, ?)").run(
    accountId,
    id,
    "旧说明",
    sha(bytes),
    "image/gif",
  );
  db.close();
  const directory = join(path, sha(accountId));
  mkdirSync(directory, { recursive: true });
  const imagePath = join(directory, sha(bytes));
  writeFileSync(imagePath, bytes);
  return imagePath;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("QQ sticker aliases", () => {
  it("stores readable names and QQ identities across restart without persisting new images", async () => {
    const path = root();
    const store = open(path);
    const bot = transport();
    expect(await save(store, bot)).toEqual({ id: "好棒", description: "夸人和捧场" });
    expect(bot.addCustomFace).toHaveBeenCalledWith(
      gif,
      expect.stringMatching(/\.gif$/),
      expect.anything(),
    );
    expect(readdirSync(path).every((name) => name.startsWith("index.sqlite"))).toBe(true);
    close(store);
    const next = open(path);
    expect(next.list("bot")).toEqual([{ id: "好棒", description: "夸人和捧场" }]);
    expect(await next.resolveForSend("bot", "10001", "好棒", bot)).toBe(remoteId(gif));
    expect(bot.addCustomFace).toHaveBeenCalledTimes(1);
    expect(bot.fetchCustomFaceIds).toHaveBeenCalledTimes(1);
    expect(next.list("other")).toEqual([]);
    expect(next.has("other", "好棒")).toBe(false);
    await expect(next.resolveForSend("other", "20002", "好棒", bot)).rejects.toThrow(
      "Unknown sticker ID",
    );
    await expect(next.resolveForSend("bot", "20002", "好棒", bot)).rejects.toThrow(
      "another QQ account",
    );
  });
  it("serializes concurrent handles, deduplicates aliases, and retains the current description", async () => {
    const path = root();
    const a = open(path);
    const b = open(path);
    const bot = transport();
    await Promise.all([save(a, bot), save(b, bot, "同图")]);
    expect(bot.addCustomFace).toHaveBeenCalledTimes(1);
    a.updateDescription("bot", "好棒", "新说明");
    expect(await save(b, bot)).toEqual({ id: "好棒", description: "新说明" });
    expect(a.list("bot")).toHaveLength(2);
    bot.downloadMedia.mockResolvedValue({ buffer: png, filename: "different.png" });
    await expect(save(b, bot)).rejects.toThrow("another image");
    expect(bot.addCustomFace).toHaveBeenCalledTimes(1);
  });
  it("migrates legacy files on first send and shares migration across aliases", async () => {
    const path = root();
    const file = seedLegacy(path, "好棒");
    seedLegacy(path, "同图");
    const store = open(path);
    const bot = transport();
    expect(store.list("bot")).toHaveLength(2);
    expect(bot.addCustomFace).not.toHaveBeenCalled();
    expect(await store.resolveForSend("bot", "10001", "好棒", bot)).toBe(remoteId(gif));
    expect(readFileSync(file)).toEqual(gif);
    expect(await store.resolveForSend("bot", "10001", "同图", bot)).toBe(remoteId(gif));
    expect(bot.addCustomFace).toHaveBeenCalledTimes(1);
    close(store);
    expect(await open(path).resolveForSend("bot", "10001", "好棒", bot)).toBe(remoteId(gif));
  });
  it("rejects corrupt or oversized legacy images before adding a favorite", async () => {
    const path = root();
    const file = seedLegacy(path, "好棒");
    const store = open(path);
    const bot = transport();
    await expect(
      store.resolveForSend("bot", "10001", "好棒", bot, { maxBytes: 1 }),
    ).rejects.toThrow("byte limit");
    writeFileSync(file, png);
    await expect(store.resolveForSend("bot", "10001", "好棒", bot)).rejects.toThrow("integrity");
    expect(bot.addCustomFace).not.toHaveBeenCalled();
  });
  it("keeps legacy aliases and bytes when migration fails and reconciles a lost response on retry", async () => {
    const path = root();
    const file = seedLegacy(path, "好棒");
    const store = open(path);
    const bot = transport();
    bot.addCustomFace.mockImplementationOnce(async () => {
      bot.ids.add(remoteId(gif));
      throw new Error("lost response");
    });
    await expect(store.resolveForSend("bot", "10001", "好棒", bot)).rejects.toThrow(
      "lost response",
    );
    expect(store.has("bot", "好棒")).toBe(true);
    expect(existsSync(file)).toBe(true);
    close(store);
    expect(await open(path).resolveForSend("bot", "10001", "好棒", bot)).toBe(remoteId(gif));
    expect(bot.addCustomFace).toHaveBeenCalledTimes(1);
  });
  it("publishes no local alias for a failed new favorite and recovers it on explicit retry", async () => {
    const store = open();
    const bot = transport();
    bot.addCustomFace.mockImplementationOnce(async () => {
      bot.ids.add(remoteId(gif));
      throw new Error("lost response");
    });
    await expect(save(store, bot)).rejects.toThrow("lost response");
    expect(store.list("bot")).toEqual([]);
    await save(store, bot);
    expect(store.has("bot", "好棒")).toBe(true);
    expect(bot.addCustomFace).toHaveBeenCalledTimes(1);
  });
  it("restores an externally removed favorite when explicitly saved again", async () => {
    const store = open();
    const bot = transport();
    await save(store, bot);
    bot.ids.clear();
    await save(store, bot);
    expect(bot.addCustomFace).toHaveBeenCalledTimes(2);
    expect(bot.ids.has(remoteId(gif))).toBe(true);
  });
  it("deletes QQ favorites and retained legacy bytes only after the last alias", async () => {
    const path = root();
    const file = seedLegacy(path, "好棒");
    seedLegacy(path, "同图");
    const store = open(path);
    const bot = transport();
    await store.resolveForSend("bot", "10001", "好棒", bot);
    expect(await store.delete("bot", "10001", "好棒", bot)).toBe(true);
    expect(await store.delete("bot", "10001", "好棒", bot)).toBe(false);
    expect(bot.deleteCustomFace).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(true);
    expect(await store.delete("bot", "10001", "同图", bot)).toBe(true);
    expect(bot.deleteCustomFace).toHaveBeenCalledWith(remoteId(gif), expect.anything());
    expect(existsSync(file)).toBe(false);
    expect(store.list("bot")).toEqual([]);
  });
  it("preserves mappings on delete failure and reconciles an uncertain deletion on retry", async () => {
    const store = open();
    const bot = transport();
    await save(store, bot);
    bot.deleteCustomFace.mockImplementationOnce(async (id) => {
      bot.ids.delete(id);
      throw new Error("lost delete response");
    });
    await expect(store.delete("bot", "10001", "好棒", bot)).rejects.toThrow("lost delete response");
    expect(store.has("bot", "好棒")).toBe(true);
    expect(await store.delete("bot", "10001", "好棒", bot)).toBe(true);
    expect(bot.deleteCustomFace).toHaveBeenCalledTimes(1);
  });
  it("removes unmigrated legacy records locally without adding a QQ favorite", async () => {
    const path = root();
    const file = seedLegacy(path, "好棒");
    const store = open(path);
    const bot = transport();
    expect(await store.delete("bot", "10001", "好棒", bot)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(bot.fetchCustomFaceIds).not.toHaveBeenCalled();
    expect(bot.addCustomFace).not.toHaveBeenCalled();
  });
  it("preserves original GIF bytes through the host loader without optimization", async () => {
    const store = open();
    const bot = transport();
    const load = vi.fn(async () => ({
      buffer: gif,
      contentType: "image/gif",
      kind: "image" as const,
    }));
    await store.saveReceived(
      "bot",
      "10001",
      "探头",
      "看看发生了什么",
      {
        ...media,
        url: "https://example.com/second.gif",
      },
      bot,
      { load },
    );
    expect(load).toHaveBeenCalledWith(
      "https://example.com/second.gif",
      expect.objectContaining({ optimizeImages: false }),
    );
    expect(bot.addCustomFace).toHaveBeenCalledWith(gif, expect.anything(), expect.anything());
    expect(bot.downloadMedia).not.toHaveBeenCalled();
  });
  it("uses retained server image IDs when CDN acquisition fails", async () => {
    const store = open();
    const bot = transport();
    const load = vi.fn().mockRejectedValue(new Error("expired CDN URL"));
    await store.saveReceived(
      "bot",
      "10001",
      "好棒",
      "捧场",
      {
        ...media,
        url: "https://example.com/expired",
      },
      bot,
      { load },
    );
    expect(bot.downloadMedia).toHaveBeenCalledWith(
      "received-id",
      expect.objectContaining({ kind: "image" }),
    );
    expect(bot.addCustomFace).toHaveBeenCalledWith(gif, expect.anything(), expect.anything());
  });
  it("validates IDs, descriptions, media, size, URLs, and cancellation before remote publication", async () => {
    const store = open();
    const bot = transport();
    expect(validateStickerId("猫猫_探头-2")).toBe("猫猫_探头-2");
    for (const id of ["", "../secret", "two words", "a\n", "a".repeat(33), "<image>"])
      expect(() => store.has("bot", id)).toThrow("Sticker ID");
    await expect(save(store, bot, "ok", " ")).rejects.toThrow("description");
    await expect(save(store, bot, "ok", "x".repeat(257))).rejects.toThrow("description");
    bot.downloadMedia.mockResolvedValue({
      buffer: Buffer.from("not an image"),
      filename: "fake.png",
    });
    await expect(save(store, bot)).rejects.toThrow("not an image");
    bot.downloadMedia.mockResolvedValue({ buffer: gif, filename: "original.gif" });
    await expect(
      store.saveReceived("bot", "10001", "x", "说明", media, bot, { maxBytes: 1 }),
    ).rejects.toThrow("byte limit");
    await expect(
      store.saveReceived("bot", "10001", "x", "说明", { ...media, url: "file:///etc/passwd" }, bot),
    ).rejects.toThrow("URL");
    await expect(
      store.saveReceived("bot", "10001", "x", "说明", media, bot, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    await expect(
      store.saveReceived("bot", "10001", "x", "说明", media, bot, {
        assertCurrent: () => {
          throw new Error("obsolete turn");
        },
      }),
    ).rejects.toThrow("obsolete turn");
    expect(store.list("bot")).toEqual([]);
    expect(bot.addCustomFace).not.toHaveBeenCalled();
  });
});
