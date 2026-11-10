import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ImageLinksOptions {
  path: string;
  port?: number;
  ttlMs?: number;
  maxLinks?: number;
  /** Injected clock for expiry tests. */
  now?: () => number;
}
type LinkRow = { token: string; source: string; scope: string; expires_at: number };
const TOKEN = /^[A-Za-z0-9_-]{22}$/;

/** A local, opaque image-link registry. Short URLs carry bearer read access. */
export class ImageLinks {
  private readonly db: DatabaseSync;
  private readonly ttlMs: number;
  private readonly maxLinks: number;
  private readonly now: () => number;
  private server?: Server;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private origin?: string;
  private closed = false;

  constructor(private readonly options: ImageLinksOptions) {
    const port = options.port ?? 17861;
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("Invalid image-link port");
    this.ttlMs = options.ttlMs ?? 7 * 86400000;
    this.maxLinks = options.maxLinks ?? 10000;
    this.now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.ttlMs) ||
      this.ttlMs <= 0 ||
      !Number.isSafeInteger(this.maxLinks) ||
      this.maxLinks <= 0
    )
      throw new Error("Invalid image-link retention limits");
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
    this.db = new DatabaseSync(options.path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS image_links (
        token TEXT PRIMARY KEY, scope TEXT NOT NULL, source TEXT NOT NULL,
        expires_at INTEGER NOT NULL, touched_at INTEGER NOT NULL,
        UNIQUE(scope,source)
      );
      CREATE INDEX IF NOT EXISTS image_links_expiry ON image_links(expires_at);`);
  }

  private prune(): void {
    this.db.prepare("DELETE FROM image_links WHERE expires_at <= ?").run(this.now());
    this.db
      .prepare(`DELETE FROM image_links WHERE token IN (
      SELECT token FROM image_links ORDER BY touched_at DESC, rowid DESC LIMIT -1 OFFSET ?
    )`)
      .run(this.maxLinks);
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Image-link registry is closed"));
    if (this.starting) return this.starting;
    if (this.origin) return Promise.resolve();
    const server = createServer((request, response) => this.handle(request, response));
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    this.server = server;
    this.starting = new Promise<void>((resolve, reject) => {
      const failed = () => {
        server.removeListener("listening", listening);
        this.server = undefined;
        this.starting = undefined;
        reject(new Error("Unable to bind local image-link listener"));
      };
      const listening = () => {
        server.removeListener("error", failed);
        const address = server.address();
        if (!address || typeof address === "string") return failed();
        this.origin = `http://127.0.0.1:${address.port}`;
        this.prune();
        resolve();
      };
      server.once("error", failed);
      server.once("listening", listening);
      server.listen(this.options.port ?? 17861, "127.0.0.1");
    });
    return this.starting;
  }

  shorten(source: string, scope: string): string {
    if (!this.origin || this.closed) throw new Error("Image-link registry must be started first");
    if (!scope || scope.length > 8192) throw new Error("Invalid image-link scope");
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw new Error("Invalid image source URL");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.href.split("://")[1]?.split("/")[0]?.includes("@") ||
      source.length > 65536
    )
      throw new Error("Invalid image source URL");
    if (url.origin === this.origin) throw new Error("Cannot register a local image-link redirect");
    this.prune();
    const canonical = url.href;
    const prior = this.db
      .prepare("SELECT token FROM image_links WHERE scope=? AND source=?")
      .get(scope, canonical) as { token: string } | undefined;
    const token = prior?.token ?? randomBytes(16).toString("base64url");
    const now = this.now();
    this.db
      .prepare(`INSERT INTO image_links(token,scope,source,expires_at,touched_at) VALUES(?,?,?,?,?)
      ON CONFLICT(scope,source) DO UPDATE SET expires_at=excluded.expires_at,touched_at=excluded.touched_at`)
      .run(token, scope, canonical, now + this.ttlMs, now);
    this.prune();
    return `${this.origin}/i/${token}`;
  }

  private tokenFor(shortUrl: string): string | undefined {
    if (!this.origin || this.closed) return undefined;
    if (shortUrl.startsWith("qqimg:")) {
      const token = shortUrl.slice(6);
      return TOKEN.test(token) ? token : undefined;
    }
    let url: URL;
    try {
      url = new URL(shortUrl);
    } catch {
      return undefined;
    }
    if (url.origin !== this.origin || url.search || url.hash || url.username) return undefined;
    const token = url.pathname.startsWith("/i/") ? url.pathname.slice(3) : "";
    return TOKEN.test(token) ? token : undefined;
  }

  compact(source: string, scope: string): string {
    const full = this.shorten(source, scope);
    return `qqimg:${new URL(full).pathname.slice(3)}`;
  }

  resolve(shortUrl: string, scope: string): string | undefined {
    const token = this.tokenFor(shortUrl);
    if (!token) return undefined;
    this.prune();
    const row = this.db
      .prepare("SELECT source FROM image_links WHERE token=? AND scope=? AND expires_at>?")
      .get(token, scope, this.now()) as { source: string } | undefined;
    return row?.source;
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      response.writeHead(405);
      response.end();
      return;
    }
    if (
      !this.origin ||
      request.headers.host !== new URL(this.origin).host ||
      !request.url?.startsWith("/i/")
    ) {
      response.writeHead(404);
      response.end();
      return;
    }
    const token = this.tokenFor(`${this.origin}${request.url}`);
    if (!token) {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      this.prune();
      const row = this.db
        .prepare("SELECT source FROM image_links WHERE token=? AND expires_at>?")
        .get(token, this.now()) as LinkRow | undefined;
      if (!row) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.setHeader("Location", row.source);
      response.writeHead(302);
      response.end();
    } catch {
      response.writeHead(503);
      response.end();
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.origin = undefined;
    this.closing = (async () => {
      if (this.starting) await this.starting.catch(() => {});
      const server = this.server;
      this.server = undefined;
      if (server?.listening)
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      this.origin = undefined;
      this.db.close();
    })();
    return this.closing;
  }
}
