import {
  buildOutboundMediaLoadOptions,
  type OutboundMediaAccess,
  type OutboundMediaReadFile,
} from "openclaw/plugin-sdk/media-runtime";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import type { OneBotTransport } from "./onebot.js";

export interface MediaAuthorization {
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: OutboundMediaReadFile;
  configuredRoots?: readonly string[];
  maxBytes?: number;
  signal?: AbortSignal;
}

/** Resolve through the host loader before any SnowLuma read or download. */
export async function prepareOutboundMedia(source: string, options: MediaAuthorization = {}) {
  options.signal?.throwIfAborted();
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid media byte limit");
  const localRoots =
    options.mediaAccess?.localRoots ?? options.mediaLocalRoots ?? options.configuredRoots ?? [];
  if (!/^https?:\/\//i.test(source) && !localRoots.length)
    throw new Error("No authorized local media roots");
  const load = buildOutboundMediaLoadOptions({
    maxBytes,
    optimizeImages: false,
    mediaAccess: options.mediaAccess ? { ...options.mediaAccess, localRoots } : undefined,
    mediaLocalRoots: options.mediaAccess ? undefined : localRoots,
    mediaReadFile: options.mediaReadFile,
  });
  const media = await loadWebMediaRaw(source, load);
  options.signal?.throwIfAborted();
  if (media.buffer.byteLength > maxBytes) throw new Error("Media exceeds upload limit");
  return media;
}

/** Upload authorized bytes, never forward an unchecked URL or local path to QQ. */
export async function uploadAuthorizedMedia(
  transport: OneBotTransport,
  source: string,
  options: MediaAuthorization = {},
): Promise<string> {
  const media = await prepareOutboundMedia(source, options);
  return transport.uploadBytes(media.buffer, media.fileName ?? "attachment", {
    signal: options.signal,
    maxBytes: options.maxBytes,
  });
}

/** The caller must prove ref provenance in the active conversation before this path. */
export async function uploadInboundMediaReference(
  transport: OneBotTransport,
  source: string,
  kind: "image" | "record" | "video" | "file",
  options: Pick<MediaAuthorization, "maxBytes" | "signal"> = {},
): Promise<string> {
  const media = await transport.downloadMedia(source, { ...options, kind });
  return transport.uploadBytes(media.buffer, media.filename, options);
}
