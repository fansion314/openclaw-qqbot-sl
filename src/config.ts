import { readFile } from "node:fs/promises";

export const TARGET_AGENT_ID = "rion";
export const CHANNEL_ID = "qq-snowluma";
export const PLUGIN_ID = "world.fansionia.openclaw-qqbot-snowluma";
export type Mode = "autonomous" | "mention";
export interface ConversationSettings {
  enabled?: boolean;
  mode?: Mode;
  batchIntervalMs?: number;
  initialBatchWaitMs?: number;
  initialBatchMaxWaitMs?: number;
  maxMessages?: number;
  idleEnabled?: boolean;
  idleAfterMs?: number;
  activeHours?: { start: string; end: string };
  timeZone?: string;
  style?: string;
}
export interface AccountSettings extends ConversationSettings {
  name?: string;
  wsUrl?: string;
  accessToken?: string;
  accessTokenEnv?: string;
  accessTokenFile?: string;
  selfId?: string;
  requestTimeoutMs?: number;
  reconnect?: boolean;
  groups?: Record<string, ConversationSettings>;
  privateChats?: Record<string, ConversationSettings>;
  cacheLimit?: number;
  retentionDays?: number;
  statePath?: string;
  maxOutputMessages?: number;
  maxOutputChars?: number;
  mediaMaxBytes?: number;
  mediaRoots?: string[];
  repairFormat?: boolean;
  sendMinDelayMs?: number;
  sendMaxDelayMs?: number;
  sendSaturationChars?: number;
}
export interface ChannelSettings extends AccountSettings {
  accounts?: Record<string, AccountSettings>;
  defaultAccount?: string;
}
export interface ResolvedAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  wsUrl: string;
  settings: AccountSettings;
}
export function channelSettings(cfg: unknown): ChannelSettings {
  return ((cfg as { channels?: Record<string, unknown> })?.channels?.[CHANNEL_ID] ??
    {}) as ChannelSettings;
}
export function listAccountIds(cfg: unknown): string[] {
  const config = channelSettings(cfg);
  return Object.keys(config.accounts ?? {}).length ? Object.keys(config.accounts!) : ["default"];
}
export function resolveAccount(cfg: unknown, accountId?: string | null): ResolvedAccount {
  const base = channelSettings(cfg);
  const id = accountId || base.defaultAccount || listAccountIds(cfg)[0] || "default";
  const { accounts: _accounts, defaultAccount: _default, ...defaults } = base;
  if (
    accountId &&
    base.accounts &&
    Object.keys(base.accounts).length &&
    !Object.hasOwn(base.accounts, id)
  )
    throw new Error(`Unknown SnowLuma account: ${id}`);
  const override = base.accounts?.[id] ?? {};
  const settings: AccountSettings = {
    ...defaults,
    ...override,
    groups: { ...defaults.groups, ...override.groups },
    privateChats: { ...defaults.privateChats, ...override.privateChats },
  };
  return {
    accountId: id,
    name: settings.name,
    enabled: settings.enabled !== false,
    wsUrl: settings.wsUrl ?? "ws://127.0.0.1:3001/",
    settings,
  };
}
export async function resolveToken(account: ResolvedAccount): Promise<string | undefined> {
  const c = account.settings;
  if (c.accessToken !== undefined) return c.accessToken;
  if (c.accessTokenFile) return (await readFile(c.accessTokenFile, "utf8")).trim();
  if (c.accessTokenEnv) {
    const value = process.env[c.accessTokenEnv];
    if (!value) throw new Error(`Missing environment variable ${c.accessTokenEnv}`);
    return value;
  }
  return undefined;
}
export function resolveConversation(
  account: ResolvedAccount,
  kind: "group" | "private",
  id: string,
): Required<
  Pick<
    ConversationSettings,
    "mode" | "batchIntervalMs" | "maxMessages" | "idleEnabled" | "idleAfterMs" | "timeZone"
  >
> &
  ConversationSettings {
  const map = kind === "group" ? account.settings.groups : account.settings.privateChats;
  const specific = map?.[id];
  const inherited = map?.["*"];
  const c = { ...account.settings, ...inherited, ...specific };
  const mode = c.mode ?? "autonomous";
  return {
    ...c,
    enabled: account.enabled && !!(specific || inherited) && c.enabled !== false,
    mode,
    batchIntervalMs: c.batchIntervalMs ?? (kind === "private" ? 0 : 30_000),
    maxMessages: c.maxMessages ?? 100,
    idleEnabled: c.idleEnabled ?? (kind === "group" && mode === "autonomous"),
    idleAfterMs: c.idleAfterMs ?? 3_600_000,
    timeZone: c.timeZone ?? "Asia/Shanghai",
  };
}
export function parseTarget(raw: string): {
  kind: "group" | "private";
  id: string;
  sourceGroupId?: string;
} {
  const text = raw.replace(/^qq-snowluma:/, "");
  const match = /^(group|private):([1-9]\d*)(?::([1-9]\d*))?$/.exec(text);
  if (!match)
    throw new Error(
      "Target must be qq-snowluma:group:GROUP or qq-snowluma:private:QQ[:SOURCE_GROUP]",
    );
  return {
    kind: match[1] as "group" | "private",
    id: match[2]!,
    ...(match[3] ? { sourceGroupId: match[3] } : {}),
  };
}
export function normalizeTarget(raw: string): string | undefined {
  try {
    const t = parseTarget(raw);
    return `${CHANNEL_ID}:${t.kind}:${t.id}${t.sourceGroupId ? `:${t.sourceGroupId}` : ""}`;
  } catch {
    return undefined;
  }
}

const integer = (minimum: number, maximum?: number) => ({
  type: "integer",
  minimum,
  ...(maximum ? { maximum } : {}),
});
const conversationProperties = {
  enabled: { type: "boolean" },
  mode: { type: "string", enum: ["autonomous", "mention"] },
  batchIntervalMs: integer(0),
  initialBatchWaitMs: integer(0, 30000),
  initialBatchMaxWaitMs: integer(0, 30000),
  maxMessages: integer(1, 500),
  idleEnabled: { type: "boolean" },
  idleAfterMs: integer(1000),
  timeZone: { type: "string" },
  style: { type: "string" },
  activeHours: {
    type: "object",
    additionalProperties: false,
    required: ["start", "end"],
    properties: {
      start: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
      end: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
    },
  },
};
const conversationSchema = {
  type: "object",
  additionalProperties: false,
  properties: conversationProperties,
};
const accountProperties = {
  ...conversationProperties,
  name: { type: "string" },
  wsUrl: { type: "string", pattern: "^wss?://" },
  accessToken: { type: "string" },
  accessTokenEnv: { type: "string" },
  accessTokenFile: { type: "string" },
  selfId: { type: "string", pattern: "^[1-9][0-9]*$" },
  requestTimeoutMs: integer(1000),
  reconnect: { type: "boolean" },
  cacheLimit: integer(1),
  retentionDays: integer(1),
  statePath: { type: "string" },
  maxOutputMessages: integer(1, 100),
  maxOutputChars: integer(1),
  mediaMaxBytes: integer(1),
  mediaRoots: { type: "array", items: { type: "string" } },
  repairFormat: { type: "boolean" },
  sendMinDelayMs: integer(1000, 10000),
  sendMaxDelayMs: integer(1000, 10000),
  sendSaturationChars: integer(1, 1000),
  groups: { type: "object", additionalProperties: conversationSchema },
  privateChats: { type: "object", additionalProperties: conversationSchema },
};
export const channelConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...accountProperties,
    defaultAccount: { type: "string" },
    accounts: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: accountProperties,
      },
    },
  },
};

/** Agent ownership is a fixed plugin invariant, never a model or channel-config option. */
export function assertRionConfigured(cfg: unknown): void {
  const agents = (cfg as { agents?: { entries?: Record<string, unknown> } })?.agents?.entries;
  if (!agents || !Object.hasOwn(agents, TARGET_AGENT_ID) || !agents[TARGET_AGENT_ID])
    throw new Error(
      "SnowLuma requires the independent OpenClaw agent rion; create agents.entries.rion and a qq-snowluma binding before enabling this channel",
    );
}
export function assertRionOrigin(origin: {
  agentId?: string | null;
  sessionKey?: string | null;
}): void {
  if (origin.agentId && origin.agentId !== TARGET_AGENT_ID)
    throw new Error("SnowLuma can only be used by agent rion");
  if (origin.sessionKey && !origin.sessionKey.startsWith(`agent:${TARGET_AGENT_ID}:`))
    throw new Error("SnowLuma refuses an origin session belonging to another agent");
  if (
    origin.agentId !== TARGET_AGENT_ID &&
    !origin.sessionKey?.startsWith(`agent:${TARGET_AGENT_ID}:`)
  )
    throw new Error(
      "SnowLuma requires an authenticated rion origin; unscoped and CLI cross-agent sends are refused",
    );
}
