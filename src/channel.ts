import { parseSegments } from "@snowluma/sdk";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  createChannelMessageAdapterFromOutbound,
  sendDurableMessageBatch,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk/core";
import {
  applyAccountNameToChannelSection,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk/core";
import {
  CHANNEL_ID,
  TARGET_AGENT_ID,
  assertRionConfigured,
  assertRionOrigin,
  channelSettings,
  listAccountIds,
  normalizeTarget,
  parseTarget,
  resolveAccount,
  resolveConversation,
  resolveToken,
  type ResolvedAccount,
} from "./config.js";
import {
  OneBotTransport,
  type OneBotEvent,
  type OneBotSegment,
  type OneBotTarget,
} from "./onebot.js";
import { EventStore, type StoredEvent } from "./store.js";
import {
  detectNewCommand,
  authorizeNewCommand,
  liveNewCommand,
  type LiveCommandEvent,
} from "./commands.js";
import { Scheduler } from "./scheduler.js";
import {
  evaluateSessionFreshness,
  resolveSessionResetPolicy,
  resolveChannelResetConfig,
} from "openclaw/plugin-sdk/session-store-runtime";
import { StructuredReplyStream, ProtocolError, type ReplyAction } from "./protocol.js";
import { buildBatchContext, batchUserProfiles, shortUserId, formattingHints } from "./prompt.js";
import {
  uploadAuthorizedMedia,
  uploadInboundMediaReference,
  type MediaAuthorization,
} from "./media.js";
import { formatInboundMessage } from "./inbound.js";
import { resolveIngress } from "./ingress.js";
import { getRuntime } from "./runtime.js";
import { acquireImageLinks } from "./image-service.js";
import { resolveImageToolParams } from "./image-tool.js";
import type { ImageLinks } from "./image-links.js";
import { UserDirectory } from "./users.js";
import { prepareInboundImages } from "./inbound-images.js";

interface RunningAccount {
  users: UserDirectory;
  imageLinks: ImageLinks;
  transport: OneBotTransport;
  store: EventStore;
  scheduler: Scheduler;
  selfId: string;
  stop: () => Promise<void>;
}
const running = new Map<string, RunningAccount>();
const toolRoutes = new Map<string, { accountId: string; target: OneBotTarget }>();
function live(accountId?: string | null): RunningAccount {
  const found = running.get(accountId || "default");
  if (!found) throw new Error("SnowLuma account is not running");
  return found;
}
function target(raw: string): OneBotTarget {
  const t = parseTarget(raw);
  return { kind: t.kind, id: t.id, ...(t.sourceGroupId ? { groupId: t.sourceGroupId } : {}) };
}
function keyFor(account: string, t: OneBotTarget): string {
  return JSON.stringify([account, t.kind, t.id, t.groupId ?? ""]);
}
function targetFor(key: string): OneBotTarget {
  const [, kind, id, groupId] = JSON.parse(key) as string[];
  return { kind: kind as "group" | "private", id: id!, ...(groupId ? { groupId } : {}) };
}
function toFor(t: OneBotTarget): string {
  return `${CHANNEL_ID}:${t.kind}:${t.id}${t.groupId ? `:${t.groupId}` : ""}`;
}
function segments(event: OneBotEvent): OneBotSegment[] {
  return Array.isArray(event.message)
    ? event.message
    : (parseSegments(String(event.raw_message ?? event.message ?? "")) as OneBotSegment[]);
}
function eventText(event: OneBotEvent): string {
  if (event.post_type === "notice")
    return `[${String(event.sub_type ?? event.notice_type)}: ${JSON.stringify({ user_id: event.user_id, sender_id: event.sender_id, target_id: event.target_id, message_id: event.message_id, likes: event.likes })}]`;
  return segments(event)
    .map((part) =>
      part.type === "text"
        ? String(part.data.text ?? "")
        : part.type === "at"
          ? `[@${String(part.data.qq)}]`
          : `[${part.type}: ${JSON.stringify(part.data)}]`,
    )
    .join("");
}
function normalizeEvent(
  event: OneBotEvent,
  account: ResolvedAccount,
  selfId: string,
): StoredEvent | undefined {
  const isGroup = !!event.group_id && event.message_type !== "private";
  const kind = isGroup ? "group" : "private";
  const actor = event.sub_type === "poke" ? (event.sender_id ?? event.user_id) : event.user_id;
  const self = String(actor) === selfId || event.post_type === "message_sent";
  const sender = event.sender as Record<string, unknown> | undefined;
  const id = isGroup
    ? String(event.group_id)
    : self
      ? String(event.target_id ?? event.user_id)
      : String(event.user_id);
  if (!/^[1-9]\d*$/.test(id) || !resolveConversation(account, kind, id).enabled) return undefined;
  const t: OneBotTarget = {
    kind,
    id,
    ...(kind === "private" && sender?.group_id ? { groupId: String(sender.group_id) } : {}),
  };
  const notice = event.post_type === "notice";
  if (
    notice &&
    event.sub_type !== "poke" &&
    ![
      "group_msg_emoji_like",
      "group_recall",
      "friend_recall",
      "group_upload",
      "offline_file",
    ].includes(String(event.notice_type))
  )
    return undefined;
  if (!notice && !["message", "message_sent"].includes(String(event.post_type))) return undefined;
  const poke = notice && event.sub_type === "poke" && String(event.target_id) === selfId;
  const mention =
    !self && (poke || segments(event).some((p) => p.type === "at" && String(p.data.qq) === selfId));
  const body = eventText(event);
  const time = Number(event.time ?? Date.now() / 1000) * 1000;
  const eventId = notice
    ? `notice:${createHash("sha256").update(JSON.stringify(event)).digest("hex")}`
    : String(event.message_id);
  return {
    id: eventId,
    accountId: account.accountId,
    conversationKey: keyFor(account.accountId, t),
    kind,
    time,
    userId: String(event.sender_id ?? event.user_id),
    body,
    mention,
    self,
    payload: { ...event, self_id: Number(selfId) },
    human: !self && !notice,
    trigger: !self && (!notice || poke),
  };
}
async function enrichEvent(event: StoredEvent, bot: OneBotTransport): Promise<StoredEvent> {
  const raw = event.payload as OneBotEvent;
  if (raw.post_type === "notice" && !raw.file) {
    const user = (value: unknown) =>
      /^[1-9]\d*$/.test(String(value)) ? shortUserId(String(value)) : "";
    return {
      ...event,
      formattedBody: `<notice type="${escape(String(raw.notice_type ?? ""))}" subtype="${escape(String(raw.sub_type ?? ""))}" actor_id="${user(raw.sender_id ?? raw.user_id)}" target_id="${user(raw.target_id)}" msg_id="${escape(String(raw.message_id ?? ""))}">${
        Array.isArray(raw.likes)
          ? raw.likes
              .map((item) => {
                const like = item as Record<string, unknown>;
                return `<reaction emoji_id="${escape(String(like.emoji_id ?? ""))}" count="${escape(String(like.count ?? ""))}"></reaction>`;
              })
              .join("")
          : ""
      }</notice>`,
    };
  }
  const file =
    raw.file && typeof raw.file === "object" ? (raw.file as Record<string, unknown>) : undefined;
  const input: OneBotEvent = file
    ? {
        ...raw,
        message: [
          {
            type: "file",
            data: {
              file: String(file.file ?? file.file_id ?? ""),
              url: String(file.url ?? ""),
              name: String(file.name ?? ""),
            },
          },
        ],
      }
    : raw;
  const formatted = await formatInboundMessage(input, bot, { refRootId: event.id });
  return { ...event, formattedBody: formatted.body, media: formatted.media };
}
function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function serialize(action: ReplyAction): string {
  if (action.type === "user-name")
    return `<user-name user_id="${escape(action.userId)}" name="${escape(action.name)}"/>`;
  if (action.type === "no-reply") return "<no-reply></no-reply>";
  if (action.type === "poke") return `<poke user_id="${escape(action.userId)}"/>`;
  if (action.type === "reaction")
    return `<reaction msg_id="${escape(action.messageId)}" emoji_id="${escape(action.emojiId)}" set="${action.set}"/>`;
  return `<msg${action.replyTo ? ` reply_to="${escape(action.replyTo)}"` : ""}${action.at ? ` at="${escape(action.at)}"` : ""}>${action.parts.map((p) => (p.type === "text" ? escape(p.text) : p.type === "face" ? `<face id="${escape(p.id)}"/>` : `<${p.type}${p.ref ? ` ref="${escape(p.ref)}"` : ""}${p.src ? ` src="${escape(p.src)}"` : ""}${p.name ? ` name="${escape(p.name)}"` : ""}/>`)).join("")}</msg>`;
}
function isAllowed(cfg: OpenClawConfig, accountId: string, t: OneBotTarget): ResolvedAccount {
  assertRionConfigured(cfg);
  const account = resolveAccount(cfg, accountId);
  if (!resolveConversation(account, t.kind, t.id).enabled)
    throw new Error("Destination is not in this account allowlist");
  return account;
}
async function nativeAction(
  cfg: OpenClawConfig,
  accountId: string,
  t: OneBotTarget,
  action: ReplyAction,
  signal?: AbortSignal,
  mediaAuthorization: MediaAuthorization = {},
): Promise<string> {
  const account = isAllowed(cfg, accountId, t);
  const state = live(accountId);
  const bot = state.transport;
  const acceptedEffect = (kind: string, result: unknown) =>
    state.store.saveReceipt(`native:${randomUUID()}`, accountId, keyFor(accountId, t), {
      kind,
      providerAccepted: true,
      result,
    });
  if (action.type === "no-reply") return "";
  const known = state.store.select(
    accountId,
    keyFor(accountId, t),
    account.settings.cacheLimit ?? 500,
    true,
  ).events;
  const knownUsers = new Set(known.map((event) => event.userId));
  knownUsers.add(state.selfId);
  function user(short: string): string {
    const full = short === "self" ? state.selfId : state.users.resolve(accountId, short);
    if (!full) throw new Error("Unknown user name");
    if (!knownUsers.has(full)) throw new Error("User is not known in this conversation");
    return full;
  }
  if (action.type === "user-name") {
    if (action.userId === "self") throw new Error("self is the bot identity and cannot be renamed");
    state.users.setName(accountId, user(action.userId), action.name);
    return "";
  }
  function message(id: string): void {
    if (!/^-?[1-9]\d*$/.test(id)) throw new Error("Invalid message identity");
    const hydratedQuote = known.some((event) =>
      (event.formattedBody ?? "").includes(`<reply msg_id="${id}" user_id="`),
    );
    if (!known.some((event) => event.id === id) && !hydratedQuote)
      throw new Error("Message is not known in this conversation");
  }
  if (action.type === "poke") {
    await bot.poke(t, user(action.userId));
    acceptedEffect("poke", null);
    return "";
  }
  if (action.type === "reaction") {
    message(action.messageId);
    await bot.reaction(action.messageId, action.emojiId, action.set);
    acceptedEffect("reaction", null);
    return "";
  }
  if (
    action.parts.some((part) => part.type === "file") &&
    (action.parts.length !== 1 || action.at || action.replyTo)
  )
    throw new Error("A file must occupy a standalone msg without reply or at");
  const parts: OneBotSegment[] = [];
  if (action.replyTo) {
    message(action.replyTo);
    parts.push({ type: "reply", data: { id: action.replyTo } });
  }
  if (action.at) {
    if (t.kind !== "group") throw new Error("@ is only valid in groups");
    parts.push({ type: "at", data: { qq: user(action.at) } });
  }
  for (const p of action.parts) {
    if (p.type === "text") parts.push({ type: "text", data: { text: p.text } });
    else if (p.type === "face") parts.push({ type: "face", data: { id: p.id } });
    else {
      let source = p.src;
      if (p.ref) {
        const resource = known
          .flatMap((event) => event.media ?? [])
          .find((item) => item.ref === p.ref);
        if (!resource || resource.kind !== p.type) throw new Error("Unknown media reference");
        const uploaded = await uploadInboundMediaReference(
          bot,
          resource.file ?? resource.url ?? "",
          p.type,
          { signal, maxBytes: account.settings.mediaMaxBytes ?? 50 * 1024 * 1024 },
        );
        if (p.type === "file") {
          const result = await bot.sendFile(t, uploaded, p.name ?? resource.name, { signal });
          acceptedEffect("file", result);
          return "";
        }
        parts.push({
          type: p.type,
          data: { ...resource.data, file: uploaded } as OneBotSegment["data"],
        });
        continue;
      }
      if (!source) throw new Error("Media source is required");
      const file = await uploadAuthorizedMedia(bot, source, {
        ...mediaAuthorization,
        configuredRoots: account.settings.mediaRoots ?? [],
        maxBytes: account.settings.mediaMaxBytes ?? 50 * 1024 * 1024,
        signal,
      });
      if (p.type === "file") {
        if (parts.length) throw new Error("File must be sent in a separate msg");
        const result = await bot.sendFile(t, file, p.name, { signal });
        acceptedEffect("file", result);
        return "";
      }
      parts.push({ type: p.type, data: { file } });
    }
  }
  const result = await bot.send(t, parts, { signal });
  const id = String(result.message_id);
  state.scheduler.ingest({
    id,
    conversationKey: keyFor(accountId, t),
    accountId,
    kind: t.kind,
    time: Date.now(),
    userId: state.selfId,
    body: action.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join(""),
    mention: false,
    self: true,
    human: false,
    trigger: false,
    payload: { message_id: result.message_id, message: parts, user_id: Number(state.selfId) },
  });
  return id;
}

async function sendStructured(
  cfg: OpenClawConfig,
  accountId: string,
  to: string,
  text: string,
  signal?: AbortSignal,
  mediaAuthorization: MediaAuthorization = {},
): Promise<string> {
  let result = "";
  const stream = new StructuredReplyStream(async (action) => {
    const sent = await nativeAction(cfg, accountId, target(to), action, signal, mediaAuthorization);
    if (sent) result = sent;
  });
  await stream.update({ text });
  await stream.finish();
  return result;
}
const outbound: NonNullable<ChannelPlugin<ResolvedAccount>["outbound"]> = {
  deliveryMode: "direct",
  textChunkLimit: 100_000,
  sendText: async (context) => {
    assertRionOrigin({ sessionKey: context.sessionKey });
    return {
      channel: CHANNEL_ID,
      messageId: await sendStructured(
        context.cfg,
        resolveAccount(context.cfg, context.accountId).accountId,
        context.to,
        context.text,
        undefined,
        {
          mediaAccess: context.mediaAccess,
          mediaLocalRoots: context.mediaLocalRoots,
          mediaReadFile: context.mediaReadFile,
        },
      ),
    };
  },
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    accountId,
    mediaAccess,
    mediaLocalRoots,
    mediaReadFile,
    sessionKey,
  }) => {
    assertRionOrigin({ sessionKey });
    const id = resolveAccount(cfg, accountId).accountId;
    // Core prepares mediaAccess/local-root policy before entering the native adapter.
    void mediaAccess;
    const kind = /\.(mp4|webm|mov)(?:\?|$)/i.test(mediaUrl ?? "")
      ? "video"
      : /\.(mp3|wav|ogg|silk)(?:\?|$)/i.test(mediaUrl ?? "")
        ? "record"
        : /\.(png|jpe?g|gif|webp)(?:\?|$)/i.test(mediaUrl ?? "")
          ? "image"
          : "file";
    return {
      channel: CHANNEL_ID,
      messageId: await nativeAction(
        cfg,
        id,
        target(to),
        {
          type: "message",
          parts: [
            ...(text ? [{ type: "text" as const, text }] : []),
            { type: kind, src: mediaUrl ?? "" },
          ],
        },
        undefined,
        { mediaAccess, mediaLocalRoots, mediaReadFile },
      ),
    };
  },
};

export const snowlumaPlugin: ChannelPlugin<ResolvedAccount> = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "QQ (SnowLuma)",
    selectionLabel: "QQ via SnowLuma OneBot v11",
    docsPath: "/channels/qq-snowluma",
    blurb: "Natural QQ conversations using SnowLuma",
    order: 51,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    threads: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  config: {
    listAccountIds,
    resolveAccount,
    defaultAccountId: (cfg) => resolveAccount(cfg).accountId,
    isEnabled: (a) => a.enabled,
    isConfigured: (a) => !!a.wsUrl,
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: CHANNEL_ID,
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: CHANNEL_ID,
        accountId,
        clearBaseFields: ["wsUrl", "accessToken", "accessTokenFile", "accessTokenEnv"],
      }),
    describeAccount: (a) => ({
      accountId: a.accountId,
      name: a.name,
      enabled: a.enabled,
      configured: !!a.wsUrl,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      Object.keys(resolveAccount(cfg, accountId).settings.privateChats ?? {}),
  },
  setup: {
    resolveAccountId: ({ accountId }) => accountId || "default",
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({ cfg, channelKey: CHANNEL_ID, accountId, name }),
    applyAccountConfig: ({ cfg, accountId, input }) =>
      patchAccount(cfg, accountId, {
        accessToken: input.token,
        accessTokenFile: input.tokenFile,
        name: input.name,
      }),
  },
  setupWizard: {
    channel: CHANNEL_ID,
    getStatus: async ({ cfg }) => ({
      channel: CHANNEL_ID,
      configured: !!channelSettings(cfg).wsUrl,
      statusLines: ["Set a SnowLuma Universal WS endpoint and explicit conversation allowlists."],
    }),
    configure: async ({ cfg, prompter }) => {
      const accountId = String(
        await prompter.text({ message: "Account ID", initialValue: "default" }),
      );
      const wsUrl = String(
        await prompter.text({
          message: "SnowLuma WebSocket URL",
          initialValue: resolveAccount(cfg, accountId).wsUrl,
          validate: (v) => (/^wss?:\/\//.test(v) ? undefined : "Use ws:// or wss://"),
        }),
      );
      const accessTokenEnv = String(
        await prompter.text({
          message: "Access token environment variable (blank for none)",
          initialValue: "SNOWLUMA_ACCESS_TOKEN",
        }),
      );
      const groups = String(
        await prompter.text({
          message: "Allowed group IDs, comma separated (blank = none)",
          initialValue: "",
        }),
      );
      const privateChats = String(
        await prompter.text({
          message: "Allowed private QQ IDs, comma separated (blank = none)",
          initialValue: "",
        }),
      );
      const map = (text: string) =>
        Object.fromEntries(
          text
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean)
            .map((id) => [id, {}]),
        );
      return {
        cfg: patchAccount(cfg, accountId, {
          wsUrl,
          accessTokenEnv: accessTokenEnv || undefined,
          groups: map(groups),
          privateChats: map(privateChats),
        }),
        accountId,
      };
    },
  },
  groups: { resolveRequireMention: () => false },
  agentPrompt: {
    inboundFormattingHints: ({ cfg, accountId }) =>
      formattingHints(resolveAccount(cfg, accountId).settings.style),
  },
  messaging: {
    normalizeTarget,
    targetResolver: {
      looksLikeId: (text) => !!normalizeTarget(text),
      hint: "qq-snowluma:group:GROUP or qq-snowluma:private:QQ[:SOURCE_GROUP]",
    },
  },
  actions: {
    describeMessageTool: (ctx) => {
      try {
        assertRionOrigin({ agentId: ctx.agentId, sessionKey: ctx.sessionKey });
        return { actions: ["send", "react", "read"] };
      } catch {
        return { actions: [] };
      }
    },
    prepareSendPayload: ({ ctx, payload, replyToId }) => {
      assertRionOrigin({ agentId: ctx.agentId, sessionKey: ctx.sessionKey });
      return {
        ...payload,
        text: payload.text
          ? /^\s*<(msg|no-reply|poke|reaction)\b/.test(payload.text)
            ? payload.text
            : serialize({
                type: "message",
                replyTo: replyToId ?? undefined,
                parts: [{ type: "text", text: payload.text }],
              })
          : payload.text,
      };
    },
    handleAction: async (ctx) => {
      assertRionOrigin({ agentId: ctx.agentId, sessionKey: ctx.sessionKey });
      assertRionConfigured(ctx.cfg);
      const scoped = ctx.sessionKey ? toolRoutes.get(ctx.sessionKey) : undefined;
      const t = ctx.params.to ? target(String(ctx.params.to)) : scoped?.target;
      const accountId = resolveAccount(ctx.cfg, ctx.accountId ?? scoped?.accountId).accountId;
      if (!t) throw new Error("Current conversation or explicit destination required");
      isAllowed(ctx.cfg, accountId, t);
      ctx.assertDirectAdapterHandoff?.();
      if (ctx.action === "react") {
        const id = String(ctx.params.messageId ?? ctx.params.message_id ?? "");
        const known = live(accountId).store.select(
          accountId,
          keyFor(accountId, t),
          500,
          true,
        ).events;
        if (!known.some((e) => e.id === id))
          throw new Error("Reaction message is outside current known conversation");
        await live(accountId).transport.reaction(
          id,
          String(ctx.params.emoji ?? ctx.params.emoji_id ?? ""),
          ctx.params.remove !== true,
        );
        return {
          content: [{ type: "text", text: "Reaction accepted" }],
          details: { messageId: id },
        };
      }
      if (ctx.action === "read") {
        const state = live(accountId);
        const events = await state.transport.history(
          t,
          Math.min(100, Math.max(1, Number(ctx.params.limit) || 20)),
        );
        const normalized: StoredEvent[] = [];
        for (const raw of events) {
          const event = normalizeEvent(
            {
              ...raw,
              post_type: raw.post_type ?? "message",
              message_type: t.kind === "group" ? "group" : "private",
              ...(t.kind === "group" ? { group_id: Number(t.id) } : {}),
              ...(String(raw.user_id) === state.selfId ? { target_id: Number(t.id) } : {}),
            },
            resolveAccount(ctx.cfg, accountId),
            state.selfId,
          );
          if (event)
            normalized.push({
              ...(await enrichEvent(event, state.transport)),
              trigger: false,
              human: false,
            });
        }
        state.scheduler.ingestMany(normalized);
        return {
          content: [
            {
              type: "text",
              text: buildBatchContext(
                { events: normalized, trigger: "history", droppedCount: 0 },
                state.selfId,
                "",
                {
                  userLabel: (id) => state.users.display(accountId, id),
                  imageUrl: (url) =>
                    state.imageLinks.compact(url, JSON.stringify([accountId, ctx.sessionKey])),
                },
              ),
            },
          ],
          details: { count: normalized.length },
        };
      }
      throw new Error("Unsupported QQ action");
    },
  },
  outbound,
  message: createChannelMessageAdapterFromOutbound({
    id: CHANNEL_ID,
    outbound,
    capabilities: { text: true, media: true, replyTo: true, messageSendingHooks: true },
  }),
  directory: {
    listGroups: async ({ accountId }) =>
      (await live(accountId).transport.directory("groups")).map((g) => ({
        kind: "group",
        id: String(g.group_id),
        name: String(g.group_name ?? g.group_id),
      })),
    listPeers: async ({ accountId }) =>
      (await live(accountId).transport.directory("friends")).map((g) => ({
        kind: "user",
        id: String(g.user_id),
        name: String(g.nickname ?? g.user_id),
      })),
    listGroupMembers: async ({ accountId, groupId }) =>
      (await live(accountId).transport.directory("members", groupId)).map((g) => ({
        kind: "user",
        id: String(g.user_id),
        name: String(g.card || g.nickname || g.user_id),
      })),
  },
  status: {
    defaultRuntime: { accountId: "default", running: false, connected: false },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: !!account.wsUrl,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastError: runtime?.lastError,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      assertRionConfigured(ctx.cfg);
      const account = ctx.account;
      const rt = getRuntime();
      let selfId = account.settings.selfId ?? "";
      let ready = false;
      let wasConnected = false;
      let backfill = async () => {};
      const bot = new OneBotTransport({
        url: account.wsUrl,
        accessToken: await resolveToken(account),
        expectedSelfId: account.settings.selfId,
        requestTimeoutMs: account.settings.requestTimeoutMs,
        reconnect: account.settings.reconnect,
        pacing: {
          minDelayMs: account.settings.sendMinDelayMs,
          maxDelayMs: account.settings.sendMaxDelayMs,
          saturationChars: account.settings.sendSaturationChars,
        },
        onStatus: (status) => {
          if (status.selfId) selfId = status.selfId;
          ctx.setStatus({
            ...ctx.getStatus(),
            connected: status.connected,
            lastError: status.error ?? null,
          });
          const reconnect = ready && status.connected && !wasConnected;
          wasConnected = status.connected;
          if (reconnect) void backfill().catch((e) => ctx.log?.error(String(e)));
        },
      });
      const statePath =
        account.settings.statePath ??
        join(homedir(), ".openclaw", "state", CHANNEL_ID, `${account.accountId}.sqlite`);
      await mkdir(dirname(statePath), { recursive: true });
      const store = new EventStore(statePath, {
        cacheMaxMessages: account.settings.cacheLimit ?? 500,
        retentionMs: (account.settings.retentionDays ?? 7) * 86400000,
      });
      const users = new UserDirectory(statePath);
      let historyGap = "";
      let stopped = false;
      let ingestion = Promise.resolve();
      let backfillWork = Promise.resolve();
      let imageService: Awaited<ReturnType<typeof acquireImageLinks>> | undefined;
      const scheduler = new Scheduler({
        store,
        policy: (event) => {
          const t = targetFor(event.conversationKey);
          const c = resolveConversation(
            resolveAccount(rt.config.current(), account.accountId),
            t.kind,
            t.id,
          );
          return { ...c, activeHours: c.activeHours ? [c.activeHours] : undefined };
        },
        onError: (error) => ctx.log?.error(String(error)),
        dispatch: async (batch, control) => {
          if (stopped) return;
          const cfg: OpenClawConfig = JSON.parse(JSON.stringify(rt.config.current()));
          const t = targetFor(batch.conversationKey);
          const current = isAllowed(cfg, account.accountId, t);
          const route = rt.channel.routing.resolveAgentRoute({
            cfg,
            channel: CHANNEL_ID,
            accountId: account.accountId,
            peer: {
              kind: t.kind === "group" ? "group" : "direct",
              id: t.kind === "private" && t.groupId ? `${t.id}:${t.groupId}` : t.id,
            },
          });
          if (route.agentId !== TARGET_AGENT_ID)
            throw new Error(
              "qq-snowluma must bind exclusively to agent rion; refusing fallback to another agent",
            );
          assertRionOrigin({ agentId: route.agentId, sessionKey: route.sessionKey });
          const sessionKey =
            t.kind === "private"
              ? `${route.sessionKey}:qq-peer:${t.id}${t.groupId ? `:${t.groupId}` : ""}`
              : route.sessionKey;
          const command = liveNewCommand(batch.events);
          if (command) {
            const authorization = await authorizeNewCommand(
              cfg,
              account.accountId,
              command,
              toFor(t),
            );
            if (!authorization.isAuthorizedSender)
              throw new Error("QQ /new authorization was revoked before dispatch");
            authorization.assertOwnerCurrent?.();
            const ingress = await resolveIngress(
              account.accountId,
              { kind: t.kind === "group" ? "group" : "direct", id: t.id },
              command.userId,
              {
                agentId: route.agentId,
                sessionKey,
                messageId: command.id,
                nativeChannelId: t.id,
                inboundEventKind: "user_request",
              },
            );
            if (ingress.ingress.decision !== "allow")
              throw new Error("QQ /new ingress admission denied");
            const commandContext = rt.channel.inbound.buildContext({
              channel: CHANNEL_ID,
              accountId: account.accountId,
              from: toFor(t),
              sender: { id: command.userId },
              conversation: {
                kind: t.kind === "group" ? "group" : "direct",
                id: t.id,
                nativeChannelId: t.id,
              },
              route: {
                agentId: route.agentId,
                accountId: account.accountId,
                routeSessionKey: sessionKey,
              },
              reply: { to: toFor(t), originatingTo: toFor(t) },
              messageId: command.id,
              message: { body: "/new", rawBody: "/new", bodyForAgent: "/new", commandBody: "/new" },
              command: { kind: "text-slash", body: "/new", authorized: true },
              access: { commands: { authorized: true } },
              channelIngress: ingress,
              extra: { CommandSource: "text", ReplyThreading: { implicitCurrentMessage: "deny" } },
            });
            let replyIndex = 0;
            await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
              cfg,
              ctx: commandContext,
              dispatcherOptions: {
                deliver: async (payload) => {
                  if (payload.isReasoning || !payload.text || payload.text === "NO_REPLY") return;
                  const result = await sendDurableMessageBatch({
                    cfg,
                    channel: CHANNEL_ID,
                    session: { key: sessionKey },
                    accountId: account.accountId,
                    to: toFor(t),
                    payloads: [
                      {
                        text: /^<(?:msg|no-reply|poke|reaction|user-name)\b/.test(
                          payload.text.trim(),
                        )
                          ? payload.text
                          : serialize({
                              type: "message",
                              parts: [{ type: "text", text: payload.text }],
                            }),
                      },
                    ],
                    deliveryIntentId: `${batch.id}:command:${replyIndex++}`,
                    maxRetries: 0,
                    signal: ctx.abortSignal,
                  });
                  if (result.status === "failed" || result.status === "partial_failed")
                    throw result.error;
                },
              },
              replyOptions: {
                abortSignal: ctx.abortSignal,
                disableTools: true,
                suppressDefaultToolProgressMessages: true,
                suppressToolProgressMessages: true,
              },
            });
            authorization.assertOwnerCurrent?.();
            control.accept();
            return;
          }
          const entry = await rt.agent?.session?.getSessionEntryAsync({
            agentId: TARGET_AGENT_ID,
            sessionKey,
            readConsistency: "latest",
          });
          const fresh =
            entry &&
            evaluateSessionFreshness({
              updatedAt: entry.updatedAt,
              sessionStartedAt: entry.sessionStartedAt,
              lastInteractionAt: entry.lastInteractionAt,
              now: Date.now(),
              policy: resolveSessionResetPolicy({
                sessionCfg: cfg.session,
                resetType: t.kind === "group" ? "group" : "direct",
                resetOverride: resolveChannelResetConfig({
                  sessionCfg: cfg.session,
                  channel: CHANNEL_ID,
                }),
              }),
            }).fresh;
          const knownUsers =
            fresh && entry?.sessionId
              ? store.knownSessionUsers(
                  account.accountId,
                  `${entry.sessionId}:${entry.lifecycleRevision ?? ""}`,
                )
              : new Map<string, string>();
          const userLabel = (id: string) => users.display(account.accountId, id);
          const profiles = batchUserProfiles(batch, selfId, userLabel);
          const body = buildBatchContext(
            batch,
            selfId,
            [resolveConversation(current, t.kind, t.id).style, historyGap]
              .filter(Boolean)
              .join("\n"),
            {
              knownUsers,
              userLabel,
              imageUrl: (url) =>
                imageService!.links.compact(url, JSON.stringify([account.accountId, sessionKey])),
            },
          );
          const latest =
            batch.events.filter((event) => !event.self && event.trigger !== false).at(-1) ??
            batch.events.at(-1);
          const ingress =
            batch.trigger === "idle"
              ? undefined
              : await resolveIngress(
                  account.accountId,
                  { kind: t.kind === "group" ? "group" : "direct", id: t.id },
                  latest?.userId ?? selfId,
                  {
                    agentId: route.agentId,
                    sessionKey,
                    messageId: batch.id,
                    nativeChannelId: t.id,
                    inboundEventKind: "user_request",
                  },
                );
          if (ingress?.ingress.decision === "block") return;
          const currentImages = await prepareInboundImages(
            batch.trigger === "idle"
              ? []
              : batch.events.filter((event) => batch.trigger !== "mention" || event.mention),
            bot,
            {
              signal: ctx.abortSignal,
              maxBytes: Math.min(
                current.settings.mediaMaxBytes ?? 20 * 1024 * 1024,
                20 * 1024 * 1024,
              ),
              onError: ({ ref, reason }) => ctx.log?.warn(`QQ image attachment ${ref}: ${reason}`),
            },
          );
          toolRoutes.set(sessionKey, { accountId: account.accountId, target: t });
          const context = rt.channel.inbound.buildContext({
            channel: CHANNEL_ID,
            accountId: account.accountId,
            from: toFor(t),
            sender: {
              id: latest?.userId,
              name: String(
                (latest?.payload as OneBotEvent)?.sender?.nickname ?? latest?.userId ?? "",
              ),
            },
            conversation: {
              kind: t.kind === "group" ? "group" : "direct",
              id: t.id,
              nativeChannelId: t.id,
            },
            route: {
              agentId: route.agentId,
              accountId: account.accountId,
              routeSessionKey: sessionKey,
            },
            reply: { to: toFor(t), originatingTo: toFor(t) },
            messageId: batch.id,
            media: [
              ...currentImages.filter((image) => !!image.path),
              ...batch.events
                .filter((event) => !event.self && event.userId !== selfId)
                .flatMap((event) =>
                  (event.media ?? [])
                    .filter((item) => item.kind !== "image")
                    .filter((item) => !!item.url)
                    .map((item) => ({
                      kind:
                        item.kind === "record"
                          ? ("audio" as const)
                          : item.kind === "video"
                            ? ("video" as const)
                            : item.kind === "image"
                              ? ("image" as const)
                              : ("document" as const),
                      url: item.url,
                      messageId: item.messageId,
                    })),
                ),
            ],
            message: { body, rawBody: body, bodyForAgent: body, commandBody: "" },
            access: { commands: { authorized: false } },
            supplemental: {
              groupSystemPrompt: formattingHints(
                resolveConversation(current, t.kind, t.id).style,
              ).rules.join("\n"),
            },
            channelIngress: ingress,
            extra: {
              ReplyThreading: { implicitCurrentMessage: "deny" },
              ...(batch.trigger === "idle" ? { InternalTurnSource: "heartbeat" } : {}),
            },
          });
          let protocolFailure: unknown;
          let terminalFailure = false;
          const execute = async (repair: boolean) => {
            let partialSeen = false;
            let partialSnapshot = "";
            let deliveredSnapshot = "";
            const stream = new StructuredReplyStream(
              async (action, identity) => {
                if (action.type === "user-name") {
                  await nativeAction(cfg, account.accountId, t, action, ctx.abortSignal);
                  return;
                }
                if (action.type === "no-reply" || (batch.trigger === "idle" && !batch.isCurrent()))
                  return;
                const effectId = `${batch.id}:${repair ? "repair:" : ""}${identity.assistantIndex}:${identity.blockIndex}`;
                const previous = store.receipt(effectId) as { status?: string } | undefined;
                if (previous?.status === "sent" || previous?.status === "suppressed") return;
                if (previous) throw new Error("Previous send outcome requires reconciliation");
                store.saveReceipt(effectId, account.accountId, batch.conversationKey, {
                  status: "sending",
                });
                const result = await sendDurableMessageBatch({
                  cfg,
                  channel: CHANNEL_ID,
                  session: { key: sessionKey },
                  accountId: account.accountId,
                  to: toFor(t),
                  payloads: [{ text: serialize(action) }],
                  runId: `${batch.id}${repair ? ":repair" : ""}`,
                  deliveryIntentId: `${batch.id}:${repair ? "repair:" : ""}${identity.assistantIndex}:${identity.blockIndex}`,
                  maxRetries: 0,
                  signal: ctx.abortSignal,
                });
                store.saveReceipt(effectId, account.accountId, batch.conversationKey, result);
                if (result.status === "failed" || result.status === "partial_failed")
                  throw result.error;
              },
              {
                maxActions: current.settings.maxOutputMessages ?? 10,
                maxMessageChars: current.settings.maxOutputChars ?? 5000,
              },
            );
            await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
              cfg,
              ctx: repair
                ? {
                    ...context,
                    BodyForAgent: `${body}\n上次没有生成可解析的回复。请只输出合法结构，或 <no-reply></no-reply>。`,
                  }
                : context,
              dispatcherOptions: {
                deliver: async (payload) => {
                  if (payload.isReasoning) return;
                  try {
                    const text = payload.text ?? "";
                    if (partialSeen) {
                      if (text.startsWith(partialSnapshot)) await stream.update({ text });
                    } else {
                      if (text.startsWith(deliveredSnapshot)) {
                        await stream.update({ text });
                        deliveredSnapshot = text;
                      } else {
                        await stream.update({ delta: text });
                        deliveredSnapshot += text;
                      }
                    }
                  } catch (e) {
                    protocolFailure = e;
                  }
                },
              },
              replyOptions: {
                abortSignal: ctx.abortSignal,
                suppressDefaultToolProgressMessages: true,
                suppressToolProgressMessages: true,
                onPreparedAgentRunStart: async (start) => {
                  control.accept();
                  const actualSessionId = start?.transcriptStart?.sessionId;
                  if (actualSessionId) {
                    const actualEntry = await rt.agent?.session?.getSessionEntryAsync({
                      agentId: TARGET_AGENT_ID,
                      sessionKey,
                      readConsistency: "latest",
                    });
                    if (actualEntry?.sessionId === actualSessionId)
                      store.recordSessionUsers(
                        account.accountId,
                        `${actualSessionId}:${actualEntry.lifecycleRevision ?? ""}`,
                        profiles,
                      );
                  }
                },
                onAgentRunTerminalOutcome: (outcome) => {
                  terminalFailure = outcome === "failed";
                },
                onAssistantMessageStart: async () => {
                  try {
                    partialSeen = false;
                    partialSnapshot = "";
                    deliveredSnapshot = "";
                    await stream.startAssistant();
                  } catch (e) {
                    protocolFailure = e;
                  }
                  return false;
                },
                onPartialReply: async (payload) => {
                  try {
                    partialSeen = true;
                    partialSnapshot = payload.text ?? partialSnapshot + (payload.delta ?? "");
                    await stream.update(payload);
                  } catch (e) {
                    protocolFailure = e;
                  }
                  return stream.visibleActions > 0;
                },
              },
            });
            try {
              await stream.finish();
            } catch (e) {
              protocolFailure = e;
            }
            return stream.visibleActions;
          };
          try {
            const visible = await execute(false);
            if (
              protocolFailure &&
              !visible &&
              current.settings.repairFormat !== false &&
              protocolFailure instanceof ProtocolError
            ) {
              protocolFailure = undefined;
              await execute(true);
            }
            if (protocolFailure) throw protocolFailure;
            if (terminalFailure) throw new Error("OpenClaw agent run failed");
          } finally {
            toolRoutes.delete(sessionKey);
          }
        },
      });
      const receive = (event: OneBotEvent) => {
        ingestion = ingestion
          .then(async () => {
            if (stopped) return;
            const normalized = normalizeEvent(event, account, selfId);
            if (normalized) {
              const command = detectNewCommand(event, selfId);
              if (command) {
                const cfg: OpenClawConfig = JSON.parse(JSON.stringify(rt.config.current()));
                const authorization = await authorizeNewCommand(
                  cfg,
                  account.accountId,
                  normalized,
                  toFor(targetFor(normalized.conversationKey)),
                );
                if (!authorization.isAuthorizedSender) {
                  ctx.log?.warn(`Ignoring unauthorized QQ /new from sender ${normalized.userId}`);
                  scheduler.ingest({ ...normalized, mention: false, trigger: false });
                  return;
                }
                const commandEvent: LiveCommandEvent = {
                  ...normalized,
                  liveCommand: command,
                  mention: true,
                };
                scheduler.ingest(commandEvent);
              } else scheduler.ingest(await enrichEvent(normalized, bot));
            }
          })
          .catch((e) => ctx.log?.error(String(e)));
      };
      const unsubscribe = bot.onEvent(receive);
      const stop = async () => {
        if (stopped) return;
        stopped = true;
        unsubscribe();
        bot.close();
        await ingestion;
        await backfillWork;
        await scheduler.close();
        await imageService?.release();
        store.close();
        users.close();
        running.delete(account.accountId);
        ctx.setStatus({ ...ctx.getStatus(), running: false, connected: false });
      };
      try {
        const login = await bot.connect();
        selfId = String(login.user_id);
        imageService = await acquireImageLinks(join(dirname(statePath), "image-links.sqlite"));
        running.set(account.accountId, {
          transport: bot,
          store,
          scheduler,
          selfId,
          stop,
          imageLinks: imageService.links,
          users,
        });

        backfill = () => {
          backfillWork = backfillWork.then(async () => {
            if (stopped) return;
            const recovered: StoredEvent[] = [];
            const reconnecting = ready;
            for (const [kind, map] of [
              ["group", account.settings.groups],
              ["private", account.settings.privateChats],
            ] as const) {
              for (const id of Object.keys(map ?? {})) {
                if (stopped) return;
                if (id === "*" || !resolveConversation(account, kind, id).enabled) continue;
                const watermark =
                  store.state(account.accountId, keyFor(account.accountId, { kind, id }))
                    ?.lastActivityAt ?? 0;
                try {
                  for (const event of await bot.history(
                    { kind, id },
                    account.settings.maxMessages ?? 100,
                  )) {
                    const historical = normalizeEvent(
                      {
                        ...event,
                        post_type: event.post_type ?? "message",
                        ...(String(event.user_id) === selfId ? { target_id: Number(id) } : {}),
                        message_type: kind === "group" ? "group" : "private",
                        ...(kind === "group" ? { group_id: Number(id) } : {}),
                      },
                      account,
                      selfId,
                    );
                    if (historical) {
                      const shouldWake =
                        reconnecting && !historical.self && historical.time >= watermark;
                      recovered.push({
                        ...(await enrichEvent(historical, bot)),
                        trigger: shouldWake,
                        human: shouldWake,
                      });
                    }
                  }
                } catch {
                  historyGap = "历史补取失败，当前上下文可能存在缺口。";
                }
              }
            }
            if (!stopped) scheduler.ingestMany(recovered);
          });
          return backfillWork;
        };
        await backfill();
        ready = true;
        await ingestion;
        scheduler.start();
        ctx.setStatus({ ...ctx.getStatus(), running: true, connected: true });
        await new Promise<void>((resolve) => {
          if (ctx.abortSignal.aborted) resolve();
          else ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        await stop();
      }
    },
    stopAccount: async ({ accountId }) => {
      await running.get(accountId)?.stop();
    },
  },
};
function patchAccount(
  cfg: OpenClawConfig,
  accountId: string,
  patch: Partial<ResolvedAccount["settings"]>,
): OpenClawConfig {
  const root = channelSettings(cfg);
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [CHANNEL_ID]: {
        ...root,
        accounts: { ...root.accounts, [accountId]: { ...root.accounts?.[accountId], ...patch } },
      },
    },
  };
}

/** Tools capture a host-owned active route, never a model-selected conversation. */
export function registerConversationTools(api: OpenClawPluginApi): void {
  api.on("before_tool_call", (event, ctx) => {
    if (ctx.agentId !== TARGET_AGENT_ID || !ctx.sessionKey) return;
    const route = toolRoutes.get(ctx.sessionKey);
    if (!route) return;
    const state = running.get(route.accountId);
    if (!state) return;
    const params = resolveImageToolParams(event.toolName, event.params, (url) =>
      state.imageLinks.resolve(url, JSON.stringify([route.accountId, ctx.sessionKey])),
    );
    if (params) return { params };
  });
  api.registerTool(
    (ctx) => {
      if (ctx.messageChannel !== CHANNEL_ID || !ctx.sessionKey) return null;
      try {
        assertRionOrigin({ agentId: ctx.agentId, sessionKey: ctx.sessionKey });
      } catch {
        return null;
      }
      const route = toolRoutes.get(ctx.sessionKey);
      if (!route) return null;
      const tool: AnyAgentTool = {
        name: "snowluma_context",
        label: "SnowLuma conversation",
        description:
          "Read current QQ conversation history, retrieve a known message, or poke a known current participant. IDs must come from provided conversation data.",
        parameters: {
          type: "object",
          properties: {
            operation: {
              type: "string",
              enum: ["history", "message", "poke", "users", "set_name"],
            },
            name: { type: "string", minLength: 1, maxLength: 64 },
            message_id: { type: "string" },
            user_id: { type: "string" },
            count: { type: "integer", minimum: 1, maximum: 100 },
          },
          required: ["operation"],
          additionalProperties: false,
        } as AnyAgentTool["parameters"],
        execute: async (_id, params) => {
          ctx.assertInvocationCurrent?.();
          if (toolRoutes.get(ctx.sessionKey!) !== route)
            throw new Error("Conversation run has ended");
          const cfg = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
          if (!cfg) throw new Error("Runtime configuration unavailable");
          isAllowed(cfg, route.accountId, route.target);
          const state = live(route.accountId);
          const args = params as {
            operation: string;
            message_id?: string;
            user_id?: string;
            count?: number;
            name?: string;
          };
          const known = state.store.select(
            route.accountId,
            keyFor(route.accountId, route.target),
            500,
            true,
          ).events;
          if (args.operation === "users")
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    [...new Set(known.filter((e) => !e.self).map((e) => e.userId))].map((id) => ({
                      user_id: state.users.display(route.accountId, id),
                    })),
                  ),
                },
              ],
              details: {},
            };
          if (args.operation === "poke" || args.operation === "set_name") {
            const id = state.users.resolve(route.accountId, args.user_id ?? "");
            if (!known.some((e) => e.userId === id))
              throw new Error("Unknown conversation participant");
            if (args.operation === "set_name")
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      state.users.setName(route.accountId, id!, args.name ?? ""),
                    ),
                  },
                ],
                details: {},
              };
            ctx.assertInvocationCurrent?.();
            await state.transport.poke(route.target, id!);
            return { content: [{ type: "text", text: "Poke accepted" }], details: {} };
          }
          let events: OneBotEvent[];
          if (args.operation === "message") {
            if (!known.some((e) => e.id === args.message_id))
              throw new Error("Message is not known in current conversation");
            events = [await state.transport.getMessage(args.message_id!)];
          } else if (args.operation === "history")
            events = await state.transport.history(
              route.target,
              Math.min(100, Math.max(1, args.count ?? 20)),
            );
          else throw new Error("Unknown operation");
          const normalized = events
            .map((event) =>
              normalizeEvent(
                {
                  ...event,
                  post_type: event.post_type ?? "message",
                  message_type: route.target.kind === "group" ? "group" : "private",
                  ...(route.target.kind === "group" ? { group_id: Number(route.target.id) } : {}),
                  ...(String(event.user_id) === state.selfId
                    ? { target_id: Number(route.target.id) }
                    : {}),
                },
                resolveAccount(cfg, route.accountId),
                state.selfId,
              ),
            )
            .filter((event): event is StoredEvent => !!event);
          for (let i = 0; i < normalized.length; i++) {
            normalized[i] = await enrichEvent(normalized[i]!, state.transport);
            state.scheduler.ingest({ ...normalized[i]!, trigger: false, human: false });
          }
          return {
            content: [
              {
                type: "text",
                text: buildBatchContext(
                  { events: normalized, trigger: "history", droppedCount: 0 },
                  state.selfId,
                  "",
                  {
                    userLabel: (id) => state.users.display(route.accountId, id),
                    imageUrl: (url) =>
                      state.imageLinks.compact(
                        url,
                        JSON.stringify([route.accountId, ctx.sessionKey]),
                      ),
                  },
                ),
              },
            ],
            details: { count: normalized.length },
          };
        },
      };
      return tool;
    },
    { name: "snowluma_context", optional: true },
  );
}
