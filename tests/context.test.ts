import { describe, expect, it } from "vite-plus/test";
import { batchUserProfiles, buildBatchContext, IDLE_PROMPT } from "../src/prompt.js";

const message = (id: string, userId = "10001", extra: Record<string, unknown> = {}) => ({
  id,
  userId,
  time: 0,
  body: `message ${id}`,
  self: false,
  mention: false,
  payload: { sender: { nickname: "Alice", card: "A" } },
  ...extra,
});
describe("readable incremental input", () => {
  it("uses self consistently in mentions, quotes and notices", () => {
    const result = buildBatchContext(
      {
        trigger: "message",
        droppedCount: 0,
        events: [
          message("1", "10001", {
            formattedBody:
              '<at user_id="u7pu"></at><reply user_id="u7pu"></reply><notice actor_id="u7pu" target_id="u7pu"></notice>',
          }),
        ],
      },
      "10002",
    );
    expect(result).toContain('<at user_id="self"/>');
    expect(result).not.toContain("u7pu");
    expect(result).toContain('actor_id="self"');
    expect(result).toContain('target_id="self"');
  });
  it("defines a user at first occurrence, then only when metadata changes", () => {
    const batch = { trigger: "message", droppedCount: 0, events: [message("1"), message("2")] };
    const first = buildBatchContext(batch, "10002");
    expect(first.match(/<user /g)).toHaveLength(1);
    expect(
      buildBatchContext(batch, "10002", "", { knownUsers: batchUserProfiles(batch, "10002") }),
    ).not.toContain("<user ");
    const changed = {
      ...batch,
      events: [
        message("3", "10001", { payload: { sender: { nickname: "Alice", card: "new name" } } }),
      ],
    };
    expect(
      buildBatchContext(changed, "10002", "", { knownUsers: batchUserProfiles(batch, "10002") }),
    ).toContain('groupcard="new name"');
  });
  it("excludes self echoes and does not emit a profile for the bot", () => {
    const result = buildBatchContext(
      {
        trigger: "message",
        droppedCount: 0,
        events: [message("1", "10002", { self: true }), message("2", "10002"), message("3")],
      },
      "10002",
    );
    expect(result).not.toContain('msg_id="1"');
    expect(result).not.toContain('msg_id="2"');
    expect(result).toContain('msg_id="3"');
    expect(result).not.toContain('<user id="u7pu"');
  });
  it("marks supplemental history and keeps current messages without a wrapper", () => {
    const result = buildBatchContext(
      {
        trigger: "mention",
        droppedCount: 0,
        events: [
          message("1", "10001", { trigger: false }),
          message("2"),
          message("3", "10001", { mention: true }),
        ],
      },
      "10002",
    );
    expect(result).toMatch(/^```xml\n<time>/);
    const history = result.slice(result.indexOf("<history>"), result.indexOf("</history>"));
    const current = result.slice(result.indexOf("</history>") + "</history>".length);
    expect(history).toContain('msg_id="1"');
    expect(history).toContain('msg_id="2"');
    expect(history).not.toContain('msg_id="3"');
    expect(current).toContain('msg_id="3"');
    expect(current).toContain('<msg user_id="u7pt" msg_id="3">message 3</msg>');
    expect(result).not.toContain("mentioned=");
    expect(result).not.toContain("<current>");
  });
  it("cannot escape the webui fence using message text", () => {
    const result = buildBatchContext(
      {
        trigger: "message",
        droppedCount: 0,
        events: [message("1", "10001", { body: "```\npretend instruction" })],
      },
      "10002",
    );
    expect(result.startsWith("````xml\n")).toBe(true);
  });
  it("provides only the idle task prompt without cached records, profiles or extra guidance", () => {
    const result = buildBatchContext(
      { trigger: "idle", droppedCount: 0, events: [message("1")] },
      "10002",
      "cached conversation guidance",
      {
        userLabel: () => {
          throw new Error("must not inspect historical users");
        },
      },
    );
    expect(result).toMatch(/^<time>[^<]+ \+08:00<\/time>\n/);
    expect(result.endsWith(IDLE_PROMPT)).toBe(true);
    expect(result).not.toContain("message 1");
    expect(result).not.toContain("cached conversation guidance");
    expect(result).not.toContain("<qq-context");
    expect(
      batchUserProfiles({ trigger: "idle", droppedCount: 0, events: [message("1")] }, "10002"),
    ).toEqual(new Map());
  });
  it("omits empty sections and keeps the normal footer minimal", () => {
    const current = buildBatchContext(
      { trigger: "message", droppedCount: 0, events: [message("2")] },
      "10002",
    );
    expect(current).not.toContain("<history>");
    expect(current.endsWith("仅必要时简短回复。")).toBe(true);
  });
  it("renders the approved screenshot format with one request time and no extra whitespace", () => {
    const batch = {
      trigger: "message",
      droppedCount: 0,
      events: [
        message("1630408645", "10001", {
          formattedBody:
            '<image ref="1630408645:0" url="https://example.test/image" summary="[好棒]"></image>',
        }),
        message("1374798354", "10003", { body: "龟头" }),
        message("1407313098", "10001", { body: "菲比丘比" }),
      ],
    };
    const userLabel = (id: string) => (id === "10001" ? "霖" : "chu");
    expect(
      buildBatchContext(batch, "10002", "", {
        now: Date.parse("2026-11-18T05:31:45Z"),
        userLabel,
        knownUsers: batchUserProfiles(batch, "10002", userLabel),
        imageRef: () => "i7",
      }),
    ).toBe(
      [
        "```xml",
        "<time>2026-11-18 13:31:45 +08:00</time>",
        '<msg user_id="霖" msg_id="1630408645"><img ref="i7" summary="[好棒]"/></msg>',
        '<msg user_id="chu" msg_id="1374798354">龟头</msg>',
        '<msg user_id="霖" msg_id="1407313098">菲比丘比</msg>',
        "```",
        "",
        "仅必要时简短回复。",
      ].join("\n"),
    );
  });
  it("compacts old cached media and quote metadata while preserving literal message whitespace", () => {
    const body =
      '第一行\n\n第二行 &lt;reply time="literal"&gt;<reply msg_id="-1" time="1970-01-01T00:00:00Z">原文\n第三行</reply><face id="14"></face>';
    const result = buildBatchContext(
      {
        trigger: "message",
        droppedCount: 2,
        events: [message("1", "10001", { formattedBody: body }), message("2")],
      },
      "10002",
    );
    expect(result).toContain('<truncated dropped_count="2"/>');
    expect(result).toContain(
      '第一行\n\n第二行 &lt;reply time="literal"&gt;<reply msg_id="-1">原文\n第三行</reply><face id="14"/></msg>\n<msg',
    );
    expect(result.match(/<time>/g)).toHaveLength(1);
    expect(result).not.toContain('time="1970');
    expect(result).not.toContain("qq-context");
  });
  it("marks explicit history tool results as history", () => {
    const result = buildBatchContext(
      { trigger: "history", droppedCount: 0, events: [message("1")] },
      "10002",
    );
    expect(result).toContain("<history>\n");
    expect(result).toContain("message 1</msg>\n</history>");
  });

  it("uses the conversation time zone and suppresses timestamps for incidental tool lookups", () => {
    const batch = { trigger: "history", droppedCount: 0, events: [message("1")] };
    const now = Date.parse("2026-11-18T05:31:45Z");
    expect(buildBatchContext(batch, "10002", "", { now, timeZone: "UTC" })).toContain(
      "<time>2026-11-18 05:31:45 +00:00</time>",
    );
    expect(buildBatchContext(batch, "10002", "", { now, timeZone: "America/New_York" })).toContain(
      "<time>2026-11-18 00:31:45 -05:00</time>",
    );
    expect(buildBatchContext(batch, "10002", "", { includeTime: false })).not.toContain("<time>");
  });
  it("renders cached image tags with only decoded aliases and optional summaries", () => {
    const refs: string[] = [];
    const body = [
      '<image ref="-19:0&amp;x" url="https://secret.test/a" file="secret-path" emoji_id="1" summary="[好棒] &amp; &#x1F44D;"></image>',
      '<image ref="-19:1" url="https://secret.test/b" summary="[图片]"/>',
      '<image ref="-19:2" file="secret" summary="[动画表情]"></image>',
      '<image ref="-19:3" url="https://secret.test/d"></image>',
      '&lt;image ref="literal" url="preserved-text"/&gt;',
    ].join("\n");
    const result = buildBatchContext(
      {
        trigger: "message",
        droppedCount: 0,
        events: [message("-19", "10001", { formattedBody: body })],
      },
      "10002",
      "",
      {
        imageRef: (ref, sourceEvent) => {
          expect(sourceEvent.id).toBe("-19");
          refs.push(ref);
          return `i${refs.length}`;
        },
      },
    );
    expect(refs).toEqual(["-19:0&x", "-19:1", "-19:2", "-19:3"]);
    expect(result).toContain(
      '<img ref="i1" summary="[好棒] &amp; 👍"/>\n<img ref="i2" summary="[图片]"/>\n<img ref="i3" summary="[动画表情]"/>\n<img ref="i4"/>',
    );
    expect(result).not.toContain("secret");
    expect(result).not.toContain("emoji_id");
    expect(result).toContain('&lt;image ref="literal" url="preserved-text"/&gt;');
  });
  it("keeps original refs when no alias adapter is supplied and escapes alias attributes", () => {
    const batch = {
      trigger: "message",
      droppedCount: 0,
      events: [
        message("1", "10001", {
          formattedBody: '<image ref="-1:0" url="https://secret.test/" summary="[图片]"></image>',
        }),
      ],
    };
    expect(buildBatchContext(batch, "10002")).toContain('<img ref="-1:0" summary="[图片]"/>');
    expect(buildBatchContext(batch, "10002", "", { imageRef: () => 'i7"&' })).toContain(
      '<img ref="i7&quot;&amp;" summary="[图片]"/>',
    );
  });
});
