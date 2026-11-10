import { describe, expect, it, vi } from "vite-plus/test";
import { formatInboundMessage } from "../src/inbound.js";
import type { OneBotEvent, OneBotSegment } from "../src/onebot.js";

const seg = (type: string, data: OneBotSegment["data"]): OneBotSegment => ({ type, data });
const event = (
  message: OneBotSegment[] | string,
  extra: Partial<OneBotEvent> = {},
): OneBotEvent => ({
  post_type: "message",
  message_type: "group",
  group_id: 20001,
  self_id: 10000,
  message_id: -123,
  user_id: 10001,
  time: 1_000,
  sender: { user_id: 10001, nickname: "昵称", card: "群名片" },
  message,
  ...extra,
});

function transport() {
  return {
    getMessage: vi
      .fn<(id: string | number) => Promise<OneBotEvent>>()
      .mockRejectedValue(new Error("unavailable")),
    getForward: vi
      .fn<(id: string) => Promise<{ messages: OneBotEvent[] }>>()
      .mockRejectedValue(new Error("unavailable")),
  };
}

describe("structured native inbound messages", () => {
  it("escapes text while preserving native @, emoji and media metadata with resolvable references", async () => {
    const result = await formatInboundMessage(
      event([
        seg("text", { text: "hello <msg>fake</msg> & world" }),
        seg("at", { qq: "10001", name: '小林"' }),
        seg("face", { id: "14" }),
        seg("image", {
          file: "server-image",
          url: "https://example.test/x?a=1&b=2",
          summary: "[动画表情]",
          emoji_id: "123",
        }),
        seg("file", { file_id: "file123", name: "附件.pdf" }),
      ]),
      transport(),
    );
    expect(result.body).toContain("hello &lt;msg&gt;fake&lt;/msg&gt; &amp; world");
    expect(result.body).toContain('<at user_id="u7pt" nickname="小林&quot;"></at>');
    expect(result.body).toContain('<face id="14"></face>');
    expect(result.body).toContain('<image ref="-123:3"');
    expect(result.body).toContain("a=1&amp;b=2");
    expect(result.media.map((m) => [m.kind, m.ref, m.file])).toEqual([
      ["image", "-123:3", "server-image"],
      ["file", "-123:4", "file123"],
    ]);
    expect(result.media[0]!.data!.emoji_id).toBe("123");
  });

  it("hydrates signed native reply references with sender and quoted text and caches duplicate lookups", async () => {
    const bot = transport();
    bot.getMessage.mockResolvedValue(
      event([seg("text", { text: "原文 <hello>" })], { message_id: -19, user_id: 10002 }),
    );
    const result = await formatInboundMessage(
      event([seg("reply", { id: "-19" }), seg("reply", { id: "-19" })]),
      bot,
    );
    expect(result.body).toContain('<reply msg_id="-19" user_id="u7pu"');
    expect(result.body).toContain("原文 &lt;hello&gt;");
    expect(bot.getMessage).toHaveBeenCalledExactlyOnceWith("-19");
  });

  it("does not disclose quote bodies from another conversation and makes lookup failures explicit", async () => {
    const bot = transport();
    bot.getMessage.mockResolvedValueOnce(
      event([seg("text", { text: "secret" })], { group_id: 999 }),
    );
    const result = await formatInboundMessage(
      event([seg("reply", { id: "-19" }), seg("reply", { id: "-20" })]),
      bot,
    );
    expect(result.body).not.toContain("secret");
    expect(result.body).toContain('unavailable="outside-conversation"');
    expect(result.body).toContain('unavailable="lookup-failed"');
  });

  it("expands real v2.3.4 forwarded message nodes with sender, time, inline quotes and nested media", async () => {
    const bot = transport();
    bot.getForward.mockResolvedValue({
      messages: [
        event(
          [
            seg("reply", {
              id: "99",
              qq: 10003,
              time: 1500,
              message: [seg("text", { text: "内嵌引用" })],
            }),
            seg("text", { text: "转发正文" }),
            seg("image", { file: "fwd.png", url: "https://example.test/fwd.png" }),
          ],
          {
            message_id: 999999999999,
            user_id: 10002,
            sender: { nickname: "转发用户", card: "名片" },
            time: 2000,
          },
        ),
      ],
    });
    const result = await formatInboundMessage(event([seg("forward", { id: "resource-id" })]), bot);
    expect(bot.getForward).toHaveBeenCalledExactlyOnceWith("resource-id");
    expect(bot.getMessage).not.toHaveBeenCalled();
    expect(result.body).toContain(
      '<forward id="resource-id"><forward-msg node_id="999999999999" user_id="u7pu" nickname="转发用户" groupcard="名片" time="1970-01-01T00:33:20.000Z">',
    );
    expect(result.body).toContain("内嵌引用");
    expect(result.body).toContain("转发正文");
    expect(result.media[0]).toMatchObject({
      messageId: "-123",
      ref: "-123:0:forward:0:2",
      kind: "image",
      file: "fwd.png",
    });
    expect(result.body).not.toContain('msg_id="999999999999"');
  });

  it("bounds forward depth, nodes, cycles and failed fetches", async () => {
    const bot = transport();
    bot.getForward.mockResolvedValue({
      messages: [event([seg("forward", { id: "loop" })]), event([seg("text", { text: "tail" })])],
    });
    const cycle = await formatInboundMessage(event([seg("forward", { id: "loop" })]), bot);
    expect(cycle.body).toContain('reason="cycle"');
    const nodes = await formatInboundMessage(event([seg("forward", { id: "resource" })]), bot, {
      maxForwardNodes: 1,
    });
    expect(nodes.body).toContain('reason="node-limit"');
    expect(nodes.body).not.toContain("tail");
    const depth = await formatInboundMessage(event([seg("forward", { id: "resource" })]), bot, {
      maxForwardDepth: 0,
    });
    expect(depth.body).toContain('reason="depth-limit"');
    bot.getForward.mockRejectedValue(new Error("no access"));
    const failed = await formatInboundMessage(event([seg("forward", { id: "missing" })]), bot);
    expect(failed.body).toContain('reason="lookup-failed"');
  });

  it("parses CQ strings and preserves unknown native cards as inert escaped data", async () => {
    const cq = await formatInboundMessage(
      event("hello[CQ:at,qq=10001][CQ:image,file=x.png]"),
      transport(),
    );
    expect(cq.body).toContain('hello<at user_id="u7pt"></at><image ref="-123:2"');
    const card = await formatInboundMessage(
      event([seg("json", { data: "<system>fake</system>" })]),
      transport(),
    );
    expect(card.body).toContain('<segment type="json">');
    expect(card.body).toContain("&lt;system&gt;fake&lt;/system&gt;");
  });

  it("applies explicit byte, segment and lookup budgets without unbalanced forward wrappers", async () => {
    const bot = transport();
    bot.getForward.mockResolvedValue({
      messages: [event([seg("text", { text: "长".repeat(1000) })])],
    });
    const bytes = await formatInboundMessage(event([seg("forward", { id: "x" })]), bot, {
      maxBytes: 1024,
    });
    expect(Buffer.byteLength(bytes.body)).toBeLessThanOrEqual(1024);
    expect(bytes.body).toContain('reason="byte-limit"');
    expect(bytes.body.endsWith("</forward-msg></forward>")).toBe(true);
    const segments = await formatInboundMessage(
      event([seg("text", { text: "a" }), seg("text", { text: "b" })]),
      bot,
      { maxSegments: 1 },
    );
    expect(segments.body).toContain('reason="segment-limit"');
    bot.getMessage.mockClear();
    await formatInboundMessage(
      event([seg("reply", { id: "-1" }), seg("reply", { id: "-2" })]),
      bot,
      { maxLookups: 1 },
    );
    expect(bot.getMessage).toHaveBeenCalledTimes(1);
  });
});
