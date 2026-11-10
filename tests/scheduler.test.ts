import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore, type StoredEvent } from "../src/store.js";
import {
  Scheduler,
  isActiveTime,
  type DispatchBatch,
  type ConversationPolicy,
} from "../src/scheduler.js";

function event(id: string, extra: Partial<StoredEvent> = {}): StoredEvent {
  return {
    id,
    accountId: "a",
    conversationKey: "group:1",
    kind: "group",
    time: Date.now(),
    userId: "10001",
    body: id,
    mention: false,
    self: false,
    ...extra,
  };
}

function setup(
  policy: Partial<ConversationPolicy> = {},
  dispatch?: (batch: DispatchBatch, control: { accept(): void }) => Promise<void>,
) {
  const store = new EventStore(":memory:");
  const batches: DispatchBatch[] = [];
  const errors: unknown[] = [];
  const scheduler = new Scheduler({
    store,
    policy: () => ({ mode: "autonomous", idleEnabled: false, initialBatchWaitMs: 0, ...policy }),
    dispatch: async (batch, control) => {
      batches.push(batch);
      if (dispatch) await dispatch(batch, control);
      else control.accept();
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  scheduler.start();
  return { store, scheduler, batches, errors };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-10T00:00:00Z"));
});

it("keeps messages after a queued /new pending for the fresh session", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { scheduler, store, batches } = setup({}, async (batch, control) => {
    control.accept();
    if (batch.events[0]?.id === "first") await gate;
  });
  scheduler.ingest(event("first"));
  await vi.advanceTimersByTimeAsync(0);
  scheduler.ingest(event("old"));
  scheduler.ingest(event("new", { liveCommand: "/new", mention: true }));
  scheduler.ingest(event("after"));
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(batches[1]?.events.map((e) => e.id)).toEqual(["new"]);
  expect(store.selectForAgent("a", "group:1").events.map((e) => e.id)).toEqual(["after"]);
  await vi.advanceTimersByTimeAsync(30000);
  expect(batches[2]?.events.map((e) => e.id)).toEqual(["after"]);
  await scheduler.close();
  store.close();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("conversation scheduler", () => {
  it("waits 10 seconds for the first autonomous group message using arrival time rather than its timestamp", async () => {
    const { scheduler, store, batches } = setup({ initialBatchWaitMs: 10_000 });
    scheduler.ingest(event("1", { time: Date.now() - 3600_000 }));
    await vi.advanceTimersByTimeAsync(9999);
    expect(batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches.map((batch) => batch.events.map((entry) => entry.id))).toEqual([["1"]]);
    await scheduler.close();
    store.close();
  });

  it("extends the initial quiet window on each new message, capped at 30 seconds from its first arrival", async () => {
    const { scheduler, store, batches } = setup({
      initialBatchWaitMs: 10_000,
      initialBatchMaxWaitMs: 30_000,
    });
    scheduler.ingest(event("1"));
    await vi.advanceTimersByTimeAsync(9000);
    scheduler.ingest(event("2"));
    await vi.advanceTimersByTimeAsync(9000);
    scheduler.ingest(event("3"));
    await vi.advanceTimersByTimeAsync(9000);
    scheduler.ingest(event("4"));
    await vi.advanceTimersByTimeAsync(2999);
    expect(batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches[0]!.events.map((entry) => entry.id)).toEqual(["1", "2", "3", "4"]);
    await scheduler.close();
    store.close();
  });

  it("does not extend an existing fixed cooldown with the initial debounce window", async () => {
    const { scheduler, store, batches } = setup({ initialBatchWaitMs: 10_000 });
    scheduler.ingest(event("1"));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    scheduler.ingest(event("2"));
    await vi.advanceTimersByTimeAsync(19_000);
    scheduler.ingest(event("3"));
    await vi.advanceTimersByTimeAsync(999);
    expect(batches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches[1]!.events.map((entry) => entry.id)).toEqual(["2", "3"]);
    await scheduler.close();
    store.close();
  });

  it("applies a fresh debounce after an empty queue and elapsed cooldown", async () => {
    const { scheduler, store, batches } = setup({ initialBatchWaitMs: 10_000 });
    scheduler.ingest(event("1"));
    await vi.advanceTimersByTimeAsync(60_000);
    scheduler.ingest(event("2"));
    await vi.advanceTimersByTimeAsync(9999);
    expect(batches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches).toHaveLength(2);
    await scheduler.close();
    store.close();
  });

  it("bypasses an open burst for mentions, preserves private immediacy and ignores history/self for debounce", async () => {
    const { scheduler, store, batches } = setup({ initialBatchWaitMs: 10_000 });
    scheduler.ingest(event("1"));
    await vi.advanceTimersByTimeAsync(5000);
    scheduler.ingest(event("2", { mention: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(batches[0]!.trigger).toBe("mention");
    expect(batches[0]!.events.map((entry) => entry.id)).toEqual(["1", "2"]);
    scheduler.ingest(event("private", { kind: "private", conversationKey: "private:1" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toHaveLength(2);
    scheduler.ingest(
      event("history", { conversationKey: "group:2", trigger: false, human: false }),
    );
    scheduler.ingest(
      event("self", { conversationKey: "group:2", self: true, human: false, trigger: false }),
    );
    expect(store.state("a", "group:2")!.burstStartAt).toBeNull();
    scheduler.ingest(event("3", { conversationKey: "group:2" }));
    await vi.advanceTimersByTimeAsync(5000);
    scheduler.ingest(
      event("self2", { conversationKey: "group:2", self: true, human: false, trigger: false }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(batches).toHaveLength(3);
    expect(batches[2]!.events.map((entry) => entry.id)).toEqual(["history", "3"]);
    await scheduler.close();
    store.close();
  });

  it("preserves queued normal work behind an active run without creating a second initial window", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { scheduler, store, batches } = setup(
      { initialBatchWaitMs: 10_000 },
      async (_batch, control) => {
        control.accept();
        if (batches.length === 1) await gate;
      },
    );
    scheduler.ingest(event("1"));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(40_000);
    scheduler.ingest(event("2"));
    expect(store.state("a", "group:1")!.burstStartAt).toBeNull();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toHaveLength(2);
    await scheduler.close();
    store.close();
  });

  it("recovers the original persisted burst maximum after a process restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "snow-burst-"));
    const path = join(dir, "state.db");
    const policy = () => ({ mode: "autonomous" as const, idleEnabled: false });
    const batches: DispatchBatch[] = [];
    const dispatch = async (batch: DispatchBatch, control: { accept(): void }) => {
      batches.push(batch);
      control.accept();
    };
    let store = new EventStore(path);
    let scheduler = new Scheduler({ store, policy, dispatch });
    try {
      scheduler.start();
      scheduler.ingest(event("1"));
      await vi.advanceTimersByTimeAsync(9000);
      scheduler.ingest(event("2"));
      await vi.advanceTimersByTimeAsync(6000);
      await scheduler.close();
      store.close();
      store = new EventStore(path);
      scheduler = new Scheduler({ store, policy, dispatch });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(3000);
      scheduler.ingest(event("3"));
      await vi.advanceTimersByTimeAsync(9000);
      scheduler.ingest(event("4"));
      await vi.advanceTimersByTimeAsync(2999);
      expect(batches).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(batches).toHaveLength(1);
      expect(batches[0]!.events.map((entry) => entry.id)).toEqual(["1", "2", "3", "4"]);
    } finally {
      await scheduler.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends the first batch immediately and uses a fixed rather than sliding 30 second interval", async () => {
    const { scheduler, store, batches } = setup();
    scheduler.ingest(event("1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(batches.map((b) => b.events.map((e) => e.id))).toEqual([["1"]]);
    await vi.advanceTimersByTimeAsync(10_000);
    scheduler.ingest(event("2"));
    await vi.advanceTimersByTimeAsync(19_000);
    scheduler.ingest(event("3"));
    await vi.advanceTimersByTimeAsync(999);
    expect(batches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches[1]!.events.map((e) => e.id)).toEqual(["2", "3"]);
    await scheduler.close();
    store.close();
  });

  it("holds mention mode context and bypasses its interval for a real mention", async () => {
    const { scheduler, store, batches } = setup({ mode: "mention" });
    scheduler.ingest(event("1"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(batches).toHaveLength(0);
    scheduler.ingest(event("2", { mention: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(batches[0]!.trigger).toBe("mention");
    expect(batches[0]!.events.map((e) => e.id)).toEqual(["1", "2"]);
    scheduler.ingest(event("3", { mention: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toHaveLength(2);
    await scheduler.close();
    store.close();
  });

  it("queues mentions behind active work and admits the whole unread tail without parallel runs", async () => {
    let release!: () => void;
    let active = 0;
    let maxActive = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { scheduler, store, batches } = setup({}, async (_batch, control) => {
      active++;
      maxActive = Math.max(active, maxActive);
      control.accept();
      if (batches.length === 1) await gate;
      active--;
    });
    scheduler.ingest(event("1"));
    await vi.advanceTimersByTimeAsync(0);
    scheduler.ingest(event("2"));
    scheduler.ingest(event("3", { mention: true }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(batches).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(batches[1]!.events.map((e) => e.id)).toEqual(["2", "3"]);
    expect(maxActive).toBe(1);
    await scheduler.close();
    store.close();
  });

  it("runs private messages immediately and isolates another conversation", async () => {
    const { scheduler, store, batches } = setup();
    scheduler.ingest(event("1", { kind: "private", conversationKey: "private:1" }));
    await vi.advanceTimersByTimeAsync(0);
    scheduler.ingest(event("2", { kind: "private", conversationKey: "private:1" }));
    scheduler.ingest(event("3", { conversationKey: "group:2" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toHaveLength(3);
    expect(batches.map((b) => b.events.map((e) => e.id))).toEqual([["1"], ["2"], ["3"]]);
    await scheduler.close();
    store.close();
  });

  it("keeps pre-admission failures pending and retries with a bounded delay", async () => {
    let calls = 0;
    const { scheduler, store, batches, errors } = setup({}, async (_batch, control) => {
      if (++calls === 1) throw new Error("not admitted");
      control.accept();
    });
    scheduler.ingest(event("1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.pending("a", "group:1").count).toBe(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(batches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches).toHaveLength(2);
    expect(store.pending("a", "group:1").count).toBe(0);
    expect(errors).toHaveLength(1);
    await scheduler.close();
    store.close();
  });

  it("does not replay accepted work when later generation or delivery fails", async () => {
    const { scheduler, store, batches } = setup({}, async (_batch, control) => {
      control.accept();
      throw new Error("delivery unknown");
    });
    scheduler.ingest(event("1"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(batches).toHaveLength(1);
    expect(store.pending("a", "group:1").count).toBe(0);
    await scheduler.close();
    store.close();
  });

  it("keeps self and non-trigger events as context without triggering another reply", async () => {
    const { scheduler, store, batches } = setup();
    scheduler.ingest(event("self", { self: true }));
    scheduler.ingest(event("reaction", { trigger: false, human: false, mention: true }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(batches).toHaveLength(0);
    scheduler.ingest(event("1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(batches[0]!.events.map((e) => e.id)).toEqual(["reaction", "1"]);
    await scheduler.close();
    store.close();
  });

  it("attempts idle once per human generation, persists the attempt and invalidates stale idle sends", async () => {
    const { scheduler, store, batches } = setup({ idleEnabled: true, idleAfterMs: 3600_000 });
    scheduler.ingest(event("1"));
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(batches.map((b) => b.trigger)).toEqual(["message", "idle"]);
    const idle = batches[1]!;
    expect(idle.isCurrent()).toBe(true);
    await vi.advanceTimersByTimeAsync(3600_000 * 2);
    expect(batches).toHaveLength(2);
    scheduler.ingest(event("2"));
    await vi.advanceTimersByTimeAsync(0);
    expect(idle.isCurrent()).toBe(false);
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(batches.map((b) => b.trigger)).toEqual(["message", "idle", "message", "idle"]);
    await scheduler.close();
    const afterRestart: DispatchBatch[] = [];
    const recovered = new Scheduler({
      store,
      policy: () => ({ mode: "autonomous", idleEnabled: true }),
      dispatch: async (batch, control) => {
        afterRestart.push(batch);
        control.accept();
      },
    });
    recovered.start();
    await vi.advanceTimersByTimeAsync(7200_000);
    expect(afterRestart).toHaveLength(0);
    await recovered.close();
    store.close();
  });

  it("delays idle until active hours while normal messages remain immediate", async () => {
    const { scheduler, store, batches } = setup({
      idleEnabled: true,
      idleAfterMs: 1000,
      timeZone: "UTC",
      activeHours: [{ start: "01:00", end: "02:00" }],
    });
    scheduler.ingest(event("1"));
    await vi.advanceTimersByTimeAsync(3599_999);
    expect(batches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches[1]!.trigger).toBe("idle");
    await scheduler.close();
    store.close();
  });

  it("recovers unaccepted durable events without requiring another incoming event", async () => {
    const store = new EventStore(":memory:");
    store.add(event("1"));
    const batches: DispatchBatch[] = [];
    const scheduler = new Scheduler({
      store,
      policy: () => ({ mode: "autonomous", idleEnabled: false }),
      dispatch: async (batch, control) => {
        batches.push(batch);
        control.accept();
      },
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(batches[0]!.events[0]!.id).toBe("1");
    await scheduler.close();
    store.close();
  });

  it("serializes synchronous reentrant ingestion from the dispatch callback", async () => {
    const { scheduler, store, batches } = setup({}, async (batch, control) => {
      control.accept();
      if (batch.events[0]!.id === "1") scheduler.ingest(event("2", { mention: true }));
    });
    scheduler.ingest(event("1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(batches.map((b) => b.events.map((e) => e.id))).toEqual([["1"], ["2"]]);
    await scheduler.close();
    store.close();
  });

  it("delays idle after an outbound message without rearming an already attempted human generation", async () => {
    const { scheduler, store, batches } = setup({ idleEnabled: true, idleAfterMs: 3600_000 });
    scheduler.ingest(event("1"));
    await vi.advanceTimersByTimeAsync(1800_000);
    scheduler.ingest(event("bot", { self: true, human: false, trigger: false }));
    await vi.advanceTimersByTimeAsync(1800_000);
    expect(batches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1800_000);
    expect(batches[1]!.trigger).toBe("idle");
    scheduler.ingest(event("bot2", { self: true, human: false, trigger: false }));
    await vi.advanceTimersByTimeAsync(7200_000);
    expect(batches).toHaveLength(2);
    await scheduler.close();
    store.close();
  });
});

it("handles overnight windows and rejects malformed active-hours configuration", () => {
  const policy: ConversationPolicy = {
    mode: "autonomous",
    timeZone: "UTC",
    activeHours: [{ start: "23:00", end: "02:00" }],
  };
  expect(isActiveTime(Date.parse("2026-11-10T00:30:00Z"), policy)).toBe(true);
  expect(isActiveTime(Date.parse("2026-11-10T12:00:00Z"), policy)).toBe(false);
  expect(() =>
    isActiveTime(Date.now(), { ...policy, activeHours: [{ start: "25:00", end: "02:00" }] }),
  ).toThrow("Invalid active-hours");
});
