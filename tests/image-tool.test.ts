import { describe, expect, it } from "vite-plus/test";
import { resolveImageToolParams } from "../src/image-tool.js";
import { ImageLinks } from "../src/image-links.js";
import { buildBatchContext } from "../src/prompt.js";
describe("transparent scoped image reads", () => {
  it("restores compact references in current view_image path/paths while preserving the prompt", async () => {
    const links = new ImageLinks({ path: ":memory:", port: 0 });
    await links.start();
    try {
      const ref = links.compact("https://example.com/picture?token=secret", "rion");
      expect(ref).toMatch(/^qqimg:[A-Za-z0-9_-]{22}$/);
      expect(ref.length).toBe(28);
      expect(
        resolveImageToolParams(
          "view_image",
          { path: ref, paths: [ref], prompt: "describe" },
          (url) => links.resolve(url, "rion"),
        ),
      ).toEqual({
        path: "https://example.com/picture?token=secret",
        paths: ["https://example.com/picture?token=secret"],
        prompt: "describe",
      });
      expect(links.resolve(ref, "other")).toBeUndefined();
    } finally {
      await links.close();
    }
  });
  it("shortens all native image attributes, including quoted images, and restores image tool fields", async () => {
    const links = new ImageLinks({ path: ":memory:", port: 0 });
    await links.start();
    try {
      const original = "https://example.com/image?rkey=very-long-secret&size=100";
      const escaped = original.replace(/&/g, "&amp;");
      const text = buildBatchContext(
        {
          trigger: "message",
          droppedCount: 0,
          events: [
            {
              id: "1",
              userId: "10001",
              time: 0,
              mention: false,
              self: false,
              body: "",
              formattedBody: `<image ref="1:0" url="${escaped}" file="${escaped}"></image><reply msg_id="-1"><image ref="1:reply:0" url="${escaped}"></image></reply>`,
            },
          ],
        },
        "10002",
        "",
        { imageUrl: (url) => links.shorten(url, "rion:group1") },
      );
      expect(text).not.toContain("very-long-secret");
      expect(text).toContain('ref="1:0"');
      const short = links.shorten(original, "rion:group1");
      expect(text).toContain(short);
      expect(
        resolveImageToolParams(
          "image",
          { image: short, images: [short], prompt: "describe" },
          (url) => links.resolve(url, "rion:group1"),
        ),
      ).toEqual({ image: original, images: [original], prompt: "describe" });
      expect(
        resolveImageToolParams("image", { image: short }, (url) =>
          links.resolve(url, "rion:group2"),
        ),
      ).toBeUndefined();
      expect(
        resolveImageToolParams("exec", { command: short }, (url) =>
          links.resolve(url, "rion:group1"),
        ),
      ).toBeUndefined();
    } finally {
      await links.close();
    }
  });
});
