import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { EventStore, type StoredEvent } from "../src/store.js";

function event(id: string, extra: Partial<StoredEvent> = {}): StoredEvent {
  return {
    id,
    accountId: "a",
    conversationKey: "group:1",
    kind: "group",
    time: 1000 + Number(id),
    userId: "10001",
    body: id,
    mention: false,
    self: false,
    ...extra,
  };
}

describe("durable event store", () => {
  it("excludes self output before applying the agent limit and truncation count, but retains it for native references", () => {
    const store = new EventStore(":memory:");
    store.add(event("1"), 1000);
    store.add(event("2"), 1000);
    store.add(event("3", { self: true }), 1000);
    store.add(event("4", { self: true }), 1000);
    expect(store.selectForAgent("a", "group:1", 1)).toMatchObject({
      events: [{ id: "2" }],
      droppedCount: 1,
    });
    expect(store.selectForAgent("a", "group:1", 100).events.map((e) => e.id)).toEqual(["1", "2"]);
    expect(store.select("a", "group:1", 100, true).events.map((e) => e.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
    store.close();
  });

  it("does not report expired or compacted self output as omitted model input", () => {
    const store = new EventStore(":memory:", { cacheMaxMessages: 1, retentionMs: 1000 });
    for (let i = 1; i <= 30; i++) store.add(event(String(i), { self: true, time: 0 }), 2000);
    expect(store.selectForAgent("a", "group:1", 100, true)).toMatchObject({
      events: [],
      droppedCount: 0,
    });
    store.close();
  });

  it("persists profile definitions only when explicitly recorded, isolated by real agent session and account", () => {
    const dir = mkdtempSync(join(tmpdir(), "snow-profile-"));
    const path = join(dir, "state.db");
    try {
      let store = new EventStore(path);
      expect(store.knownSessionUsers("a", "session1").size).toBe(0);
      store.recordSessionUsers(
        "a",
        "session1",
        new Map([["10001", '{"nickname":"first","card":"old"}']]),
      );
      expect(store.knownSessionUsers("a", "session2").size).toBe(0);
      expect(store.knownSessionUsers("b", "session1").size).toBe(0);
      store.close();
      store = new EventStore(path);
      expect(store.knownSessionUsers("a", "session1").get("10001")).toBe(
        '{"nickname":"first","card":"old"}',
      );
      store.recordSessionUsers(
        "a",
        "session1",
        new Map([["10001", '{"nickname":"second","card":"new"}']]),
      );
      expect(store.knownSessionUsers("a", "session1").get("10001")).toBe(
        '{"nickname":"second","card":"new"}',
      );
      expect(() => store.recordSessionUsers("a", "", new Map())).toThrow("actual agent session ID");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("isolates accounts and conversations, deduplicates signed message ids", () => {
    const store = new EventStore(":memory:");
    expect(store.add(event("-123"), 1000)).toBe(true);
    expect(store.add(event("-123"), 1000)).toBe(false);
    expect(store.add(event("-123", { accountId: "b" }), 1000)).toBe(true);
    expect(store.add(event("-123", { conversationKey: "private:1", kind: "private" }), 1000)).toBe(
      true,
    );
    expect(store.states()).toHaveLength(3);
    expect(store.select("a", "group:1").events.map((e) => e.id)).toEqual(["-123"]);
    store.close();
  });

  it("selects recent messages with pending mentions prioritized and exposes truncation", () => {
    const store = new EventStore(":memory:");
    for (let i = 1; i <= 6; i++) store.add(event(String(i), { mention: i === 1 }), 1000);
    const result = store.select("a", "group:1", 3);
    expect(result.events.map((e) => e.id)).toEqual(["1", "5", "6"]);
    expect(result.droppedCount).toBe(3);
    store.prepareBatch("run", "a", "group:1", result.watermark, 1000);
    store.add(event("7"), 1000);
    store.acceptBatch("run", 2000);
    store.acceptBatch("run", 3000);
    expect(store.select("a", "group:1").events.map((e) => e.id)).toEqual(["7"]);
    expect(store.state("a", "group:1")!.lastSubmissionAt).toBe(2000);
    store.close();
  });

  it("bounds cached bodies, preserves mention priority, deduplication and pending gap evidence", () => {
    const store = new EventStore(":memory:", { cacheMaxMessages: 2 });
    for (let i = 1; i <= 4; i++) store.add(event(String(i), { mention: i === 1 }), 1000);
    expect(store.select("a", "group:1").events.map((e) => e.id)).toEqual(["1", "4"]);
    expect(store.select("a", "group:1").droppedCount).toBe(2);
    expect(store.add(event("2"), 1000)).toBe(false);
    store.close();
  });

  it("retains expired pending identities as visible gaps until acceptance", () => {
    const store = new EventStore(":memory:", { retentionMs: 1000 });
    store.add(event("1", { time: 0 }), 2000);
    const snapshot = store.select("a", "group:1");
    expect(snapshot.events).toEqual([]);
    expect(snapshot.droppedCount).toBe(1);
    expect(store.pending("a", "group:1").triggerable).toBe(true);
    store.prepareBatch("run", "a", "group:1", snapshot.watermark, 2000);
    store.acceptBatch("run", 2000);
    expect(store.pending("a", "group:1").count).toBe(0);
    store.close();
  });

  it("recovers acceptance, idle generation and receipts after a process restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "snow-store-"));
    const path = join(dir, "state.db");
    try {
      let store = new EventStore(path);
      store.add(event("1"), 1000);
      const snapshot = store.select("a", "group:1");
      store.prepareBatch("run", "a", "group:1", snapshot.watermark, 1000);
      store.acceptBatch("run", 1000);
      expect(store.claimIdle("a", "group:1", 1)).toBe(true);
      store.saveReceipt("run:0", "a", "group:1", { messageId: "-19", status: "unknown" }, 1000);
      store.close();
      store = new EventStore(path);
      expect(store.pending("a", "group:1").count).toBe(0);
      expect(store.claimIdle("a", "group:1", 1)).toBe(false);
      expect(store.receipt("run:0")).toEqual({ messageId: "-19", status: "unknown" });
      store.add(event("2", { self: true }), 1000);
      expect(store.state("a", "group:1")!.humanGeneration).toBe(1);
      store.add(event("3"), 1000);
      expect(store.claimIdle("a", "group:1", 2)).toBe(true);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compacts identity-only overflow without losing pending counts or mixing acknowledgement windows", () => {
    const store = new EventStore(":memory:", { cacheMaxMessages: 2 });
    for (let i = 1; i <= 100; i++) store.add(event(String(i)), 1000);
    const first = store.select("a", "group:1");
    expect(first.events).toHaveLength(2);
    expect(first.droppedCount).toBe(98);
    expect(store.pending("a", "group:1").count).toBe(100);
    store.prepareBatch("first", "a", "group:1", first.watermark, 1000);
    for (let i = 101; i <= 200; i++) store.add(event(String(i)), 1000);
    store.acceptBatch("first", 1000);
    expect(store.pending("a", "group:1").count).toBe(100);
    const next = store.select("a", "group:1");
    expect(next.droppedCount).toBe(98);
    expect(next.events.map((e) => e.id)).toEqual(["199", "200"]);
    store.prepareBatch("second", "a", "group:1", next.watermark, 1000);
    store.acceptBatch("second", 1000);
    expect(store.pending("a", "group:1").count).toBe(0);
    store.close();
  });
});
