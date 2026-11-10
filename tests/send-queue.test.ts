import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PacedSendQueue, typingDelay } from "../src/send-queue.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("typing delay", () => {
  it("uses a logarithmic 1–10 second range and counts emoji as one code point", () => {
    expect(typingDelay("")).toBe(1000);
    expect(typingDelay("a")).toBe(Math.round(1000 + (9000 * Math.log1p(1)) / Math.log1p(100)));
    expect(typingDelay("😀")).toBe(typingDelay("a"));
    expect(typingDelay("a".repeat(100))).toBe(10_000);
    expect(typingDelay("a".repeat(1000))).toBe(10_000);
    expect(typingDelay("a".repeat(50))).toBeGreaterThan(typingDelay("a".repeat(10)));
    expect(() => typingDelay("a", { minDelayMs: 1000, maxDelayMs: 1 })).toThrow("pacing");
  });
});

describe("paced native sends", () => {
  it("sends the first message immediately and serializes following messages in FIFO order", async () => {
    const queue = new PacedSendQueue();
    const sent: string[] = [];
    const a = queue.enqueue("first", async () => {
      sent.push("first");
      return "a";
    });
    const b = queue.enqueue("", async () => {
      sent.push("second");
      return "b";
    });
    const c = queue.enqueue("a".repeat(100), async () => {
      sent.push("third");
      return "c";
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["first"]);
    await expect(a).resolves.toBe("a");
    await vi.advanceTimersByTimeAsync(999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(b).resolves.toBe("b");
    await vi.advanceTimersByTimeAsync(9999);
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(c).resolves.toBe("c");
    expect(sent).toEqual(["first", "second", "third"]);
    await queue.close();
  });

  it("anchors the next pause at the previous send completion, not its start", async () => {
    const queue = new PacedSendQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => "next");
    const first = queue.enqueue("first", async () => {
      await gate;
      return "first";
    });
    const next = queue.enqueue("", send);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(0);
    await first;
    await vi.advanceTimersByTimeAsync(999);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(send).toHaveBeenCalledTimes(1);
    await queue.close();
  });

  it("does not poison later sends or retry an attempted send when one fails", async () => {
    const queue = new PacedSendQueue();
    const failed = vi.fn(async () => {
      throw new Error("uncertain");
    });
    const first = queue.enqueue("first", failed);
    const rejected = expect(first).rejects.toThrow("uncertain");
    const next = vi.fn(async () => "ok");
    const second = queue.enqueue("", next);
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
    expect(next).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(second).resolves.toBe("ok");
    expect(failed).toHaveBeenCalledTimes(1);
    await queue.close();
  });

  it("cancels a waiting item before native I/O and lets the remaining queue continue", async () => {
    const queue = new PacedSendQueue();
    const controller = new AbortController();
    await queue.enqueue("first", async () => "first");
    await vi.advanceTimersByTimeAsync(0);
    const send = vi.fn(async () => "cancelled");
    const cancelled = queue.enqueue("long", send, controller.signal);
    const rejected = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    const next = queue.enqueue("", async () => "next");
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(1000);
    await expect(next).resolves.toBe("next");
    expect(send).not.toHaveBeenCalled();
    await queue.close();
  });

  it("aborts even the immediate item when cancelled before its native-send microtask", async () => {
    const queue = new PacedSendQueue();
    const controller = new AbortController();
    const send = vi.fn(async () => "no");
    const result = queue.enqueue("x", send, controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(send).not.toHaveBeenCalled();
    await queue.close();
  });

  it("close rejects pending work, joins in-flight I/O and never starts a later send", async () => {
    const queue = new PacedSendQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = vi.fn(async () => "no");
    const first = queue.enqueue("first", async () => {
      await gate;
      return "accepted";
    });
    const second = queue.enqueue("second", next);
    const rejected = expect(second).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    let closed = false;
    const closing = queue.close().then(() => {
      closed = true;
    });
    await rejected;
    expect(closed).toBe(false);
    release();
    await closing;
    await expect(first).resolves.toBe("accepted");
    expect(next).not.toHaveBeenCalled();
    await expect(queue.enqueue("new", next)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("honors the constructor lifetime signal and removes the last waiting timer", async () => {
    const lifetime = new AbortController();
    const queue = new PacedSendQueue({ signal: lifetime.signal });
    await queue.enqueue("first", async () => "first");
    await vi.advanceTimersByTimeAsync(0);
    const send = vi.fn(async () => "no");
    const next = queue.enqueue("", send);
    const rejected = expect(next).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(1);
    lifetime.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(send).not.toHaveBeenCalled();
    await queue.close();
  });
});
