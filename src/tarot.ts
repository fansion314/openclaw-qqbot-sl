import { createHash, randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";

export const TAROT_TOOL_NAME = "snowluma_tarot_draw";
export type TarotSpread = "timeline" | "advice";
type Orientation = "upright" | "reversed";
export interface TarotCard {
  id: string;
  name: string;
  nameZh: string;
  image: string;
  keywords: string[];
  upright: string;
  reversed: string;
}
export interface TarotResult {
  spread: TarotSpread;
  cards: Array<{
    id: string;
    name: string;
    nameZh: string;
    position: string;
    orientation: Orientation;
    keywords: string[];
    meaning: string;
    imagePath: string;
  }>;
  imagePath?: string;
}
interface Selection {
  createdAt: number;
  spread: TarotSpread;
  cards: Array<{ id: string; orientation: Orientation }>;
}
interface DrawOptions {
  workspaceDir: string;
  scope: string;
  messageId: string;
  /** Omit to recall a previous draw without creating a new one. */
  spread?: TarotSpread;
  signal?: AbortSignal;
}
const RETENTION_MS = 24 * 60 * 60 * 1000;
const positions: Record<TarotSpread, string[]> = {
  timeline: ["过去", "现在", "可能走向"],
  advice: ["现状", "阻力", "建议"],
};
const sourceAssets = new URL("../assets/tarot/", import.meta.url);
const assetsDir = fileURLToPath(
  existsSync(sourceAssets) ? sourceAssets : new URL("../../assets/tarot/", import.meta.url),
);
const activeDraws = new Map<string, Promise<TarotResult>>();
let deckPromise: Promise<TarotCard[]> | undefined;
const cleanupCursors = new Map<string, string>();

export function loadTarotDeck(): Promise<TarotCard[]> {
  deckPromise ??= readFile(join(assetsDir, "deck.json"), "utf8").then((text) => {
    const deck = JSON.parse(text) as TarotCard[];
    if (
      !Array.isArray(deck) ||
      deck.length !== 78 ||
      new Set(deck.map((card) => card.id)).size !== 78 ||
      new Set(deck.map((card) => card.image)).size !== 78 ||
      deck.some(
        (card) =>
          !card.id ||
          !card.name ||
          !card.nameZh ||
          !card.upright ||
          !card.reversed ||
          !Array.isArray(card.keywords) ||
          !card.keywords.length ||
          !/^[\w-]+\.jpg$/.test(card.image),
      )
    )
      throw new Error("Invalid packaged tarot deck");
    return deck;
  });
  return deckPromise;
}

async function writeAtomic(path: string, bytes: Uint8Array | string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Remove only expired draw directories owned by this feature, in bounded batches. */
async function cleanExpired(root: string, current: string) {
  const directories = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const cursor = cleanupCursors.get(root) ?? "";
  const start = directories.findIndex((entry) => entry.name > cursor);
  const ordered = [
    ...directories.slice(start < 0 ? 0 : start),
    ...directories.slice(0, start < 0 ? 0 : start),
  ];
  let removed = 0;
  for (const entry of ordered.slice(0, 1000)) {
    cleanupCursors.set(root, entry.name);
    const directory = join(root, entry.name);
    if (directory === current) continue;
    try {
      let createdAt: number;
      try {
        const saved = JSON.parse(await readFile(join(directory, "selection.json"), "utf8"));
        createdAt = saved.createdAt;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        createdAt = (await stat(directory)).mtimeMs;
      }
      if (Number.isFinite(createdAt) && Date.now() - createdAt > RETENTION_MS) {
        await rm(directory, { recursive: true, force: true });
        if (++removed >= 100) break;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
    }
  }
}

async function readSelection(path: string, deck: TarotCard[]): Promise<Selection | undefined> {
  try {
    const selection = JSON.parse(await readFile(path, "utf8")) as Selection;
    if (
      !Number.isFinite(selection.createdAt) ||
      !Object.hasOwn(positions, selection.spread) ||
      !Array.isArray(selection.cards) ||
      selection.cards.length !== 3 ||
      new Set(selection.cards.map((card) => card.id)).size !== 3 ||
      selection.cards.some(
        (card) =>
          !deck.some((item) => item.id === card.id) ||
          !["upright", "reversed"].includes(card.orientation),
      )
    )
      throw new Error("Invalid saved tarot draw");
    return selection;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function selectCards(directory: string, options: DrawOptions, deck: TarotCard[]) {
  const path = join(directory, "selection.json");
  const existing = await readSelection(path, deck);
  if (existing) return existing;
  if (!options.spread) throw new Error("No previous tarot draw for this message");
  const remaining = [...deck];
  const selection: Selection = {
    createdAt: Date.now(),
    spread: options.spread,
    cards: Array.from({ length: 3 }, () => {
      const card = remaining.splice(randomInt(remaining.length), 1)[0];
      return { id: card.id, orientation: randomInt(2) ? "reversed" : "upright" };
    }),
  };
  // Link a complete file exclusively so simultaneous host processes agree on one draw.
  const temporary = join(directory, `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(selection));
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  return (await readSelection(path, deck))!;
}

export async function renderTarotImages(
  directory: string,
  cards: Array<{ image: string; orientation: Orientation }>,
  signal?: AbortSignal,
): Promise<{ images: string[]; imagePath?: string }> {
  const decoded: jpeg.RawImageData<Buffer>[] = [];
  const images: string[] = [];
  for (const [index, card] of cards.entries()) {
    signal?.throwIfAborted();
    const image = jpeg.decode(await readFile(join(assetsDir, "cards", card.image)));
    if (image.width !== 300 || image.height !== 527)
      throw new Error("Invalid tarot image dimensions");
    if (card.orientation === "reversed") {
      const pixels = image.width * image.height;
      const rotated = Buffer.alloc(image.data.length);
      for (let pixel = 0; pixel < pixels; pixel++) {
        image.data.copy(rotated, (pixels - pixel - 1) * 4, pixel * 4, pixel * 4 + 4);
      }
      image.data = rotated;
    }
    const imagePath = join(directory, `${index + 1}.jpg`);
    await writeAtomic(imagePath, jpeg.encode(image, 92).data);
    decoded.push(image);
    images.push(imagePath);
  }
  signal?.throwIfAborted();
  try {
    const margin = 24;
    const gap = 20;
    const border = 2;
    const width = margin * 2 + 300 * 3 + gap * 2;
    const height = margin * 2 + 527;
    const data = Buffer.alloc(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel++) {
      data.set([244, 238, 225, 255], pixel * 4);
    }
    for (const [index, image] of decoded.entries()) {
      const left = margin + index * (300 + gap);
      for (let y = -border; y < image.height + border; y++) {
        for (let x = -border; x < image.width + border; x++) {
          const output = ((margin + y) * width + left + x) * 4;
          if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
            data.set([130, 107, 65, 255], output);
          } else {
            image.data.copy(data, output, (y * image.width + x) * 4, (y * image.width + x + 1) * 4);
          }
        }
      }
    }
    const imagePath = join(directory, "spread.jpg");
    await writeAtomic(imagePath, jpeg.encode({ width, height, data }, 92).data);
    return { images, imagePath };
  } catch {
    // Fully rendered singles provide an ordered fallback for a failed composite.
    signal?.throwIfAborted();
    return { images };
  }
}

async function performDraw(
  options: DrawOptions,
  directory: string,
  root: string,
): Promise<TarotResult> {
  options.signal?.throwIfAborted();
  const deck = await loadTarotDeck();
  const previous = await readSelection(join(directory, "selection.json"), deck);
  if (!previous && !options.spread) throw new Error("No previous tarot draw for this message");
  if (previous && Date.now() - previous.createdAt > RETENTION_MS) {
    await rm(directory, { recursive: true, force: true });
    throw new Error("Tarot draw has expired");
  }
  await mkdir(directory, { recursive: true });
  await cleanExpired(root, directory);
  const selection = previous ?? (await selectCards(directory, options, deck));
  const selected = selection.cards.map((card) => ({
    ...deck.find((item) => item.id === card.id)!,
    ...card,
  }));
  const cached = {
    images: selected.map((_, index) => join(directory, `${index + 1}.jpg`)),
    imagePath: join(directory, "spread.jpg"),
  };
  const complete = await Promise.all(
    [...cached.images, cached.imagePath].map(async (path) => {
      try {
        const metadata = await stat(path);
        return metadata.isFile() && metadata.size > 0;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    }),
  );
  const rendered = complete.every(Boolean)
    ? cached
    : await renderTarotImages(directory, selected, options.signal);
  options.signal?.throwIfAborted();
  return {
    spread: selection.spread,
    imagePath: rendered.imagePath,
    cards: selected.map((card, index) => ({
      id: card.id,
      name: card.name,
      nameZh: card.nameZh,
      position: positions[selection.spread][index],
      orientation: card.orientation,
      keywords: card.keywords,
      meaning: card[card.orientation],
      imagePath: rendered.images[index],
    })),
  };
}

export async function drawTarot(options: DrawOptions): Promise<TarotResult> {
  if (
    !options.scope ||
    !options.messageId ||
    (options.spread && !Object.hasOwn(positions, options.spread))
  ) {
    throw new Error("Invalid tarot draw request");
  }
  const root = join(options.workspaceDir, "media", "outbound", "tarot");
  const key = createHash("sha256")
    .update(JSON.stringify([options.scope, options.messageId]))
    .digest("hex");
  const directory = join(root, key);
  const active = activeDraws.get(directory);
  if (active) {
    const result = await active;
    options.signal?.throwIfAborted();
    return result;
  }
  const pending = performDraw(options, directory, root);
  activeDraws.set(directory, pending);
  try {
    return await pending;
  } finally {
    activeDraws.delete(directory);
  }
}
