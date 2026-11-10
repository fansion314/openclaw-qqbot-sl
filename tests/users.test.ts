import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { UserDirectory } from "../src/users.js";

describe("persistent model-facing user names", () => {
  it("uses lossless default short IDs until the agent supplies a name", () => {
    const users = new UserDirectory(":memory:");
    expect(users.display("a", "10001")).toBe("u7pt");
    expect(users.resolve("a", "u7pt")).toBe("10001");
    expect(users.setName("a", "10001", "小林")).toEqual({ userId: "小林", previousId: "u7pt" });
    expect(users.display("a", "10001")).toBe("小林");
    expect(users.resolve("a", "小林")).toBe("10001");
    expect(users.resolve("a", "u7pt")).toBe("10001");
    users.close();
  });

  it("permanently reserves historical aliases and permits returning to one's own old name", () => {
    const users = new UserDirectory(":memory:");
    users.setName("a", "10001", "Alice");
    expect(users.setName("a", "10001", "小林").previousId).toBe("Alice");
    expect(users.resolve("a", "alice")).toBe("10001");
    expect(() => users.setName("a", "10002", "ALICE")).toThrow("reserved by another");
    expect(users.setName("a", "10001", "ALICE")).toEqual({ userId: "ALICE", previousId: "小林" });
    expect(users.resolve("a", "小林")).toBe("10001");
    users.close();
  });

  it("compares collision keys using NFKC and lowercase without changing the displayed name", () => {
    const users = new UserDirectory(":memory:");
    users.setName("a", "10001", "Ａｌｉｃｅ");
    expect(users.display("a", "10001")).toBe("Ａｌｉｃｅ");
    expect(users.resolve("a", "alice")).toBe("10001");
    expect(() => users.setName("a", "10002", "Alice")).toThrow("reserved by another");
    expect(() => users.setName("a", "10002", "ＡＬＩＣＥ")).toThrow("reserved by another");
    expect(users.display("a", "10002")).toBe("u7pu");
    users.close();
  });

  it("isolates account namespaces and persists renames and aliases across restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "snow-users-"));
    const path = join(dir, "state.db");
    try {
      let users = new UserDirectory(path);
      users.setName("a", "10001", "小林");
      users.setName("a", "10001", "林同学");
      users.setName("b", "10002", "小林");
      users.close();
      users = new UserDirectory(path);
      expect(users.display("a", "10001")).toBe("林同学");
      expect(users.resolve("a", "小林")).toBe("10001");
      expect(users.resolve("b", "小林")).toBe("10002");
      expect(users.resolve("b", "林同学")).toBeUndefined();
      users.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects empty, trimmed, oversized, control, format and reserved names", () => {
    const users = new UserDirectory(":memory:");
    for (const name of [
      "",
      " ",
      " Alice",
      "Alice ",
      "a\nb",
      "a\tb",
      "a\u200Db",
      "a".repeat(33),
      "ALL",
      "self",
      "bot",
      "u7pt",
      "Ｕ７ＰＴ",
    ])
      expect(() => users.setName("a", "10001", name), JSON.stringify(name)).toThrow();
    expect(users.setName("a", "10001", "😀".repeat(32)).userId).toBe("😀".repeat(32));
    expect(() => users.setName("a", "10002", "😀".repeat(33))).toThrow();
    expect(users.resolve("a", " Alice")).toBeUndefined();
    users.close();
  });

  it("validates QQ IDs exactly using BigInt and keeps canonical numeric identity", () => {
    const users = new UserDirectory(":memory:");
    for (const id of ["0", "-1", "1.5", "1e9", "abc", "9007199254740992"])
      expect(() => users.display("a", id), id).toThrow();
    expect(users.display("a", "9007199254740991")).toBe(`u${9007199254740991n.toString(36)}`);
    expect(users.resolve("a", `u${9007199254740991n.toString(36)}`)).toBe("9007199254740991");
    expect(users.resolve("a", `u${9007199254740992n.toString(36)}`)).toBeUndefined();
    users.setName("a", "0010001", "小林");
    expect(users.display("a", "10001")).toBe("小林");
    users.close();
  });

  it("enforces ownership transactionally across separate SQLite directory connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "snow-users-race-"));
    const path = join(dir, "state.db");
    const first = new UserDirectory(path);
    const second = new UserDirectory(path);
    try {
      first.setName("a", "10001", "Alice");
      expect(() => second.setName("a", "10002", "alice")).toThrow("reserved by another");
      expect(second.display("a", "10002")).toBe("u7pu");
      second.setName("a", "10002", "Bob");
      expect(first.resolve("a", "bob")).toBe("10002");
    } finally {
      first.close();
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
