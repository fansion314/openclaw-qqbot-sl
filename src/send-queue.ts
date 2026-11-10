export interface TypingDelayOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
  saturationChars?: number;
}

export interface SendQueueClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(timer: unknown): void;
}

function normalized(options: TypingDelayOptions): Required<TypingDelayOptions> {
  const minDelayMs = options.minDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 10_000;
  const saturationChars = options.saturationChars ?? 100;
  if (
    !Number.isFinite(minDelayMs) ||
    minDelayMs < 0 ||
    !Number.isFinite(maxDelayMs) ||
    maxDelayMs < minDelayMs ||
    !Number.isFinite(saturationChars) ||
    saturationChars <= 0
  )
    throw new Error("Invalid send pacing configuration");
  return { minDelayMs, maxDelayMs, saturationChars };
}

/** Count Unicode code points rather than UTF-16 units; non-text media uses the minimum pause. */
export function typingDelay(text: string, options: TypingDelayOptions = {}): number {
  const { minDelayMs, maxDelayMs, saturationChars } = normalized(options);
  let count = 0;
  for (const _character of text) {
    if (++count >= saturationChars) return maxDelayMs;
  }
  return Math.round(
    Math.min(
      maxDelayMs,
      Math.max(
        minDelayMs,
        minDelayMs + ((maxDelayMs - minDelayMs) * Math.log1p(count)) / Math.log1p(saturationChars),
      ),
    ),
  );
}

const defaultClock: SendQueueClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

interface Entry {
  text: string;
  send(): Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  removeAbort(): void;
}

function aborted(): Error {
  return new DOMException("Send cancelled before platform dispatch", "AbortError");
}

/** Per-account native-send lane. Durable replay and retry remain owned by OpenClaw. */
export class PacedSendQueue {
  private readonly options: Required<TypingDelayOptions>;
  private readonly clock: SendQueueClock;
  private readonly entries: Entry[] = [];
  private timer?: unknown;
  private inFlight?: Promise<void>;
  private lastCompletion?: number;
  private closed = false;
  private readonly removeAbort: () => void;

  constructor(options: TypingDelayOptions & { clock?: SendQueueClock; signal?: AbortSignal } = {}) {
    this.options = normalized(options);
    this.clock = options.clock ?? defaultClock;
    const onAbort = () => {
      void this.close();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    this.removeAbort = () => options.signal?.removeEventListener("abort", onAbort);
    if (options.signal?.aborted) void this.close();
  }

  enqueue<T>(text: string, send: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed || signal?.aborted) return Promise.reject(aborted());
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = {
        text,
        send,
        resolve: (value) => resolve(value as T),
        reject,
        signal,
        removeAbort: () => signal?.removeEventListener("abort", onAbort),
      };
      const onAbort = () => {
        const index = this.entries.indexOf(entry);
        if (index < 0) return;
        this.entries.splice(index, 1);
        entry.removeAbort();
        reject(aborted());
        this.pump();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.entries.push(entry);
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || this.inFlight || !this.entries.length) return;
    const entry = this.entries[0]!;
    const due =
      this.lastCompletion === undefined
        ? this.clock.now()
        : this.lastCompletion + typingDelay(entry.text, this.options);
    const delay = due - this.clock.now();
    if (delay > 0) {
      this.timer = this.clock.setTimeout(
        () => {
          this.timer = undefined;
          this.pump();
        },
        Math.min(delay, 2_147_483_647),
      );
      return;
    }
    this.entries.shift();
    // Establish ownership before calling user code, including synchronous reentrant enqueues.
    this.inFlight = Promise.resolve()
      .then(async () => {
        try {
          if (this.closed || entry.signal?.aborted) throw aborted();
          entry.removeAbort();
          try {
            const result = await entry.send();
            entry.resolve(result);
          } finally {
            // A failed or uncertain attempted send still imposes a pause; never retry it here.
            this.lastCompletion = this.clock.now();
          }
        } catch (error) {
          entry.reject(error);
        } finally {
          entry.removeAbort();
        }
      })
      .finally(() => {
        this.inFlight = undefined;
        this.pump();
      });
  }

  /** Reject work that has not entered native I/O, and join the operation already in progress. */
  async close(): Promise<void> {
    this.closed = true;
    this.removeAbort();
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    for (const entry of this.entries.splice(0)) {
      entry.removeAbort();
      entry.reject(aborted());
    }
    await this.inFlight;
  }
}
