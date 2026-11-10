import { describe, expect, it, vi } from "vite-plus/test";
import { prepareInboundImages } from "../src/inbound-images.js";
import type { StoredEvent } from "../src/store.js";
import type { OneBotTransport } from "../src/onebot.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII=",
  "base64",
);
function event(id = "-1", override: Partial<StoredEvent> = {}): StoredEvent {
  return {
    id,
    accountId: "bot",
    conversationKey: "group:1",
    kind: "group",
    time: 0,
    userId: "10001",
    body: "image",
    mention: true,
    self: false,
    media: [
      {
        kind: "image",
        url: `https://example.com/${id}.png?private=signed-url`,
        messageId: id,
        ref: `${id}:0`,
      },
    ],
    ...override,
  };
}
function dependencies() {
  const load = vi.fn(async () => ({
    buffer: png,
    contentType: "image/png",
    fileName: "image.png",
    kind: "image" as const,
  }));
  const save = vi.fn(async () => ({
    id: "stored",
    path: "/host/media/inbound/stored.png",
    size: png.length,
    contentType: "image/png",
  }));
  const downloadMedia = vi.fn(async () => ({ buffer: png, filename: "remote.png" }));
  return {
    load,
    save,
    downloadMedia,
    transport: { downloadMedia } as Pick<OneBotTransport, "downloadMedia">,
  };
}
describe("current-turn vision image staging", () => {
  it("downloads guarded image URLs and supplies an actual host media path", async () => {
    const d = dependencies();
    const facts = await prepareInboundImages([event()], d.transport, { dependencies: d });
    expect(d.load).toHaveBeenCalledWith(
      "https://example.com/-1.png?private=signed-url",
      expect.objectContaining({ maxBytes: 10 * 1024 * 1024, optimizeImages: false }),
    );
    expect(d.save).toHaveBeenCalledWith(
      png,
      "image/png",
      "inbound",
      10 * 1024 * 1024,
      "image.png",
      undefined,
      expect.objectContaining({ assertCommitAllowed: expect.any(Function) }),
    );
    expect(facts).toEqual([
      {
        kind: "image",
        messageId: "-1",
        path: "/host/media/inbound/stored.png",
        contentType: "image/png",
      },
    ]);
    expect(JSON.stringify(facts)).not.toContain("signed-url");
  });
  it("uses the server media download for retained received resources without URLs", async () => {
    const d = dependencies();
    const item = event("-2", {
      media: [{ kind: "image", file: "received-image-id", ref: "-2:0", messageId: "-2" }],
    });
    const facts = await prepareInboundImages([item], d.transport, { dependencies: d });
    expect(d.load).not.toHaveBeenCalled();
    expect(d.downloadMedia).toHaveBeenCalledWith(
      "received-image-id",
      expect.objectContaining({ kind: "image", maxBytes: 10 * 1024 * 1024 }),
    );
    expect(facts[0].path).toBe("/host/media/inbound/stored.png");
  });
  it("excludes self/history images and deduplicates same current resource", async () => {
    const d = dependencies();
    const facts = await prepareInboundImages(
      [event("-1", { self: true }), event("-2", { trigger: false }), event("-3"), event("-3")],
      d.transport,
      { dependencies: d },
    );
    expect(d.load).toHaveBeenCalledTimes(1);
    expect(facts).toHaveLength(1);
    expect(facts[0].messageId).toBe("-3");
  });
  it("bounds image count and total bytes and reports unavailable images without aborting text", async () => {
    const d = dependencies();
    const onError = vi.fn();
    const facts = await prepareInboundImages([event("-1"), event("-2"), event("-3")], d.transport, {
      dependencies: d,
      maxBytes: png.length,
      maxImages: 2,
      onError,
    });
    expect(facts).toHaveLength(1);
    expect(d.load).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith({ messageId: "-2", ref: "-2:0", reason: "byte-limit" });
    const capped = await prepareInboundImages([event("-4"), event("-5")], d.transport, {
      dependencies: d,
      maxImages: 1,
      onError,
    });
    expect(capped).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith({ messageId: "-5", ref: "-5:0", reason: "image-limit" });
  });
  it("keeps download failures and unexpected file data out of model context", async () => {
    const d = dependencies();
    d.load.mockRejectedValueOnce(new Error("https://signed-url.example/private?token=secret"));
    const onError = vi.fn();
    const facts = await prepareInboundImages([event()], d.transport, { dependencies: d, onError });
    expect(facts).toEqual([{ kind: "image", messageId: "-1" }]);
    expect(JSON.stringify(onError.mock.calls)).not.toContain("signed-url");
    expect(d.save).not.toHaveBeenCalled();
    await expect(
      prepareInboundImages([event()], d.transport, {
        signal: AbortSignal.abort(),
        dependencies: d,
      }),
    ).resolves.toEqual([]);
  });
  it("does not accept file URLs as inbound image URL download sources", async () => {
    const d = dependencies();
    const facts = await prepareInboundImages(
      [
        event("-1", {
          media: [{ kind: "image", url: "file:///etc/passwd", ref: "-1:0", messageId: "-1" }],
        }),
      ],
      d.transport,
      { dependencies: d },
    );
    expect(d.load).not.toHaveBeenCalled();
    expect(facts).toEqual([{ kind: "image", messageId: "-1" }]);
  });
});
