import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareOutboundMedia } from "../src/media.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function image() {
  const root = await mkdtemp(join(tmpdir(), "snowluma-host-media-"));
  directories.push(root);
  const file = join(root, "sample.png");
  const buffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(file, buffer);
  return { root, file, buffer };
}
describe("OpenClaw media authorization", () => {
  it("reads permitted media through real host local-root validation", async () => {
    const { root, file, buffer } = await image();
    const media = await prepareOutboundMedia(file, { mediaAccess: { localRoots: [root] } });
    expect(media.buffer).toEqual(buffer);
    expect(media.contentType).toBe("image/png");
  });
  it("does not broaden host permission with configured fallback roots", async () => {
    const { root, file } = await image();
    await expect(
      prepareOutboundMedia(file, { mediaAccess: { localRoots: [] }, configuredRoots: [root] }),
    ).rejects.toThrow();
  });
  it("fills roots missing from an empty host text-delivery capability without dropping that capability", async () => {
    const { root, file, buffer } = await image();
    const result = await prepareOutboundMedia(file, { mediaAccess: {}, configuredRoots: [root] });
    expect(result.buffer).toEqual(buffer);
  });
  it("honors the host read capability instead of independently reading a file", async () => {
    const { root, file, buffer } = await image();
    const reads: string[] = [];
    const loaded = await prepareOutboundMedia(file, {
      mediaAccess: {
        localRoots: [root],
        readFile: async (path) => {
          reads.push(path);
          return buffer;
        },
      },
    });
    expect(loaded.buffer).toEqual(buffer);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain("sample.png");
  });
  it("enforces host byte limits, cancellation and remote SSRF policy", async () => {
    const { root, file } = await image();
    await expect(
      prepareOutboundMedia(file, { configuredRoots: [root], maxBytes: 1 }),
    ).rejects.toThrow();
    await expect(prepareOutboundMedia(file, { signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(prepareOutboundMedia("http://127.0.0.1:1/private-image.png")).rejects.toThrow();
  });
});
