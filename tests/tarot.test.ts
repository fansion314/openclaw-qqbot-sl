import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomInt } from "node:crypto";
import jpeg from "jpeg-js";
import { drawTarot, loadTarotDeck } from "../src/tarot.js";

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomInt: vi.fn(() => 0),
}));
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(randomInt)
    .mockReset()
    .mockReturnValue(0 as never);
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function workspace() {
  const path = await mkdtemp(join(tmpdir(), "snowluma-tarot-"));
  directories.push(path);
  return path;
}
const request = {
  scope: "qq:account:group:20001",
  messageId: "message-1",
  spread: "advice" as const,
};

describe("tarot draw", () => {
  it("packages 78 distinct fronts with Chinese names and both direction meanings", async () => {
    const deck = await loadTarotDeck();
    expect(deck).toHaveLength(78);
    expect(new Set(deck.map((card) => card.id)).size).toBe(78);
    for (const card of deck) {
      expect(card.nameZh).toMatch(/[\u4e00-\u9fff]/);
      expect(card.upright).toMatch(/[\u4e00-\u9fff]/);
      expect(card.reversed).toMatch(/[\u4e00-\u9fff]/);
      const image = jpeg.decode(
        await readFile(new URL(`../assets/tarot/cards/${card.image}`, import.meta.url)),
      );
      expect([image.width, image.height]).toEqual([300, 527]);
    }
  });

  it("draws without replacement, rotates reversed pixels and composes in position order", async () => {
    const workspaceDir = await workspace();
    vi.mocked(randomInt)
      .mockImplementationOnce(() => 0 as never)
      .mockImplementationOnce(() => 1 as never);
    const result = await drawTarot({ workspaceDir, ...request });
    expect(result.cards.map((card) => card.position)).toEqual(["现状", "阻力", "建议"]);
    expect(new Set(result.cards.map((card) => card.id)).size).toBe(3);
    expect(result.cards.map((card) => card.orientation)).toEqual([
      "reversed",
      "upright",
      "upright",
    ]);
    const deck = await loadTarotDeck();
    const first = deck.find((card) => card.id === result.cards[0].id)!;
    expect(result.cards[0].meaning).toBe(first.reversed);
    const original = jpeg.decode(
      await readFile(new URL(`../assets/tarot/cards/${first.image}`, import.meta.url)),
    );
    const reversed = jpeg.decode(await readFile(result.cards[0].imagePath));
    // Compare interior regions so JPEG edge encoding does not dominate the signal.
    for (const [x, y] of [
      [100, 100],
      [170, 260],
      [90, 390],
    ]) {
      const output = (y * 300 + x) * 4;
      const input = ((526 - y) * 300 + 299 - x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        expect(
          Math.abs(reversed.data[output + channel] - original.data[input + channel]),
        ).toBeLessThan(35);
      }
    }
    const combined = jpeg.decode(await readFile(result.imagePath!));
    expect([combined.width, combined.height]).toEqual([988, 575]);
    for (const [index, card] of result.cards.entries()) {
      const single = jpeg.decode(await readFile(card.imagePath));
      const combinedOffset = ((24 + 260) * combined.width + 24 + index * 320 + 170) * 4;
      const singleOffset = (260 * 300 + 170) * 4;
      for (let channel = 0; channel < 3; channel++) {
        expect(
          Math.abs(combined.data[combinedOffset + channel] - single.data[singleOffset + channel]),
        ).toBeLessThan(35);
      }
    }
  });

  it("recalls persisted selections and shares simultaneous calls for one request", async () => {
    const workspaceDir = await workspace();
    const [one, two] = await Promise.all([
      drawTarot({ workspaceDir, ...request }),
      drawTarot({ workspaceDir, ...request }),
    ]);
    expect(one).toEqual(two);
    expect(randomInt).toHaveBeenCalledTimes(6);
    const recall = await drawTarot({
      workspaceDir,
      scope: request.scope,
      messageId: request.messageId,
    });
    expect(recall).toEqual(one);
    expect(randomInt).toHaveBeenCalledTimes(6);
    await drawTarot({ workspaceDir, ...request, scope: "qq:other-group" });
    expect(randomInt).toHaveBeenCalledTimes(12);
  });

  it("retains sampled cards when rendering fails and only retries rendering", async () => {
    const workspaceDir = await workspace();
    const encode = vi.spyOn(jpeg, "encode").mockImplementationOnce(() => {
      throw new Error("disk failure");
    });
    await expect(drawTarot({ workspaceDir, ...request })).rejects.toThrow("disk failure");
    expect(randomInt).toHaveBeenCalledTimes(6);
    encode.mockRestore();
    const result = await drawTarot({ workspaceDir, ...request });
    expect(result.cards).toHaveLength(3);
    expect(randomInt).toHaveBeenCalledTimes(6);
    const folders = await readdir(join(workspaceDir, "media/outbound/tarot"));
    const selection = JSON.parse(
      await readFile(
        join(workspaceDir, "media/outbound/tarot", folders[0], "selection.json"),
        "utf8",
      ),
    );
    expect(result.cards.map((card) => card.id)).toEqual(
      selection.cards.map((card: { id: string }) => card.id),
    );
  });

  it("returns three oriented singles when only the composite fails", async () => {
    const workspaceDir = await workspace();
    const original = jpeg.encode;
    vi.spyOn(jpeg, "encode").mockImplementation((image, quality) => {
      if (image.width > 300) throw new Error("composite unavailable");
      return original(image, quality);
    });
    const result = await drawTarot({ workspaceDir, ...request });
    expect(result.imagePath).toBeUndefined();
    expect(result.cards).toHaveLength(3);
    await Promise.all(result.cards.map((card) => readFile(card.imagePath)));
  });

  it("recall never samples and cancellation does not begin a draw", async () => {
    const workspaceDir = await workspace();
    await expect(
      drawTarot({ workspaceDir, scope: request.scope, messageId: "missing" }),
    ).rejects.toThrow("No previous");
    await expect(readdir(join(workspaceDir, "media/outbound/tarot"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      drawTarot({ workspaceDir, ...request, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(randomInt).not.toHaveBeenCalled();
  });

  it("expires old readings without resampling and cleans their files on the next draw", async () => {
    const workspaceDir = await workspace();
    const result = await drawTarot({ workspaceDir, ...request });
    const directory = join(result.cards[0].imagePath, "..");
    const path = join(directory, "selection.json");
    const selection = JSON.parse(await readFile(path, "utf8"));
    selection.createdAt = Date.now() - 25 * 60 * 60 * 1000;
    await writeFile(path, JSON.stringify(selection));
    await utimes(path, new Date(selection.createdAt), new Date(selection.createdAt));
    await expect(drawTarot({ workspaceDir, ...request })).rejects.toThrow("expired");
    expect(randomInt).toHaveBeenCalledTimes(6);
    await drawTarot({ workspaceDir, ...request, messageId: "new-question" });
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("continues cleanup beyond a full batch of fresh readings", async () => {
    const workspaceDir = await workspace();
    const root = join(workspaceDir, "media/outbound/tarot");
    await Promise.all(
      Array.from({ length: 1001 }, async (_, index) => {
        const directory = join(root, index.toString(16).padStart(64, "0"));
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, "selection.json"),
          JSON.stringify({ createdAt: Date.now() }),
        );
      }),
    );
    const expired = join(root, "f".repeat(64));
    await mkdir(expired);
    await writeFile(
      join(expired, "selection.json"),
      JSON.stringify({ createdAt: Date.now() - 25 * 60 * 60 * 1000 }),
    );
    await drawTarot({ workspaceDir, ...request });
    await drawTarot({ workspaceDir, ...request, messageId: "another" });
    await expect(readdir(expired)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
