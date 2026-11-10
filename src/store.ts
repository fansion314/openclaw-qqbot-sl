import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface StoredEvent {
  /** Set only after a live native command passes host authorization. */
  liveCommand?: "/new";
  id: string;
  conversationKey: string;
  accountId: string;
  kind: "group" | "private";
  time: number;
  userId: string;
  body: string;
  /** Trusted XML fragment produced locally by formatInboundMessage, never copied from wire input. */
  formattedBody?: string;
  media?: {
    kind: string;
    url?: string;
    messageId: string;
    ref: string;
    file?: string;
    name?: string;
    data?: Record<string, unknown>;
  }[];
  mention: boolean;
  self: boolean;
  payload?: unknown;
  /** False retains context without independently asking the agent to run. */
  trigger?: boolean;
  /** False for history imports, reactions and other non-message events. */
  human?: boolean;
}

export interface ConversationState {
  accountId: string;
  conversationKey: string;
  kind: StoredEvent["kind"];
  lastSubmissionAt: number | null;
  burstStartAt: number | null;
  burstLastAt: number | null;
  lastActivityAt: number;
  lastHumanAt: number;
  humanGeneration: number;
  idleAttemptGeneration: number;
  exemplar: StoredEvent;
}

export interface EventSelection {
  events: StoredEvent[];
  droppedCount: number;
  watermark: number;
}

interface EventRow {
  seq: number;
  event: string | null;
  mention: number;
  wake: number;
}
interface StateRow {
  account_id: string;
  conversation_key: string;
  kind: StoredEvent["kind"];
  last_submission_at: number | null;
  burst_start_at: number | null;
  burst_last_at: number | null;
  last_activity_at: number;
  last_human_at: number;
  human_generation: number;
  idle_attempt_generation: number;
  exemplar: string;
}

/** SQLite owns admission cursors; cached bodies may expire without losing pending-gap evidence. */
export class EventStore {
  private readonly db: DatabaseSync;
  private readonly maxCached: number;
  private readonly retentionMs: number;

  constructor(path: string, options: { cacheMaxMessages?: number; retentionMs?: number } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.maxCached = Math.max(1, Math.floor(options.cacheMaxMessages ?? 500));
    this.retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS conversations (
        account_id TEXT NOT NULL, conversation_key TEXT NOT NULL, kind TEXT NOT NULL,
        last_submission_at INTEGER, last_activity_at INTEGER NOT NULL DEFAULT 0,
        last_human_at INTEGER NOT NULL DEFAULT 0, human_generation INTEGER NOT NULL DEFAULT 0,
        idle_attempt_generation INTEGER NOT NULL DEFAULT -1, exemplar TEXT NOT NULL,
        dropped_count INTEGER NOT NULL DEFAULT 0, dropped_wake INTEGER NOT NULL DEFAULT 0,
        dropped_mention INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, conversation_key)
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL, conversation_key TEXT NOT NULL, event_id TEXT NOT NULL,
        time INTEGER NOT NULL, mention INTEGER NOT NULL, wake INTEGER NOT NULL, event TEXT, seen INTEGER NOT NULL DEFAULT 0,
        UNIQUE (account_id, conversation_key, event_id)
      );
      CREATE INDEX IF NOT EXISTS events_pending ON events(account_id,conversation_key,seen,seq);
      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, conversation_key TEXT NOT NULL,
        watermark INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
        dropped_count INTEGER NOT NULL DEFAULT 0, dropped_wake INTEGER NOT NULL DEFAULT 0,
        dropped_mention INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS receipts (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, conversation_key TEXT NOT NULL,
        data TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_users (
        account_id TEXT NOT NULL, session_id TEXT NOT NULL, user_id TEXT NOT NULL,
        profile TEXT NOT NULL, PRIMARY KEY(account_id,session_id,user_id)
      );
    `);
    // Persist sender direction separately so retention can remove a body without
    // turning a self-authored message into a model-facing gap.
    const columns = this.db.prepare("PRAGMA table_info(events)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "is_self")) {
      this.db.exec("ALTER TABLE events ADD COLUMN is_self INTEGER NOT NULL DEFAULT 0");
      this.db.exec(
        "UPDATE events SET is_self=COALESCE(json_extract(event,'$.self'),0) WHERE event IS NOT NULL",
      );
    }
    const conversationColumns = this.db.prepare("PRAGMA table_info(conversations)").all() as {
      name: string;
    }[];
    for (const column of ["burst_start_at", "burst_last_at"]) {
      if (!conversationColumns.some((entry) => entry.name === column))
        this.db.exec(`ALTER TABLE conversations ADD COLUMN ${column} INTEGER`);
    }
  }

  add(event: StoredEvent, now = Date.now()): boolean {
    const data = JSON.stringify(event);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.db
        .prepare(`INSERT OR IGNORE INTO events
        (account_id,conversation_key,event_id,time,mention,wake,event,is_self) VALUES (?,?,?,?,?,?,?,?)`)
        .run(
          event.accountId,
          event.conversationKey,
          event.id,
          event.time,
          Number(event.mention && !event.self && event.trigger !== false),
          Number(!event.self && event.trigger !== false),
          data,
          Number(event.self),
        );
      if (Number(inserted.changes) === 0) {
        this.db.exec("COMMIT");
        return false;
      }
      const human = event.human ?? (!event.self && event.trigger !== false);
      const exemplar = JSON.stringify({ ...event, body: "", payload: undefined });
      this.db
        .prepare(`INSERT INTO conversations
        (account_id,conversation_key,kind,last_activity_at,last_human_at,human_generation,exemplar)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_id,conversation_key) DO UPDATE SET
        last_activity_at=MAX(last_activity_at,excluded.last_activity_at),
        last_human_at=MAX(last_human_at,excluded.last_human_at),
        human_generation=human_generation+excluded.human_generation, exemplar=excluded.exemplar`)
        .run(
          event.accountId,
          event.conversationKey,
          event.kind,
          event.time,
          human ? event.time : 0,
          Number(human),
          exemplar,
        );
      this.pruneConversation(event.accountId, event.conversationKey, now);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private pruneConversation(accountId: string, key: string, now: number): void {
    // Retain identity rows for pending expired bodies so the next batch exposes its gap.
    this.db
      .prepare(`UPDATE events SET event=NULL WHERE account_id=? AND conversation_key=?
      AND event IS NOT NULL AND (time<? OR seq NOT IN
      (SELECT seq FROM events WHERE account_id=? AND conversation_key=? AND event IS NOT NULL ORDER BY seen ASC,mention DESC,time DESC,seq DESC LIMIT ?))`)
      .run(accountId, key, now - this.retentionMs, accountId, key, this.maxCached);
    this.db
      .prepare("DELETE FROM events WHERE account_id=? AND conversation_key=? AND seen=1 AND time<?")
      .run(accountId, key, now - this.retentionMs);
    // Compact old identity-only rows into a visible aggregate gap. Protect snapshots
    // currently awaiting host acceptance so acknowledgement cannot lose its boundary.
    const compact = this.db
      .prepare(`SELECT seq,seen,wake,mention,is_self FROM events WHERE account_id=? AND conversation_key=?
      AND event IS NULL AND (time<? OR seq NOT IN
      (SELECT seq FROM events WHERE account_id=? AND conversation_key=? ORDER BY seq DESC LIMIT ?))
      AND NOT EXISTS (SELECT 1 FROM batches WHERE batches.account_id=events.account_id
        AND batches.conversation_key=events.conversation_key AND status='prepared' AND watermark>=events.seq)`)
      .all(
        accountId,
        key,
        now - this.retentionMs,
        accountId,
        key,
        this.maxCached * 4,
      ) as unknown as {
      seq: number;
      seen: number;
      wake: number;
      mention: number;
      is_self: number;
    }[];
    const pending = compact.filter((row) => !row.seen && !row.is_self);
    if (pending.length)
      this.db
        .prepare(`UPDATE conversations SET dropped_count=dropped_count+?,
      dropped_wake=dropped_wake+?,dropped_mention=dropped_mention+? WHERE account_id=? AND conversation_key=?`)
        .run(
          pending.length,
          pending.reduce((n, row) => n + row.wake, 0),
          pending.reduce((n, row) => n + row.mention, 0),
          accountId,
          key,
        );
    const remove = this.db.prepare("DELETE FROM events WHERE seq=?");
    for (const row of compact) remove.run(row.seq);
    this.db
      .prepare(
        "DELETE FROM batches WHERE status IN ('completed','failed','interrupted') AND created_at<?",
      )
      .run(now - this.retentionMs);
    this.db.prepare("DELETE FROM receipts WHERE created_at<?").run(now - this.retentionMs);
  }

  state(accountId: string, key: string): ConversationState | undefined {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE account_id=? AND conversation_key=?")
      .get(accountId, key) as unknown as StateRow | undefined;
    return row && this.decodeState(row);
  }

  states(): ConversationState[] {
    return (this.db.prepare("SELECT * FROM conversations").all() as unknown as StateRow[]).map(
      (row) => this.decodeState(row),
    );
  }

  private decodeState(row: StateRow): ConversationState {
    return {
      accountId: row.account_id,
      conversationKey: row.conversation_key,
      kind: row.kind,
      lastSubmissionAt: row.last_submission_at,
      burstStartAt: row.burst_start_at,
      burstLastAt: row.burst_last_at,
      lastActivityAt: row.last_activity_at,
      lastHumanAt: row.last_human_at,
      humanGeneration: row.human_generation,
      idleAttemptGeneration: row.idle_attempt_generation,
      exemplar: JSON.parse(row.exemplar) as StoredEvent,
    };
  }

  setBurstWindow(accountId: string, key: string, startAt: number, lastAt: number): void {
    this.db
      .prepare(
        "UPDATE conversations SET burst_start_at=?,burst_last_at=? WHERE account_id=? AND conversation_key=?",
      )
      .run(startAt, lastAt, accountId, key);
  }

  pending(
    accountId: string,
    key: string,
  ): { count: number; mentioned: boolean; triggerable: boolean } {
    const rows = this.db
      .prepare(
        "SELECT event,mention,wake FROM events WHERE account_id=? AND conversation_key=? AND seen=0",
      )
      .all(accountId, key) as unknown as EventRow[];
    const gaps = this.db
      .prepare(
        "SELECT dropped_count,dropped_wake,dropped_mention FROM conversations WHERE account_id=? AND conversation_key=?",
      )
      .get(accountId, key) as
      | { dropped_count: number; dropped_wake: number; dropped_mention: number }
      | undefined;
    return {
      count: rows.length + (gaps?.dropped_count ?? 0),
      mentioned: Boolean(gaps?.dropped_mention) || rows.some((row) => Boolean(row.mention)),
      triggerable: Boolean(gaps?.dropped_wake) || rows.some((row) => Boolean(row.wake)),
    };
  }

  select(accountId: string, key: string, maxMessages = 100, includeRecent = false): EventSelection {
    return this.selectEvents(accountId, key, maxMessages, includeRecent, false);
  }

  /** Select fresh platform input without echoing the assistant's own QQ output. */
  selectForAgent(
    accountId: string,
    key: string,
    maxMessages = 100,
    includeRecent = false,
  ): EventSelection {
    return this.selectEvents(accountId, key, maxMessages, includeRecent, true);
  }

  private selectEvents(
    accountId: string,
    key: string,
    maxMessages: number,
    includeRecent: boolean,
    excludeSelf: boolean,
  ): EventSelection {
    const watermark = Number(
      (
        this.db
          .prepare(
            "SELECT COALESCE(MAX(seq),0) value FROM events WHERE account_id=? AND conversation_key=?",
          )
          .get(accountId, key) as { value: number }
      ).value,
    );
    const limit = Math.max(1, Math.floor(maxMessages));
    const rows = this.db
      .prepare(`SELECT seq,event,mention FROM events WHERE account_id=? AND conversation_key=?
      AND seq<=? ${includeRecent ? "" : "AND seen=0"} ${excludeSelf ? "AND is_self=0" : ""} AND event IS NOT NULL ORDER BY ${includeRecent ? "" : "mention DESC,"}time DESC,seq DESC LIMIT ?`)
      .all(accountId, key, watermark, limit) as unknown as EventRow[];
    const total = Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) value FROM events WHERE account_id=? AND conversation_key=? AND seq<=? ${includeRecent ? "" : "AND seen=0"} ${excludeSelf ? "AND is_self=0" : ""}`,
          )
          .get(accountId, key, watermark) as { value: number }
      ).value,
    );
    const events = rows
      .map((row) => ({ event: JSON.parse(row.event!) as StoredEvent, seq: row.seq }))
      .sort((a, b) => a.event.time - b.event.time || a.seq - b.seq)
      .map((entry) => entry.event);
    const gaps = this.db
      .prepare("SELECT dropped_count FROM conversations WHERE account_id=? AND conversation_key=?")
      .get(accountId, key) as { dropped_count: number } | undefined;
    return {
      events,
      droppedCount: Math.max(0, total - events.length) + (gaps?.dropped_count ?? 0),
      watermark,
    };
  }

  prepareBatch(id: string, accountId: string, key: string, watermark: number, now: number): void {
    this.db
      .prepare(`INSERT INTO batches(id,account_id,conversation_key,watermark,status,created_at,dropped_count,dropped_wake,dropped_mention)
      SELECT ?,?,?,?,'prepared',?,dropped_count,dropped_wake,dropped_mention FROM conversations WHERE account_id=? AND conversation_key=?`)
      .run(id, accountId, key, watermark, now, accountId, key);
  }

  eventWatermark(accountId: string, key: string, eventId: string): number | undefined {
    const row = this.db
      .prepare("SELECT seq FROM events WHERE account_id=? AND conversation_key=? AND event_id=?")
      .get(accountId, key, eventId) as { seq: number } | undefined;
    return row?.seq;
  }

  acceptBatch(id: string, now: number): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM batches WHERE id=?").get(id) as
        | {
            account_id: string;
            conversation_key: string;
            watermark: number;
            status: string;
            dropped_count: number;
            dropped_wake: number;
            dropped_mention: number;
          }
        | undefined;
      if (!row) throw new Error(`Unknown batch ${id}`);
      if (row.status !== "prepared") {
        this.db.exec("COMMIT");
        return;
      }
      this.db
        .prepare("UPDATE events SET seen=1 WHERE account_id=? AND conversation_key=? AND seq<=?")
        .run(row.account_id, row.conversation_key, row.watermark);
      this.db
        .prepare(`UPDATE conversations SET last_submission_at=?,burst_start_at=NULL,burst_last_at=NULL,dropped_count=dropped_count-?,
        dropped_wake=dropped_wake-?,dropped_mention=dropped_mention-? WHERE account_id=? AND conversation_key=?`)
        .run(
          now,
          row.dropped_count,
          row.dropped_wake,
          row.dropped_mention,
          row.account_id,
          row.conversation_key,
        );
      this.db.prepare("UPDATE batches SET status=? WHERE id=?").run("accepted", id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  finishBatch(id: string, failed = false): void {
    this.db
      .prepare("UPDATE batches SET status=? WHERE id=?")
      .run(failed ? "failed" : "completed", id);
  }

  claimIdle(accountId: string, key: string, generation: number): boolean {
    return (
      Number(
        this.db
          .prepare(`UPDATE conversations SET idle_attempt_generation=? WHERE account_id=? AND conversation_key=?
      AND human_generation=? AND idle_attempt_generation<>?`)
          .run(generation, accountId, key, generation, generation).changes,
      ) === 1
    );
  }

  saveReceipt(id: string, accountId: string, key: string, data: unknown, now = Date.now()): void {
    this.db
      .prepare("INSERT OR REPLACE INTO receipts VALUES (?,?,?,?,?)")
      .run(id, accountId, key, JSON.stringify(data), now);
  }

  receipt(id: string): unknown {
    const row = this.db.prepare("SELECT data FROM receipts WHERE id=?").get(id) as
      | { data: string }
      | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  knownSessionUsers(accountId: string, sessionId: string): Map<string, string> {
    const rows = this.db
      .prepare("SELECT user_id,profile FROM session_users WHERE account_id=? AND session_id=?")
      .all(accountId, sessionId) as { user_id: string; profile: string }[];
    return new Map(rows.map((row) => [row.user_id, row.profile]));
  }

  /** Caller records only definitions whose containing prompt append is confirmed by the host. */
  recordSessionUsers(accountId: string, sessionId: string, profiles: Map<string, string>): void {
    if (!accountId || !sessionId)
      throw new Error("Account and actual agent session ID are required");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const write = this.db
        .prepare(`INSERT INTO session_users(account_id,session_id,user_id,profile) VALUES (?,?,?,?)
        ON CONFLICT(account_id,session_id,user_id) DO UPDATE SET profile=excluded.profile`);
      for (const [id, profile] of profiles) write.run(accountId, sessionId, id, profile);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  /** Called once by the sole scheduler owner at boot; interrupted sends are never replayed here. */
  recover(now = Date.now()): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE batches SET status='interrupted' WHERE status IN ('prepared','accepted')")
        .run();
      for (const state of this.states())
        this.pruneConversation(state.accountId, state.conversationKey, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
