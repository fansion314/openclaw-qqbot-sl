import { describe, expect, it } from "vite-plus/test";
import { resolveAccount, resolveConversation, parseTarget, listAccountIds } from "../src/config.js";
describe("account and conversation policy", () => {
  it("denies empty allowlists and defaults group autonomy/private immediacy", () => {
    const a = resolveAccount({});
    expect(resolveConversation(a, "group", "1").enabled).toBe(false);
    const b = resolveAccount({
      channels: { "qq-snowluma": { groups: { "1": {} }, privateChats: { "2": {} } } },
    });
    expect(resolveConversation(b, "group", "1")).toMatchObject({
      enabled: true,
      idleEnabled: true,
      batchIntervalMs: 30000,
    });
    expect(resolveConversation(b, "private", "2")).toMatchObject({
      enabled: true,
      idleEnabled: false,
      batchIntervalMs: 0,
    });
  });
  it("isolates account overrides and disables mention idle by default", () => {
    const cfg = {
      channels: {
        "qq-snowluma": {
          groups: { "1": {} },
          accounts: {
            a: { wsUrl: "ws://a/", groups: { "2": { mode: "mention" } } },
            b: { enabled: false },
          },
        },
      },
    };
    expect(listAccountIds(cfg)).toEqual(["a", "b"]);
    expect(resolveConversation(resolveAccount(cfg, "a"), "group", "2")).toMatchObject({
      enabled: true,
      mode: "mention",
      idleEnabled: false,
    });
    expect(resolveConversation(resolveAccount(cfg, "b"), "group", "1").enabled).toBe(false);
  });
  it("preserves group-origin temporary direct targets", () => {
    expect(parseTarget("qq-snowluma:private:10001:20001")).toEqual({
      kind: "private",
      id: "10001",
      sourceGroupId: "20001",
    });
    expect(() => parseTarget("group:-1")).toThrow();
  });
});

it("rejects unknown explicit accounts and supports explicit enable over wildcard disable", () => {
  expect(() =>
    resolveAccount({ channels: { "qq-snowluma": { accounts: { a: {} } } } }, "b"),
  ).toThrow("Unknown");
  const a = resolveAccount({
    channels: { "qq-snowluma": { groups: { "*": { enabled: false }, "1": { enabled: true } } } },
  });
  expect(resolveConversation(a, "group", "1").enabled).toBe(true);
  expect(resolveConversation(a, "group", "2").enabled).toBe(false);
});

it("publishes the exact runtime schema in the cold-path manifest", async () => {
  const { readFileSync } = await import("node:fs");
  const { channelConfigSchema, CHANNEL_ID } = await import("../src/config.js");
  const manifest = JSON.parse(
    readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  );
  expect(manifest.channelConfigs[CHANNEL_ID].schema).toEqual(channelConfigSchema);
});

it("requires the independent rion agent and rejects main or unscoped origins", async () => {
  const { assertRionConfigured, assertRionOrigin } = await import("../src/config.js");
  expect(() => assertRionConfigured({ agents: { entries: { main: {} } } })).toThrow("independent");
  expect(() => assertRionConfigured({ agents: { entries: { main: {}, rion: {} } } })).not.toThrow();
  expect(() => assertRionOrigin({})).toThrow("authenticated rion");
  expect(() => assertRionOrigin({ agentId: "main", sessionKey: "agent:rion:main" })).toThrow(
    "only",
  );
  expect(() => assertRionOrigin({ agentId: "rion", sessionKey: "agent:main:main" })).toThrow(
    "another agent",
  );
  expect(() => assertRionOrigin({ sessionKey: "agent:rion:qq-snowluma:group:123" })).not.toThrow();
});
