import { describe, expect, it } from "vite-plus/test";
import { batchUserProfiles, buildBatchContext } from "../src/prompt.js";

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
  it("uses self consistently in the header, mentions, quotes and notices", () => {
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
    expect(result).toContain('self_id="self"');
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
  it("preserves three-line messages inside a markdown fence and labels explicit mentions", () => {
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
    expect(result).toMatch(/^```xml\n<qq-context/);
    const history = result.slice(result.indexOf("<history>"), result.indexOf("</history>"));
    const current = result.slice(result.indexOf("<current>"), result.indexOf("</current>"));
    expect(history).toContain('msg_id="1"');
    expect(history).toContain('msg_id="2"');
    expect(history).not.toContain('msg_id="3"');
    expect(current).toContain('msg_id="3"');
    expect(current).toContain('mentioned="true">\nmessage 3\n</msg>');
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
  it("omits empty sections and keeps the footer minimal", () => {
    const result = buildBatchContext(
      { trigger: "idle", droppedCount: 0, events: [message("1")] },
      "10002",
    );
    expect(result).not.toContain("<current>");
    expect(result).toContain("仅适合时简短开场。");
    const current = buildBatchContext(
      { trigger: "message", droppedCount: 0, events: [message("2")] },
      "10002",
    );
    expect(current).not.toContain("<history>");
    expect(current.endsWith("仅必要时简短回复。")).toBe(true);
  });
});
