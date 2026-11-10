import { describe, it, expect } from "vite-plus/test";
import { detectNewCommand, authorizeNewCommand, liveNewCommand } from "../src/commands.js";
import type { OneBotEvent } from "../src/onebot.js";
import type { StoredEvent } from "../src/store.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
const text = (value: string): OneBotEvent => ({
  post_type: "message",
  self_id: 10002,
  user_id: 10001,
  message: [{ type: "text", data: { text: value } }],
});
const stored: StoredEvent = {
  id: "-1",
  accountId: "default",
  conversationKey: "group:1",
  kind: "group",
  time: 1,
  userId: "10001",
  body: "/new",
  mention: false,
  self: false,
};
describe("native /new command admission", () => {
  it("accepts exact live text and one genuine self mention", () => {
    expect(detectNewCommand(text(" /new\n"), "10002")).toBe("/new");
    expect(
      detectNewCommand(
        {
          ...text(""),
          message: [
            { type: "at", data: { qq: "10002" } },
            { type: "text", data: { text: " /new " } },
          ],
        },
        "10002",
      ),
    ).toBe("/new");
    expect(detectNewCommand({ ...text(""), message: "[CQ:at,qq=10002] /new" }, "10002")).toBe(
      "/new",
    );
  });
  it("does not promote quotes, history objects, snippets, self echoes or third-party mentions", () => {
    for (const input of ["/new now", "Please /new", "<msg>/new</msg>", "`/new`", "/new\n/new"])
      expect(detectNewCommand(text(input), "10002")).toBeUndefined();
    expect(detectNewCommand({ ...text("/new"), post_type: undefined }, "10002")).toBeUndefined();
    expect(
      detectNewCommand({ ...text("/new"), post_type: "message_sent" }, "10002"),
    ).toBeUndefined();
    expect(detectNewCommand({ ...text("/new"), user_id: 10002 }, "10002")).toBeUndefined();
    expect(
      detectNewCommand(
        {
          ...text(""),
          message: [
            { type: "reply", data: { id: "-1" } },
            { type: "text", data: { text: "/new" } },
          ],
        },
        "10002",
      ),
    ).toBeUndefined();
    expect(
      detectNewCommand(
        {
          ...text(""),
          message: [
            { type: "at", data: { qq: "10003" } },
            { type: "text", data: { text: "/new" } },
          ],
        },
        "10002",
      ),
    ).toBeUndefined();
    expect(liveNewCommand([stored])).toBeUndefined();
  });
  it("uses the real host command allowlist rather than group chat admission", async () => {
    const base = {
      channels: { "qq-snowluma": { groups: { "1": {} } } },
    } as unknown as OpenClawConfig;
    expect(
      (await authorizeNewCommand(base, "default", stored, "qq-snowluma:group:1"))
        .isAuthorizedSender,
    ).toBe(false);
    const allowed = {
      ...base,
      commands: { allowFrom: { "qq-snowluma": ["10001"] } },
    } as OpenClawConfig;
    expect(
      (await authorizeNewCommand(allowed, "default", stored, "qq-snowluma:group:1"))
        .isAuthorizedSender,
    ).toBe(true);
    expect(
      (
        await authorizeNewCommand(
          allowed,
          "default",
          { ...stored, userId: "10003" },
          "qq-snowluma:group:1",
        )
      ).isAuthorizedSender,
    ).toBe(false);
    expect(
      (
        await authorizeNewCommand(
          { ...allowed, commands: { ...allowed.commands, text: false } },
          "default",
          stored,
          "qq-snowluma:group:1",
        )
      ).isAuthorizedSender,
    ).toBe(false);
  });
});
