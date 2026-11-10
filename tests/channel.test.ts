import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { OneBotEvent, OneBotSegment } from "../src/onebot.js";
import { EventStore } from "../src/store.js";

const mocks = vi.hoisted(() => ({
  bot: undefined as unknown,
  durable: vi.fn(),
  inboundImages: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
}));
vi.mock("../src/inbound-images.js", () => ({
  prepareInboundImages: (...args: unknown[]) => mocks.inboundImages(...args),
}));
vi.mock("../src/onebot.js", () => ({
  OneBotTransport: class {
    handler?: (event: OneBotEvent) => void;
    sends: OneBotSegment[][] = [];
    uploads: Uint8Array[] = [];
    reactions: unknown[][] = [];
    files: string[] = [];
    closed = false;
    historyEvents: OneBotEvent[] = [];
    constructor(
      private options: { onStatus?: (status: { connected: boolean; selfId?: string }) => void },
    ) {
      mocks.bot = this;
    }
    onEvent(handler: (event: OneBotEvent) => void) {
      this.handler = handler;
      return () => {
        this.handler = undefined;
      };
    }
    async connect() {
      return { user_id: 10002, nickname: "Bot" };
    }
    close() {
      this.closed = true;
    }
    async history(target: { kind: string }) {
      return target.kind === "group" ? this.historyEvents : [];
    }
    reconnect() {
      this.options.onStatus?.({ connected: false });
      this.options.onStatus?.({ connected: true, selfId: "10002" });
    }
    async send(_target: unknown, parts: OneBotSegment[]) {
      this.sends.push(parts);
      return { message_id: -900 - this.sends.length };
    }
    async directory() {
      return [];
    }
    async poke() {}
    async reaction(...args: unknown[]) {
      this.reactions.push(args);
    }
    async uploadBytes(bytes: Uint8Array) {
      this.uploads.push(bytes);
      return "/snowluma/upload/authorized";
    }
    async sendFile(_target: unknown, path: string) {
      this.files.push(path);
      return { file_id: "file-proof" };
    }
  },
}));
vi.mock("openclaw/plugin-sdk/channel-outbound", () => ({
  createChannelMessageAdapterFromOutbound: (value: unknown) => value,
  sendDurableMessageBatch: (...args: unknown[]) => mocks.durable(...args),
}));
import { snowlumaPlugin, registerConversationTools } from "../src/channel.js";
import { setRuntime } from "../src/runtime.js";
import { CHANNEL_ID, resolveAccount } from "../src/config.js";

type Bot = {
  handler?: (event: OneBotEvent) => void;
  sends: OneBotSegment[][];
  uploads: Uint8Array[];
  reactions: unknown[][];
  files: string[];
  closed: boolean;
  historyEvents: OneBotEvent[];
  reconnect(): void;
};
type Dispatch = {
  ctx: Record<string, unknown>;
  dispatcherOptions: { deliver(payload: { text?: string; isReasoning?: boolean }): Promise<void> };
  replyOptions: {
    onPreparedAgentRunStart(start?: { transcriptStart: { sessionId: string } }): void;
    onAssistantMessageStart(): Promise<unknown>;
    onPartialReply(payload: { text?: string; delta?: string }): Promise<unknown>;
  };
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.clearAllMocks();
});
async function fixture(
  dispatch: (value: Dispatch) => Promise<void>,
  options: { routeAgent?: string; batchIntervalMs?: number; commandAllowFrom?: string[] } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "snowluma-channel-"));
  const statePath = join(directory, "state.sqlite");
  let sessionId = "fixture-session-1";
  let lifecycleRevision = "initial-generation";
  const cfg = {
    agents: { entries: { rion: { workspace: directory } } },
    ...(options.commandAllowFrom
      ? { commands: { allowFrom: { [CHANNEL_ID]: options.commandAllowFrom } } }
      : {}),
    bindings: [{ agentId: "rion", match: { channel: CHANNEL_ID } }],
    channels: {
      [CHANNEL_ID]: {
        wsUrl: "ws://fixture.invalid/",
        selfId: "10002",
        statePath,
        batchIntervalMs: options.batchIntervalMs,
        initialBatchWaitMs: 0,
        groups: { "20001": {} },
        privateChats: { "10001": {} },
      },
    },
  } as unknown as OpenClawConfig;
  const calls: Dispatch[] = [];
  const errors: string[] = [];
  setRuntime({
    agent: {
      resolveAgentWorkspaceDir: (config: OpenClawConfig, agentId: string) =>
        config.agents!.entries![agentId]!.workspace!,
      session: {
        getSessionEntryAsync: async () => ({ sessionId, lifecycleRevision, updatedAt: Date.now() }),
      },
    },
    config: { current: () => cfg },
    channel: {
      routing: {
        resolveAgentRoute: () => ({
          agentId: options.routeAgent ?? "rion",
          accountId: "default",
          sessionKey: `agent:${options.routeAgent ?? "rion"}:qq-group`,
        }),
      },
      inbound: { buildContext: (value: unknown) => value },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: async (value: Dispatch) => {
          calls.push(value);
          await dispatch(value);
        },
      },
    },
  } as unknown as PluginRuntime);
  mocks.durable.mockImplementation(
    async (input: {
      text?: string;
      payloads: Array<{ text: string }>;
      to: string;
      accountId: string;
      session?: { key: string };
    }) => {
      await snowlumaPlugin.outbound!.sendText!({
        cfg,
        to: input.to,
        accountId: input.accountId,
        text: input.payloads[0]!.text,
        sessionKey: input.session?.key,
      } as Parameters<NonNullable<NonNullable<typeof snowlumaPlugin.outbound>["sendText"]>>[0]);
      return { status: "sent" };
    },
  );
  const abort = new AbortController();
  let status: Record<string, unknown> = {};
  const run = snowlumaPlugin.gateway!.startAccount!({
    account: resolveAccount(cfg),
    accountId: "default",
    cfg,
    runtime: {},
    abortSignal: abort.signal,
    getStatus: () => status,
    setStatus: (value: Record<string, unknown>) => {
      status = value;
    },
    log: { error: (e: string) => errors.push(e), info: () => {}, warn: () => {}, debug: () => {} },
  } as unknown as Parameters<
    NonNullable<NonNullable<typeof snowlumaPlugin.gateway>["startAccount"]>
  >[0]);
  let startupError: unknown;
  void run.catch((error) => {
    startupError = error;
  });
  await vi.waitFor(() => {
    if (startupError) throw startupError;
    expect(status.connected).toBe(true);
  });
  const bot = mocks.bot as Bot;
  const stop = async () => {
    abort.abort();
    await run;
  };
  cleanups.push(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  function emit(id = -123, extra: Partial<OneBotEvent> = {}) {
    bot.handler?.({
      post_type: "message",
      message_type: "group",
      self_id: 10002,
      user_id: 10001,
      group_id: 20001,
      message_id: id,
      time: Date.now() / 1000,
      message: [
        { type: "at", data: { qq: "10002" } },
        { type: "text", data: { text: "请简短回答" } },
      ],
      sender: { user_id: 10001, nickname: "Alice", card: "Group Alice" },
      ...extra,
    });
  }
  return {
    cfg,
    bot,
    calls,
    errors,
    emit,
    stop,
    statePath,
    setSessionId: (id: string) => {
      sessionId = id;
    },
    setLifecycleRevision: (revision: string) => {
      lifecycleRevision = revision;
    },
  };
}

describe("channel orchestration with injected host and transport", () => {
  it("sends structured local images using host-approved rion roots when text delivery has no media hints", async () => {
    const f = await fixture(async () => {});
    const workspace = (f.cfg.agents!.entries!.rion as { workspace: string }).workspace;
    const file = join(workspace, "portrait.png");
    await writeFile(
      file,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    await snowlumaPlugin.outbound!.sendText!({
      cfg: f.cfg,
      accountId: "default",
      to: "qq-snowluma:group:20001",
      sessionKey: "agent:rion:qq-group",
      mediaAccess: {},
      text: `<msg><image src="${file}"/></msg>`,
    } as Parameters<NonNullable<NonNullable<typeof snowlumaPlugin.outbound>["sendText"]>>[0]);
    expect(f.bot.uploads).toHaveLength(1);
    expect(f.bot.sends[0]).toEqual([
      { type: "image", data: { file: "/snowluma/upload/authorized" } },
    ]);
    await expect(
      snowlumaPlugin.outbound!.sendText!({
        cfg: f.cfg,
        accountId: "default",
        to: "qq-snowluma:group:20001",
        sessionKey: "agent:rion:qq-group",
        mediaAccess: { localRoots: [] },
        text: `<msg><image src="${file}"/></msg>`,
      } as Parameters<NonNullable<NonNullable<typeof snowlumaPlugin.outbound>["sendText"]>>[0]),
    ).rejects.toThrow();
    expect(f.bot.uploads).toHaveLength(1);
  });
  it("passes actual staged image paths to the multimodal context, not URL-only facts", async () => {
    mocks.inboundImages.mockResolvedValueOnce([
      {
        kind: "image",
        path: "/tmp/actual-staged-image.png",
        contentType: "image/png",
        messageId: "-457",
      },
    ]);
    const f = await fixture(async ({ ctx, replyOptions }) => {
      expect(ctx.media).toEqual([
        {
          kind: "image",
          path: "/tmp/actual-staged-image.png",
          contentType: "image/png",
          messageId: "-457",
        },
      ]);
      replyOptions.onPreparedAgentRunStart();
      await replyOptions.onPartialReply({ text: "<no-reply></no-reply>" });
    });
    f.emit(-457, {
      message: [{ type: "image", data: { url: "https://example.com/image?long=secret" } }],
    });
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    await f.stop();
    expect(f.errors).toEqual([]);
  });
  it("sets a persistent name then resolves that name for mentions and later input", async () => {
    let turn = 0;
    const f = await fixture(async ({ replyOptions }) => {
      replyOptions.onPreparedAgentRunStart();
      await replyOptions.onPartialReply({
        text:
          ++turn === 1
            ? '<user-name user_id="u7pt" name="小明"/><msg at="小明">记住啦</msg>'
            : "<no-reply></no-reply>",
      });
    });
    f.emit(-371);
    await vi.waitFor(() => expect(f.bot.sends).toHaveLength(1));
    expect(f.bot.sends[0]).toEqual([
      { type: "at", data: { qq: "10001" } },
      { type: "text", data: { text: "记住啦" } },
    ]);
    f.emit(-372);
    await vi.waitFor(() => expect(f.calls).toHaveLength(2));
    await f.stop();
    const body = (f.calls[1]!.ctx.message as { bodyForAgent: string }).bodyForAgent;
    expect(body).toContain('user_id="小明"');
    expect(body).toContain('<user id="小明"');
    expect(f.errors).toEqual([]);
  });
  it("sends the screenshot poke followed by its kaomoji message without dropping the text", async () => {
    const f = await fixture(async ({ replyOptions }) => {
      replyOptions.onPreparedAgentRunStart();
      await replyOptions.onPartialReply({
        text: '<poke user_id="u7pt"/> <msg>也戳你一下喵～ (ﾉ>ω<)ﾉ</msg>',
      });
    });
    f.emit();
    await vi.waitFor(() => expect(f.bot.sends).toHaveLength(1));
    await f.stop();
    expect(f.bot.sends[0]).toEqual([{ type: "text", data: { text: "也戳你一下喵～ (ﾉ>ω<)ﾉ" } }]);
    expect(f.errors).toEqual([]);
  });
  it("replaces long image links in context and resolves image tool calls only for the active rion scope", async () => {
    let before:
      | ((event: unknown, ctx: unknown) => { params?: Record<string, unknown> } | undefined)
      | undefined;
    registerConversationTools({
      on: (_name: unknown, handler: typeof before) => {
        before = handler;
      },
      registerTool: () => {},
    } as unknown as Parameters<typeof registerConversationTools>[0]);
    const original = "https://example.com/qq-image?rkey=long-sensitive-value&size=100";
    const f = await fixture(async ({ ctx, replyOptions }) => {
      const body = (ctx.message as { bodyForAgent: string }).bodyForAgent;
      expect(body).not.toContain("long-sensitive-value");
      const url = /url="([^"]+)"/.exec(body)![1];
      expect(url).toMatch(/^qqimg:[A-Za-z0-9_-]{22}$/);
      expect(
        before!(
          { toolName: "view_image", params: { path: url } },
          { agentId: "rion", sessionKey: "agent:rion:qq-group" },
        )?.params,
      ).toEqual({ path: original });
      expect(
        before!(
          { toolName: "view_image", params: { path: url } },
          { agentId: "main", sessionKey: "agent:rion:qq-group" },
        ),
      ).toBeUndefined();
      replyOptions.onPreparedAgentRunStart();
      await replyOptions.onPartialReply({ text: "<no-reply></no-reply>" });
    });
    f.emit(-345, { message: [{ type: "image", data: { url: original, file: original } }] });
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    await f.stop();
    expect(f.errors).toEqual([]);
  });
  it("announces profiles only after admission and renews them for a new actual session", async () => {
    let sessionId = "fixture-session-1";
    const f = await fixture(async ({ replyOptions }) => {
      replyOptions.onPreparedAgentRunStart({ transcriptStart: { sessionId } });
      await replyOptions.onPartialReply({ text: "<no-reply></no-reply>" });
    });
    f.emit(-123);
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    expect(JSON.stringify(f.calls[0]!.ctx)).toContain("<user ");
    f.emit(-124);
    await vi.waitFor(() => expect(f.calls).toHaveLength(2));
    expect(JSON.stringify(f.calls[1]!.ctx)).not.toContain("<user ");
    sessionId = "fixture-session-2";
    f.setSessionId(sessionId);
    f.emit(-125);
    await vi.waitFor(() => expect(f.calls).toHaveLength(3));
    expect(JSON.stringify(f.calls[2]!.ctx)).toContain("<user ");
    f.setLifecycleRevision("after-native-new");
    f.emit(-126);
    await vi.waitFor(() => expect(f.calls).toHaveLength(4));
    expect(JSON.stringify(f.calls[3]!.ctx)).toContain("<user ");
  });
  it("sends the first closed block before the model finishes, preserving quote and mention", async () => {
    let release!: () => void;
    const gated = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(async ({ replyOptions, dispatcherOptions }) => {
      replyOptions.onPreparedAgentRunStart();
      await replyOptions.onAssistantMessageStart();
      await replyOptions.onPartialReply({
        text: '<msg reply_to="-123" at="u7pt">你好</msg><msg>后',
      });
      await gated;
      await replyOptions.onPartialReply({
        text: '<msg reply_to="-123" at="u7pt">你好</msg><msg>后一句</msg>',
      });
      await dispatcherOptions.deliver({
        text: '<msg reply_to="-123" at="u7pt">你好</msg><msg>后一句</msg>',
      });
    });
    f.emit();
    await vi.waitFor(() => expect(f.bot.sends).toHaveLength(1));
    expect(f.bot.sends[0]).toEqual([
      { type: "reply", data: { id: "-123" } },
      { type: "at", data: { qq: "10001" } },
      { type: "text", data: { text: "你好" } },
    ]);
    release();
    await vi.waitFor(() => expect(f.bot.sends).toHaveLength(2));
    await f.stop();
    expect(f.bot.closed).toBe(true);
    expect(f.errors).toEqual([]);
  });
  it("keeps no-reply silent and records the admitted batch", async () => {
    const f = await fixture(async ({ replyOptions }) => {
      replyOptions.onPreparedAgentRunStart();
      await replyOptions.onPartialReply({ text: "<no-reply></no-reply>" });
    });
    f.emit();
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    await f.stop();
    expect(f.bot.sends).toHaveLength(0);
    expect(mocks.durable).not.toHaveBeenCalled();
    const store = new EventStore(f.statePath);
    expect(
      store.pending("default", JSON.stringify(["default", "group", "20001", ""])).triggerable,
    ).toBe(false);
    store.close();
  });
  it("repairs malformed output once and emits only the corrected message", async () => {
    let attempt = 0;
    const f = await fixture(async ({ replyOptions }) => {
      replyOptions.onPreparedAgentRunStart();
      await replyOptions.onPartialReply({
        text: ++attempt === 1 ? "unstructured" : "<msg>已修正</msg>",
      });
    });
    f.emit();
    await vi.waitFor(() => expect(f.bot.sends).toHaveLength(1));
    await f.stop();
    expect(f.calls).toHaveLength(2);
    expect(f.bot.sends[0]).toEqual([{ type: "text", data: { text: "已修正" } }]);
  });
  it("does not replay a visible block to repair a later malformed block", async () => {
    const f = await fixture(async ({ replyOptions }) => {
      replyOptions.onPreparedAgentRunStart();
      await replyOptions.onPartialReply({ text: "<msg>已发送</msg>broken" });
    });
    f.emit();
    await vi.waitFor(() => expect(f.errors).not.toHaveLength(0));
    await f.stop();
    expect(f.calls).toHaveLength(1);
    expect(f.bot.sends).toHaveLength(1);
  });
  it("rejects cross-conversation quoted IDs without sending", async () => {
    const f = await fixture(async ({ replyOptions }) => {
      replyOptions.onPreparedAgentRunStart();
      await replyOptions.onPartialReply({ text: '<msg reply_to="-999">bad target</msg>' });
    });
    f.emit();
    await vi.waitFor(() => expect(f.errors).not.toHaveLength(0));
    await f.stop();
    expect(f.bot.sends).toHaveLength(0);
    expect(f.calls).toHaveLength(1);
  });
  it("does not admit an unconfigured conversation or loop on self events", async () => {
    const f = await fixture(async () => {});
    f.emit(-124, { group_id: 20002 });
    f.emit(-125, { post_type: "message_sent", user_id: 10002 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.calls).toHaveLength(0);
  });
  it("attributes queued messages to the human trigger even after a newer bot echo", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let count = 0;
    const f = await fixture(async ({ replyOptions }) => {
      replyOptions.onPreparedAgentRunStart();
      if (++count === 1) {
        await gate;
        await replyOptions.onPartialReply({ text: "<msg>first reply</msg>" });
      } else await replyOptions.onPartialReply({ text: "<no-reply></no-reply>" });
    });
    f.emit(-123);
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    f.emit(-124);
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await vi.waitFor(() => expect(f.calls).toHaveLength(2));
    await f.stop();
    expect(f.calls[1]!.ctx.sender).toMatchObject({ id: "10001" });
  });
  it("passes a real resolver result into the host context", async () => {
    const f = await fixture(async ({ replyOptions }) => {
      replyOptions.onPreparedAgentRunStart();
      await replyOptions.onPartialReply({ text: "<no-reply></no-reply>" });
    });
    f.emit();
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    await f.stop();
    const ingress = f.calls[0]!.ctx.channelIngress as { ingress: { decision: string } };
    expect(ingress).toBeTypeOf("object");
    expect(ingress.ingress.decision).not.toBe("block");
    expect(f.calls[0]!.ctx.messageId).toBeTypeOf("string");
    expect(f.calls[0]!.ctx.channelIngress).not.toBe("unsupported");
  });
  it("ignores delivered subset finals and preserves identical later assistant messages", async () => {
    const f = await fixture(async ({ replyOptions, dispatcherOptions }) => {
      replyOptions.onPreparedAgentRunStart();
      await replyOptions.onAssistantMessageStart();
      await replyOptions.onPartialReply({ text: "<msg>同一句</msg><msg>补充</msg>" });
      await dispatcherOptions.deliver({ text: "<msg>同一句</msg>" });
      await dispatcherOptions.deliver({ text: "<msg>补充</msg>" });
      await replyOptions.onAssistantMessageStart();
      await replyOptions.onPartialReply({ text: "<msg>同一句</msg>" });
      await dispatcherOptions.deliver({ text: "<msg>同一句</msg>" });
    });
    f.emit();
    await vi.waitFor(() => expect(f.bot.sends).toHaveLength(3));
    await f.stop();
    expect(f.errors).toEqual([]);
    expect(f.bot.sends.map((parts) => parts[0]!.data.text)).toEqual(["同一句", "补充", "同一句"]);
  });
  it("refuses a replacement of an already sent prefix without sending again", async () => {
    const f = await fixture(async ({ replyOptions }) => {
      replyOptions.onPreparedAgentRunStart();
      await replyOptions.onPartialReply({ text: "<msg>已发送</msg>" });
      await replyOptions.onPartialReply({ text: "<msg>替换</msg>" });
    });
    f.emit();
    await vi.waitFor(() => expect(f.errors).not.toHaveLength(0));
    await f.stop();
    expect(f.bot.sends).toHaveLength(1);
    expect(f.calls).toHaveLength(1);
  });
  it("prevalidates standalone files before upload and sends authorized image bytes", async () => {
    const f = await fixture(async ({ replyOptions }) => {
      replyOptions.onPreparedAgentRunStart();
      await replyOptions.onPartialReply({ text: "<no-reply></no-reply>" });
    });
    const directory = await mkdtemp(join(tmpdir(), "snowluma-channel-media-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, "image.png");
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(file, bytes);
    type SendText = Parameters<
      NonNullable<NonNullable<typeof snowlumaPlugin.outbound>["sendText"]>
    >[0];
    await expect(
      snowlumaPlugin.outbound!.sendText!({
        cfg: f.cfg,
        accountId: "default",
        sessionKey: "agent:rion:qq-group",
        to: "qq-snowluma:group:20001",
        text: `<msg><file src="${file}"/>trailing</msg>`,
      } as SendText),
    ).rejects.toThrow("standalone");
    expect(f.bot.files).toHaveLength(0);
    expect(f.bot.uploads).toHaveLength(0);
    type SendMedia = Parameters<
      NonNullable<NonNullable<typeof snowlumaPlugin.outbound>["sendMedia"]>
    >[0];
    await expect(
      snowlumaPlugin.outbound!.sendMedia!({
        cfg: f.cfg,
        accountId: "default",
        sessionKey: "agent:rion:qq-group",
        to: "qq-snowluma:group:20001",
        mediaUrl: file,
        text: "",
        mediaAccess: { localRoots: [] },
      } as SendMedia),
    ).rejects.toThrow();
    await snowlumaPlugin.outbound!.sendMedia!({
      cfg: f.cfg,
      accountId: "default",
      sessionKey: "agent:rion:qq-group",
      to: "qq-snowluma:group:20001",
      mediaUrl: file,
      text: "",
      mediaAccess: { localRoots: [directory] },
    } as SendMedia);
    expect(Buffer.from(f.bot.uploads[0]!)).toEqual(bytes);
    expect(f.bot.sends[0]).toEqual([
      { type: "image", data: { file: "/snowluma/upload/authorized" } },
    ]);
  });
  it("exposes shared reactions while enforcing message conversation scope", async () => {
    const f = await fixture(async ({ replyOptions }) => {
      replyOptions.onPreparedAgentRunStart();
      await replyOptions.onPartialReply({ text: "<no-reply></no-reply>" });
    });
    f.emit();
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    const context = {
      cfg: f.cfg,
      accountId: "default",
      agentId: "rion",
      sessionKey: "agent:rion:qq-group",
      channel: CHANNEL_ID,
      action: "react",
      params: { to: "qq-snowluma:group:20001", messageId: "-123", emoji: "128077" },
    } as Parameters<NonNullable<NonNullable<typeof snowlumaPlugin.actions>["handleAction"]>>[0];
    await snowlumaPlugin.actions!.handleAction!(context);
    expect(f.bot.reactions).toEqual([["-123", "128077", true]]);
    await expect(
      snowlumaPlugin.actions!.handleAction!({
        ...context,
        params: { ...context.params, messageId: "-999" },
      }),
    ).rejects.toThrow("conversation");
    expect(f.bot.reactions).toHaveLength(1);
  });
  it("rejects a fallback main route before agent admission", async () => {
    const f = await fixture(
      async () => {
        throw new Error("must not dispatch");
      },
      { routeAgent: "main" },
    );
    f.emit();
    await vi.waitFor(() => expect(f.errors.some((error) => error.includes("rion"))).toBe(true));
    await f.stop();
    expect(f.calls).toHaveLength(0);
    expect(f.bot.sends).toHaveLength(0);
    const store = new EventStore(f.statePath);
    expect(
      store.pending("default", JSON.stringify(["default", "group", "20001", ""])).triggerable,
    ).toBe(true);
    store.close();
  });
  it("rejects main and unscoped outbound before native effects", async () => {
    const f = await fixture(async () => {});
    type SendText = Parameters<
      NonNullable<NonNullable<typeof snowlumaPlugin.outbound>["sendText"]>
    >[0];
    for (const sessionKey of ["agent:main:qq-group", undefined]) {
      await expect(
        snowlumaPlugin.outbound!.sendText!({
          cfg: f.cfg,
          accountId: "default",
          to: "qq-snowluma:group:20001",
          text: "<msg>blocked</msg>",
          sessionKey,
        } as SendText),
      ).rejects.toThrow(/rion|another agent/);
    }
    expect(f.bot.sends).toHaveLength(0);
    expect(f.bot.uploads).toHaveLength(0);
  });
  it("admits all newly recovered reconnect messages as one batch", async () => {
    const f = await fixture(
      async ({ replyOptions }) => {
        replyOptions.onPreparedAgentRunStart();
        await replyOptions.onPartialReply({ text: "<no-reply></no-reply>" });
      },
      { batchIntervalMs: 0 },
    );
    f.emit();
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    f.bot.historyEvents = [-201, -202].map((id, index) => ({
      message_id: id,
      time: Date.now() / 1000 + index + 1,
      user_id: 10001,
      group_id: 20001,
      message_type: "group",
      message: [{ type: "text", data: { text: `recovered${index}` } }],
      sender: { nickname: "Alice" },
    }));
    f.bot.reconnect();
    await vi.waitFor(() => expect(f.calls).toHaveLength(2));
    await f.stop();
    const message = f.calls[1]!.ctx.message as { bodyForAgent: string };
    expect(message.bodyForAgent).toContain('msg_id="-201"');
    expect(message.bodyForAgent).toContain('msg_id="-202"');
    expect(f.calls[1]!.ctx.sender).toMatchObject({ id: "10001" });
  });
  it("routes exact authorized live /new to core and sends its plaintext ack without model-format repair", async () => {
    const f = await fixture(
      async ({ ctx, dispatcherOptions, replyOptions }) => {
        expect(ctx.message).toMatchObject({
          body: "/new",
          rawBody: "/new",
          bodyForAgent: "/new",
          commandBody: "/new",
        });
        expect(ctx.command).toMatchObject({ kind: "text-slash", body: "/new", authorized: true });
        expect(ctx.access).toMatchObject({ commands: { authorized: true } });
        expect(ctx.sender).toMatchObject({ id: "10001" });
        expect(replyOptions.onPartialReply).toBeUndefined();
        await dispatcherOptions.deliver({ text: "✅ New session started. <reset>" });
      },
      { batchIntervalMs: 60_000, commandAllowFrom: ["10001"] },
    );
    f.emit(-777, { message: [{ type: "text", data: { text: "/new" } }] });
    await vi.waitFor(() => expect(f.bot.sends).toHaveLength(1));
    await f.stop();
    expect(f.calls).toHaveLength(1);
    expect(f.bot.sends[0]).toEqual([
      { type: "text", data: { text: "✅ New session started. <reset>" } },
    ]);
    const store = new EventStore(f.statePath);
    expect(
      store.pending("default", JSON.stringify(["default", "group", "20001", ""])).triggerable,
    ).toBe(false);
    store.close();
  });
  it("does not grant arbitrary group members /new control access", async () => {
    const f = await fixture(async () => {
      throw new Error("Unauthorized command reached the model");
    });
    f.emit(-778, { message: [{ type: "text", data: { text: "/new" } }] });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await f.stop();
    expect(f.calls).toHaveLength(0);
    expect(f.bot.sends).toHaveLength(0);
  });
  it("keeps recovered /new history as ordinary structured context, never a reset", async () => {
    const f = await fixture(
      async ({ ctx, replyOptions }) => {
        expect(ctx.command).toBeUndefined();
        expect(ctx.message).toMatchObject({ commandBody: "" });
        replyOptions.onPreparedAgentRunStart();
        await replyOptions.onPartialReply({ text: "<no-reply></no-reply>" });
      },
      { batchIntervalMs: 0, commandAllowFrom: ["10001"] },
    );
    f.bot.historyEvents = [
      {
        message_id: -779,
        time: Date.now() / 1000 + 1,
        user_id: 10001,
        message_type: "group",
        group_id: 20001,
        message: [{ type: "text", data: { text: "/new" } }],
      },
    ];
    f.bot.reconnect();
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    await f.stop();
    expect(f.bot.sends).toHaveLength(0);
  });
  it("leaves an event pending when host fails before confirming admission", async () => {
    const f = await fixture(async () => {
      throw new Error("host unavailable before admission");
    });
    f.emit();
    await vi.waitFor(() => expect(f.errors).not.toHaveLength(0));
    await f.stop();
    const store = new EventStore(f.statePath);
    expect(
      store.pending("default", JSON.stringify(["default", "group", "20001", ""])).triggerable,
    ).toBe(true);
    store.close();
  });
});
