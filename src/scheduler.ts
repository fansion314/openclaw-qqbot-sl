import { randomUUID } from "node:crypto";
import { EventStore, type StoredEvent, type ConversationState } from "./store.js";
import { liveNewCommand } from "./commands.js";

export interface ConversationPolicy {
  mode: "autonomous" | "mention";
  batchIntervalMs?: number;
  initialBatchWaitMs?: number;
  initialBatchMaxWaitMs?: number;
  maxMessages?: number;
  idleEnabled?: boolean;
  idleAfterMs?: number;
  activeHours?: { start: string; end: string }[];
  timeZone?: string;
}

export interface DispatchBatch {
  id: string;
  accountId: string;
  conversationKey: string;
  kind: StoredEvent["kind"];
  events: StoredEvent[];
  droppedCount: number;
  trigger: "message" | "mention" | "idle";
  /** For idle sends, recheck immediately before every visible effect. */
  isCurrent(): boolean;
}

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(timer: unknown): void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

interface Lane {
  state: ConversationState;
  running?: Promise<void>;
  retryAt?: number;
}

function key(accountId: string, conversationKey: string): string {
  return JSON.stringify([accountId, conversationKey]);
}

function minuteOfDay(time: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(time);
  return (
    Number(parts.find((p) => p.type === "hour")!.value) * 60 +
    Number(parts.find((p) => p.type === "minute")!.value)
  );
}

function parseTime(time: string): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw new Error(`Invalid active-hours time: ${time}`);
  const [hours, minutes] = time.split(":").map(Number);
  return hours! * 60 + minutes!;
}

export function isActiveTime(time: number, policy: ConversationPolicy): boolean {
  if (!policy.activeHours?.length) return true;
  const minute = minuteOfDay(time, policy.timeZone ?? "Asia/Shanghai");
  return policy.activeHours.some(({ start, end }) => {
    const a = parseTime(start);
    const b = parseTime(end);
    return a === b || (a < b ? minute >= a && minute < b : minute >= a || minute < b);
  });
}

function nextActiveTime(time: number, policy: ConversationPolicy): number {
  if (isActiveTime(time, policy)) return time;
  // Minute granularity follows HH:mm configuration, including DST transitions.
  const start = Math.floor(time / 60_000) * 60_000 + 60_000;
  for (let at = start; at <= start + 48 * 3_600_000; at += 60_000) {
    if (isActiveTime(at, policy)) return at;
  }
  throw new Error("No active time found in the next 48 hours");
}

export class Scheduler {
  private readonly store: EventStore;
  private readonly policy: (event: StoredEvent) => ConversationPolicy;
  private readonly dispatch: (batch: DispatchBatch, control: { accept(): void }) => Promise<void>;
  private readonly clock: Clock;
  private readonly onError: (error: unknown, batch?: DispatchBatch) => void;
  private readonly lanes = new Map<string, Lane>();
  private timer?: unknown;
  private started = false;
  private stopped = false;

  constructor(options: {
    store: EventStore;
    policy: (event: StoredEvent) => ConversationPolicy;
    dispatch: (batch: DispatchBatch, control: { accept(): void }) => Promise<void>;
    clock?: Clock;
    onError?: (error: unknown, batch?: DispatchBatch) => void;
  }) {
    this.store = options.store;
    this.policy = options.policy;
    this.dispatch = options.dispatch;
    this.clock = options.clock ?? realClock;
    this.onError = options.onError ?? ((error) => console.error("QQ scheduler failed", error));
  }

  start(): void {
    if (this.stopped) throw new Error("Scheduler has stopped");
    if (this.started) return;
    this.started = true;
    this.store.recover(this.clock.now());
    for (const state of this.store.states())
      this.lanes.set(key(state.accountId, state.conversationKey), { state });
    this.pump();
  }

  ingest(event: StoredEvent): void {
    if (this.stopped) throw new Error("Scheduler has stopped");
    const now = this.clock.now();
    const previous = this.store.state(event.accountId, event.conversationKey);
    const pending = this.store.pending(event.accountId, event.conversationKey);
    if (!this.store.add(event, now)) return;
    const id = key(event.accountId, event.conversationKey);
    const lane = this.lanes.get(id);
    const policy = this.policy(event);
    if (
      event.kind === "group" &&
      policy.mode === "autonomous" &&
      !event.self &&
      event.trigger !== false &&
      !event.mention &&
      !lane?.running
    ) {
      const interval = Math.max(0, policy.batchIntervalMs ?? 30_000);
      const cooldownExpired =
        previous?.lastSubmissionAt == null || now >= previous.lastSubmissionAt + interval;
      const existingWindow = previous?.burstStartAt != null && previous.burstLastAt != null;
      if (existingWindow || (!pending.triggerable && cooldownExpired))
        this.store.setBurstWindow(
          event.accountId,
          event.conversationKey,
          existingWindow ? previous.burstStartAt! : now,
          now,
        );
    }
    const state = this.store.state(event.accountId, event.conversationKey)!;
    if (lane) lane.state = state;
    else this.lanes.set(id, { state });
    if (this.started) this.pump();
  }

  /** Admit an entire catch-up snapshot before selecting the next batch. */
  ingestMany(events: StoredEvent[]): void {
    const started = this.started;
    this.started = false;
    try {
      for (const event of events) this.ingest(event);
    } finally {
      this.started = started;
      if (started) this.pump();
    }
  }

  private due(lane: Lane): { at: number; trigger: DispatchBatch["trigger"] } | undefined {
    if (lane.running) return;
    const state = lane.state;
    const policy = this.policy(state.exemplar);
    const pending = this.store.pending(state.accountId, state.conversationKey);
    const now = this.clock.now();
    const retryAt = lane.retryAt ?? 0;
    if (pending.mentioned) return { at: Math.max(now, retryAt), trigger: "mention" };
    if (pending.triggerable && (state.kind === "private" || policy.mode === "autonomous")) {
      const interval = state.kind === "private" ? 0 : Math.max(0, policy.batchIntervalMs ?? 30_000);
      const burstDue =
        state.kind === "group" && state.burstStartAt !== null && state.burstLastAt !== null
          ? Math.min(
              state.burstLastAt + Math.max(0, policy.initialBatchWaitMs ?? 10_000),
              state.burstStartAt + Math.max(0, policy.initialBatchMaxWaitMs ?? 30_000),
            )
          : 0;
      return {
        at: Math.max(
          retryAt,
          burstDue,
          state.lastSubmissionAt === null ? now : state.lastSubmissionAt + interval,
        ),
        trigger: "message",
      };
    }
    const idleEnabled =
      policy.idleEnabled ?? (state.kind === "group" && policy.mode === "autonomous");
    if (
      idleEnabled &&
      state.humanGeneration > 0 &&
      state.humanGeneration !== state.idleAttemptGeneration
    ) {
      const earliest = Math.max(
        now,
        retryAt,
        state.lastActivityAt + Math.max(1, policy.idleAfterMs ?? 3_600_000),
      );
      return { at: nextActiveTime(earliest, policy), trigger: "idle" };
    }
  }

  private pump(): void {
    if (!this.started || this.stopped) return;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    let next = Infinity;
    for (const lane of this.lanes.values()) {
      try {
        const due = this.due(lane);
        if (!due) continue;
        if (due.at <= this.clock.now()) this.launch(lane, due.trigger);
        else next = Math.min(next, due.at);
      } catch (error) {
        this.onError(error);
      }
    }
    if (next !== Infinity)
      this.timer = this.clock.setTimeout(
        () => {
          this.timer = undefined;
          this.pump();
        },
        Math.min(2_147_483_647, Math.max(1, next - this.clock.now())),
      );
  }

  private launch(lane: Lane, trigger: DispatchBatch["trigger"]): void {
    const state = lane.state;
    const generation = state.humanGeneration;
    if (
      trigger === "idle" &&
      !this.store.claimIdle(state.accountId, state.conversationKey, generation)
    )
      return;
    const selection = this.store.selectForAgent(
      state.accountId,
      state.conversationKey,
      this.policy(state.exemplar).maxMessages ?? 100,
      trigger === "idle",
    );
    const command = liveNewCommand(selection.events);
    if (command) {
      selection.events = [command];
      selection.watermark =
        this.store.eventWatermark(state.accountId, state.conversationKey, command.id) ??
        selection.watermark;
    }
    const batch: DispatchBatch = {
      id: randomUUID(),
      accountId: state.accountId,
      conversationKey: state.conversationKey,
      kind: state.kind,
      events: selection.events,
      droppedCount: selection.droppedCount,
      trigger,
      isCurrent: () =>
        !this.stopped &&
        (trigger !== "idle" ||
          this.store.state(state.accountId, state.conversationKey)?.humanGeneration === generation),
    };
    this.store.prepareBatch(
      batch.id,
      state.accountId,
      state.conversationKey,
      selection.watermark,
      this.clock.now(),
    );
    let accepted = false;
    const accept = () => {
      if (accepted) return;
      this.store.acceptBatch(batch.id, this.clock.now());
      accepted = true;
      lane.state = this.store.state(state.accountId, state.conversationKey)!;
    };
    // Assign the running promise before invoking user code: synchronous re-entrant ingestion is serialized too.
    lane.running = Promise.resolve()
      .then(async () => {
        try {
          await this.dispatch(batch, { accept });
          if (!accepted && trigger !== "idle")
            throw new Error("Agent dispatch completed without accepting its batch");
          this.store.finishBatch(batch.id);
          lane.retryAt = undefined;
        } catch (error) {
          this.store.finishBatch(batch.id, true);
          if (!accepted) lane.retryAt = this.clock.now() + 5_000;
          this.onError(error, batch);
        }
      })
      .finally(() => {
        lane.running = undefined;
        lane.state = this.store.state(state.accountId, state.conversationKey)!;
        this.pump();
      });
  }

  /** Drain accepted work before the owner closes its transport and SQLite connection. */
  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    await Promise.all([...this.lanes.values()].map((lane) => lane.running));
  }
}
