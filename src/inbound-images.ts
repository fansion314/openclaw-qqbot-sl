import { basename } from "node:path";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { detectMime } from "openclaw/plugin-sdk/media-runtime";
import type { StoredEvent } from "./store.js";
import type { OneBotTransport } from "./onebot.js";

export interface InboundImageFact {
  path?: string;
  url?: string;
  contentType?: string;
  kind: "image";
  messageId: string;
}
export interface InboundImageOptions {
  /** Total downloaded/saved bytes across this turn; each image is also capped at 10 MiB. */
  maxBytes?: number;
  maxImages?: number;
  signal?: AbortSignal;
  onError?: (error: {
    messageId: string;
    ref: string;
    reason: "download-failed" | "image-limit" | "byte-limit" | "cancelled";
  }) => void;
  /** Isolated test seams; production uses the actual public host loaders. */
  dependencies?: { load?: typeof loadWebMediaRaw; save?: typeof saveMediaBuffer };
}

/** Stage current inbound image bytes so host vision receives local attachments, not URL prose. */
export async function prepareInboundImages(
  events: StoredEvent[],
  transport: Pick<OneBotTransport, "downloadMedia">,
  options: InboundImageOptions = {},
): Promise<InboundImageFact[]> {
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
  const maxImages = options.maxImages ?? 4;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(maxImages) ||
    maxImages < 1
  )
    throw new Error("Invalid inbound image limits");
  const load = options.dependencies?.load ?? loadWebMediaRaw;
  const save = options.dependencies?.save ?? saveMediaBuffer;
  const facts: InboundImageFact[] = [];
  const seen = new Set<string>();
  let attempted = 0;
  let usedBytes = 0;
  for (const event of events) {
    if (event.self || event.trigger === false) continue;
    for (const media of event.media ?? []) {
      if (media.kind !== "image") continue;
      const identity = JSON.stringify([event.accountId, event.conversationKey, media.ref]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const report = (
        reason: Parameters<NonNullable<InboundImageOptions["onError"]>>[0]["reason"],
      ) => {
        options.onError?.({ messageId: media.messageId, ref: media.ref, reason });
      };
      if (options.signal?.aborted) {
        report("cancelled");
        return facts;
      }
      if (attempted >= maxImages) {
        report("image-limit");
        continue;
      }
      if (usedBytes >= maxBytes) {
        report("byte-limit");
        continue;
      }
      attempted++;
      const limit = Math.min(10 * 1024 * 1024, maxBytes - usedBytes);
      try {
        let buffer: Buffer;
        let name: string | undefined;
        let headerMime: string | undefined;
        if (media.url) {
          const url = new URL(media.url);
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.href.split("://")[1]?.split("/")[0]?.includes("@")
          )
            throw new Error("Invalid inbound image URL");
          const loaded = await load(url.href, {
            maxBytes: limit,
            optimizeImages: false,
            requestInit: { signal: options.signal },
          });
          buffer = loaded.buffer;
          name = loaded.fileName;
          headerMime = loaded.contentType;
        } else {
          if (!media.file) throw new Error("Image has no accessible source");
          const downloaded = await transport.downloadMedia(media.file, {
            kind: "image",
            maxBytes: limit,
            signal: options.signal,
          });
          buffer = downloaded.buffer;
          name = downloaded.filename;
        }
        options.signal?.throwIfAborted();
        if (!buffer.byteLength || buffer.byteLength > limit)
          throw new Error("Image exceeds byte limit");
        usedBytes += buffer.byteLength;
        const contentType = await detectMime({ buffer, headerMime, filePath: name });
        if (!contentType?.startsWith("image/"))
          throw new Error("Received resource is not an image");
        const saved = await save(
          buffer,
          contentType,
          "inbound",
          limit,
          basename(media.name ?? name ?? "qq-image"),
          undefined,
          { assertCommitAllowed: () => options.signal?.throwIfAborted() },
        );
        options.signal?.throwIfAborted();
        facts.push({
          kind: "image",
          messageId: media.messageId,
          path: saved.path,
          contentType: saved.contentType ?? contentType,
        });
      } catch {
        // No transport errors or original URLs enter the model context or logs.
        report(options.signal?.aborted ? "cancelled" : "download-failed");
        facts.push({ kind: "image", messageId: media.messageId });
        if (options.signal?.aborted) return facts;
      }
    }
  }
  return facts;
}
