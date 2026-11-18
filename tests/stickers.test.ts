import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { StickerStore, validateStickerId } from "../src/stickers.js";

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
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("account sticker collection", () => {
  it("persists image bytes and descriptions across restart with account isolation", () => {
    const path = root();
    const first = open(path);
    first.save("bot-a", "好棒", "夸人和捧场", gif, "image/gif");
    first.close();
    stores.pop();
    const next = open(path);
    expect(next.list("bot-a")).toEqual([{ id: "好棒", description: "夸人和捧场" }]);
    expect(next.get("bot-a", "好棒").buffer).toEqual(gif);
    expect(next.get("bot-a", "好棒").filename).toMatch(/\.gif$/);
    expect(() => next.get("bot-a", "好棒", 1)).toThrow("byte limit");
    expect(next.list("bot-b")).toEqual([]);
    expect(next.has("bot-b", "好棒")).toBe(false);
    expect(() => next.get("bot-b", "好棒")).toThrow("Unknown sticker ID");
  });
  it("allows idempotent concurrent handles and rejects same-ID different images", () => {
    const path = root();
    const a = open(path);
    const b = open(path);
    const entry = a.save("bot", "好棒", "捧场", png, "image/png");
    expect(b.save("bot", "好棒", "捧场", png, "image/png")).toEqual(entry);
    expect(() => b.save("bot", "好棒", "另一张", gif, "image/gif")).toThrow("another image");
    expect(a.get("bot", "好棒").buffer).toEqual(png);
    expect(a.list("bot")).toHaveLength(1);
  });
  it("updates an existing description and reclaims an image after the last scoped ID is deleted", () => {
    const path = root();
    const first = open(path);
    const second = open(path);
    first.save("bot", "好棒", "旧说明", png, "image/png");
    first.save("bot", "同图", "另一用途", png, "image/png");
    first.save("other", "好棒", "另一账号", png, "image/png");
    expect(second.updateDescription("bot", "好棒", "新说明")).toEqual({
      id: "好棒",
      description: "新说明",
    });
    expect(first.save("bot", "好棒", "旧说明", png, "image/png").description).toBe("新说明");
    expect(first.get("bot", "好棒").buffer).toEqual(png);
    expect(first.list("other")).toEqual([{ id: "好棒", description: "另一账号" }]);
    const imagePath = join(
      path,
      createHash("sha256").update("bot").digest("hex"),
      createHash("sha256").update(png).digest("hex"),
    );
    expect(second.delete("bot", "好棒")).toBe(true);
    expect(first.delete("bot", "好棒")).toBe(false);
    expect(first.updateDescription("bot", "好棒", "不存在")).toBeUndefined();
    expect(first.get("bot", "同图").buffer).toEqual(png);
    expect(second.delete("bot", "同图")).toBe(true);
    expect(existsSync(imagePath)).toBe(false);
    expect(first.get("other", "好棒").buffer).toEqual(png);
    first.save("bot", "好棒", "重新收藏", png, "image/png");
    expect(second.get("bot", "好棒").buffer).toEqual(png);
  });
  it("validates labels before accessing files and bounds descriptions", () => {
    const store = open();
    expect(validateStickerId("猫猫_探头-2")).toBe("猫猫_探头-2");
    for (const id of ["", "../secret", "two words", "a\n", "a".repeat(33), "<image>"])
      expect(() => store.get("bot", id)).toThrow("Sticker ID");
    expect(() => store.save("bot", "ok", " ", png, "image/png")).toThrow("description");
    expect(() => store.save("bot", "ok", "x".repeat(257), png, "image/png")).toThrow("description");
  });
  it("saves the selected ref's original GIF through the host loader without optimization", async () => {
    const store = open();
    const load = vi.fn(async () => ({
      buffer: gif,
      contentType: "image/gif",
      kind: "image" as const,
    }));
    const transport = { downloadMedia: vi.fn() };
    await store.saveReceived(
      "bot",
      "探头",
      "看看发生了什么",
      {
        kind: "image",
        ref: "-2:1",
        messageId: "-2",
        url: "https://example.com/second.gif",
      },
      transport,
      { load },
    );
    expect(load).toHaveBeenCalledWith(
      "https://example.com/second.gif",
      expect.objectContaining({ optimizeImages: false }),
    );
    expect(store.get("bot", "探头").buffer).toEqual(gif);
    expect(transport.downloadMedia).not.toHaveBeenCalled();
  });
  it("uses retained server image IDs when CDN acquisition fails", async () => {
    const store = open();
    const load = vi.fn().mockRejectedValue(new Error("expired CDN URL"));
    const transport = {
      downloadMedia: vi.fn(async () => ({ buffer: png, filename: "original.png" })),
    };
    await store.saveReceived(
      "bot",
      "好棒",
      "捧场",
      {
        kind: "image",
        ref: "1:0",
        messageId: "1",
        url: "https://example.com/expired",
        file: "received-id",
      },
      transport,
      { load },
    );
    expect(transport.downloadMedia).toHaveBeenCalledWith(
      "received-id",
      expect.objectContaining({ kind: "image" }),
    );
    expect(store.get("bot", "好棒").buffer).toEqual(png);
  });
  it("rejects non-images, excess bytes, disallowed URL schemes and cancellation before publication", async () => {
    const store = open();
    const media = { kind: "image", ref: "1:0", messageId: "1", url: "https://example.com/file" };
    const transport = { downloadMedia: vi.fn() };
    const load = vi.fn(async () => ({
      buffer: Buffer.from("this is not an image"),
      contentType: "image/png",
      kind: "image" as const,
    }));
    await expect(
      store.saveReceived("bot", "x", "说明", media, transport, { load }),
    ).rejects.toThrow("not an image");
    load.mockResolvedValue({ buffer: png, contentType: "image/png", kind: "image" });
    await expect(
      store.saveReceived("bot", "x", "说明", media, transport, { load, maxBytes: 1 }),
    ).rejects.toThrow("byte limit");
    await expect(
      store.saveReceived("bot", "x", "说明", { ...media, url: "file:///etc/passwd" }, transport, {
        load,
      }),
    ).rejects.toThrow("URL");
    await expect(
      store.saveReceived("bot", "x", "说明", media, transport, {
        load,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
    await expect(
      store.saveReceived("bot", "x", "说明", media, transport, {
        load,
        assertCurrent: () => {
          throw new Error("obsolete turn");
        },
      }),
    ).rejects.toThrow("obsolete turn");
    expect(store.list("bot")).toEqual([]);
  });
});
