import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, basename } from "node:path";
import {
  SnowLumaWebSocketClient,
  type JsonValue,
  type SnowLumaEvent,
  type SnowLumaWebSocketClientOptions,
} from "@snowluma/sdk";
import { localFile } from "@snowluma/sdk/node";
import { PacedSendQueue, type TypingDelayOptions } from "./send-queue.js";

export type OneBotSegment = { type: string; data: Record<string, JsonValue> };
export interface OneBotEvent {
  [key: string]: unknown;
  post_type?: string;
  message_type?: string;
  sub_type?: string;
  notice_type?: string;
  self_id?: number;
  user_id?: number;
  group_id?: number;
  target_id?: number;
  sender_id?: number;
  message_id?: number;
  time?: number;
  raw_message?: string;
  message?: OneBotSegment[] | string;
  sender?: {
    user_id?: number;
    nickname?: string;
    card?: string;
    group_id?: number;
    [key: string]: unknown;
  };
}
export type OneBotTarget = { kind: "group" | "private"; id: string; groupId?: string };
export type ForwardNode = Omit<OneBotEvent, "message_id"> & { message_id?: string | number };
export type LoginInfo = { user_id: number; nickname: string };
export type TransportStatus = { connected: boolean; error?: string; selfId?: string };
export interface OneBotTransportOptions {
  url: string;
  accessToken?: string;
  expectedSelfId?: string;
  requestTimeoutMs?: number;
  reconnect?: boolean;
  pacing?: TypingDelayOptions;
  onStatus?: (status: TransportStatus) => void;
  /** Injection for isolated WebSocket contract tests. */
  webSocket?: SnowLumaWebSocketClientOptions["webSocket"];
}
export interface UploadOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  roots?: readonly string[];
}

function positiveId(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("Invalid QQ identifier");
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid QQ identifier");
  return id;
}
function messageId(value: string | number): number {
  if (!/^-?\d+$/.test(String(value))) throw new Error("Invalid message identifier");
  const id = Number(value);
  if (!Number.isInteger(id) || id === 0 || id < -2147483648 || id > 2147483647)
    throw new Error("Invalid message identifier");
  return id;
}

/** A deliberately narrow v2.3.4 chat surface. Never exposes SDK raw actions to agents. */
export class OneBotTransport {
  private readonly sendQueue: PacedSendQueue;
  private readonly client: SnowLumaWebSocketClient;
  private readonly listeners = new Set<(event: OneBotEvent) => void>();
  private loginInfo?: LoginInfo;
  private verification?: Promise<LoginInfo>;
  private generation = 0;
  private buffered: OneBotEvent[] = [];
  private closed = false;

  constructor(private readonly options: OneBotTransportOptions) {
    this.sendQueue = new PacedSendQueue(options.pacing);
    const url = new URL(options.url);
    if (
      !["ws:", "wss:"].includes(url.protocol) ||
      url.href.split("://")[1]?.split("/")[0]?.includes("@")
    )
      throw new Error("Expected a ws:// or wss:// endpoint without embedded credentials");
    this.client = new SnowLumaWebSocketClient({
      url: options.url,
      accessToken: options.accessToken,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      reconnect: options.reconnect === false ? false : { minDelayMs: 1000, maxDelayMs: 30_000 },
      role: "Universal",
      ...(options.webSocket ? { webSocket: options.webSocket } : {}),
    });
    this.client.on("open", () => {
      void this.verify().catch((error) => this.status(false, error));
    });
    this.client.on("close", () => {
      this.generation++;
      this.loginInfo = undefined;
      this.verification = undefined;
      this.buffered = [];
      this.status(false);
    });
    this.client.on("error", (error) => this.status(false, error));
    this.client.onEvent((event) => this.receive(event));
  }

  private safeError(error: unknown): Error {
    let text = error instanceof Error ? error.message : String(error);
    if (this.options.accessToken)
      text = text
        .split(this.options.accessToken)
        .join("[redacted]")
        .split(encodeURIComponent(this.options.accessToken))
        .join("[redacted]");
    text = text
      .replace(/([?&](?:access_token|token)=)[^\s&]+/gi, "$1[redacted]")
      .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]");
    return new Error(text);
  }
  private status(connected: boolean, error?: unknown): void {
    this.options.onStatus?.({
      connected,
      ...(this.loginInfo ? { selfId: String(this.loginInfo.user_id) } : {}),
      ...(error ? { error: this.safeError(error).message } : {}),
    });
  }
  private async verify(): Promise<LoginInfo> {
    if (this.loginInfo) return this.loginInfo;
    if (this.verification) return this.verification;
    const generation = this.generation;
    this.verification = (async () => {
      const login = await this.client.getLoginInfo();
      if (this.closed || generation !== this.generation)
        throw new Error("Connection closed during account verification");
      if (!Number.isSafeInteger(login.user_id) || login.user_id <= 0)
        throw new Error("Invalid login identity");
      if (this.options.expectedSelfId && String(login.user_id) !== this.options.expectedSelfId) {
        this.close();
        throw new Error("SnowLuma account does not match expectedSelfId");
      }
      this.loginInfo = login;
      this.status(true);
      const pending = this.buffered;
      this.buffered = [];
      for (const event of pending) this.receive(event as SnowLumaEvent);
      return login;
    })();
    try {
      return await this.verification;
    } finally {
      if (generation === this.generation) this.verification = undefined;
    }
  }
  private receive(raw: SnowLumaEvent): void {
    const event = raw as OneBotEvent;
    if (this.closed) return;
    if (!this.loginInfo) {
      if (this.buffered.length >= 512) {
        this.status(false, new Error("Account verification event buffer exceeded"));
        this.close();
        return;
      }
      this.buffered.push(event);
      return;
    }
    if (event.self_id !== undefined && event.self_id !== this.loginInfo.user_id) {
      this.status(false, new Error("Received event for a different SnowLuma account"));
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.status(this.client.isConnected, error);
      }
    }
  }
  private async operation<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed || !this.loginInfo || !this.client.isConnected)
      throw new Error("SnowLuma is not connected and verified");
    try {
      return await run();
    } catch (error) {
      throw this.safeError(error);
    }
  }
  async connect(): Promise<LoginInfo> {
    this.closed = false;
    try {
      await this.client.connect();
      return await this.verify();
    } catch (error) {
      throw this.safeError(error);
    }
  }
  close(): void {
    void this.sendQueue.close();
    this.closed = true;
    this.generation++;
    this.loginInfo = undefined;
    this.verification = undefined;
    this.buffered = [];
    this.client.close();
  }
  onEvent(listener: (event: OneBotEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  login(): Promise<LoginInfo> {
    return this.operation(async () => this.loginInfo!);
  }

  history(target: OneBotTarget, count: number, before?: string | number): Promise<OneBotEvent[]> {
    if (!Number.isSafeInteger(count) || count < 1 || count > 500)
      return Promise.reject(new Error("History count must be 1–500"));
    return this.operation(async () => {
      const anchor = before === undefined ? 0 : messageId(before);
      const params = { count, message_id: anchor, reverse_order: true };
      const result =
        target.kind === "group"
          ? await this.client.raw("get_group_msg_history", {
              ...params,
              group_id: positiveId(target.id),
            })
          : await this.client.raw("get_friend_msg_history", {
              ...params,
              user_id: positiveId(target.id),
            });
      return result.messages as OneBotEvent[];
    });
  }
  getMessage(id: string | number): Promise<OneBotEvent> {
    return this.operation(
      async () => (await this.client.raw("get_msg", { message_id: messageId(id) })) as OneBotEvent,
    );
  }
  getForward(id: string): Promise<{ messages: ForwardNode[] }> {
    if (!id.trim() || id.length > 4096)
      return Promise.reject(new Error("Invalid forward resource identifier"));
    return this.operation(async () => {
      const result = await this.client.raw("get_forward_msg", { id });
      if (!Array.isArray(result.messages)) throw new Error("Invalid forward response");
      return { messages: result.messages as ForwardNode[] };
    });
  }
  directory(
    kind: "groups" | "friends" | "members",
    groupId?: string,
  ): Promise<Record<string, unknown>[]> {
    return this.operation(async () => {
      const result =
        kind === "groups"
          ? await this.client.getGroupList()
          : kind === "friends"
            ? await this.client.getFriendList()
            : await this.client.getGroupMemberList(positiveId(groupId ?? ""));
      return result as unknown as Record<string, unknown>[];
    });
  }
  send(
    target: OneBotTarget,
    segments: OneBotSegment[],
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message_id: number }> {
    if (!segments.length) return Promise.reject(new Error("Cannot send an empty message"));
    const allowed = new Set(["text", "at", "reply", "face", "image", "record", "video"]);
    if (segments.some((segment) => !allowed.has(segment.type)))
      return Promise.reject(new Error("Unsupported outbound segment"));
    if (target.kind === "private" && segments.some((segment) => segment.type === "at"))
      return Promise.reject(new Error("Private messages do not support @ segments"));
    for (const segment of segments) {
      if (segment.type === "reply") messageId(String(segment.data.id));
      if (segment.type === "at") positiveId(String(segment.data.qq));
    }
    return this.sendQueue.enqueue(
      segments
        .filter((p) => p.type === "text")
        .map((p) => String(p.data.text ?? ""))
        .join(""),
      () =>
        this.operation(() =>
          target.kind === "group"
            ? this.client.sendGroupMessage(positiveId(target.id), segments, options)
            : this.client.raw(
                "send_private_msg",
                {
                  user_id: positiveId(target.id),
                  message: segments,
                  ...(target.groupId ? { group_id: positiveId(target.groupId) } : {}),
                },
                options,
              ),
        ),
      options.signal,
    );
  }
  async uploadLocal(path: string, options: UploadOptions = {}): Promise<string> {
    const actual = await realpath(path);
    const roots = await Promise.all((options.roots ?? []).map((root) => realpath(root)));
    if (
      !roots.some((root) => {
        const part = relative(root, actual);
        return part !== ".." && !part.startsWith("../") && !isAbsolute(part);
      })
    )
      throw new Error("Media file is outside allowed local roots");
    const info = await stat(actual);
    if (!info.isFile() || info.size > (options.maxBytes ?? 50 * 1024 * 1024))
      throw new Error("Media file is not regular or exceeds upload limit");
    return this.operation(async () => {
      const source = await localFile(actual);
      const result = await this.client.uploadFileStream(source.source, {
        filename: basename(actual),
        signal: options.signal,
      });
      return result.file_path;
    });
  }
  uploadBytes(
    bytes: Uint8Array,
    filename: string,
    options: { signal?: AbortSignal; maxBytes?: number } = {},
  ): Promise<string> {
    if (bytes.byteLength > (options.maxBytes ?? 50 * 1024 * 1024))
      return Promise.reject(new Error("Media exceeds upload limit"));
    return this.operation(async () => {
      const result = await this.client.uploadFileStream(bytes, {
        filename: basename(filename || "attachment"),
        signal: options.signal,
      });
      return result.file_path;
    });
  }
  /** Only call with a retained inbound resource; this is not an arbitrary server-file tool. */
  downloadMedia(
    source: string,
    options: {
      signal?: AbortSignal;
      maxBytes?: number;
      kind?: "image" | "record" | "video" | "file";
    } = {},
  ): Promise<{ buffer: Buffer; filename: string }> {
    const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
    if (!source || !Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      return Promise.reject(new Error("Invalid inbound media download"));
    return this.operation(async () => {
      let filename = "attachment";
      let total = 0;
      const chunks: Buffer[] = [];
      const action =
        options.kind === "image"
          ? "download_file_image_stream"
          : options.kind === "record"
            ? "download_file_record_stream"
            : "download_file_stream";
      for await (const chunk of this.client.downloadFileStream(
        { file: source, chunk_size: 64 * 1024 },
        {
          action,
          signal: options.signal,
          maxBufferBytes: 2 * 1024 * 1024,
          maxBufferedFrames: 32,
          onInfo: (info) => {
            if (info.file_size > maxBytes) throw new Error("Inbound media exceeds byte limit");
            filename = basename(info.file_name || "attachment");
          },
        },
      )) {
        total += chunk.byteLength;
        if (total > maxBytes) throw new Error("Inbound media exceeds byte limit");
        chunks.push(Buffer.from(chunk));
      }
      return { buffer: Buffer.concat(chunks, total), filename };
    });
  }
  sendFile(
    target: OneBotTarget,
    serverPath: string,
    name?: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ file_id?: string }> {
    return this.sendQueue.enqueue(
      "",
      () =>
        this.operation(async () => {
          const result =
            target.kind === "group"
              ? await this.client.uploadGroupFile(positiveId(target.id), serverPath, {
                  ...options,
                  name,
                })
              : await this.client.uploadPrivateFile(positiveId(target.id), serverPath, {
                  ...options,
                  name,
                });
          return result as { file_id?: string };
        }),
      options.signal,
    );
  }
  async poke(target: OneBotTarget, userId: string): Promise<void> {
    await this.operation(() =>
      target.kind === "group"
        ? this.client.raw("group_poke", {
            group_id: positiveId(target.id),
            user_id: positiveId(userId),
          })
        : this.client.raw("friend_poke", {
            user_id: positiveId(target.id),
            target_id: positiveId(userId),
          }),
    );
  }
  async reaction(id: string | number, emojiId: string, set = true): Promise<void> {
    if (!emojiId.trim()) throw new Error("Emoji identifier is required");
    await this.operation(() =>
      this.client.raw("set_msg_emoji_like", { message_id: messageId(id), emoji_id: emojiId, set }),
    );
  }
}
