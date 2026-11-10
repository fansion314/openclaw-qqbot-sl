import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ImageLinks } from "../src/image-links.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function links(options: Partial<ConstructorParameters<typeof ImageLinks>[0]> = {}) {
  const service = new ImageLinks({ path: ":memory:", port: 0, ...options });
  cleanups.push(() => service.close());
  await service.start();
  return service;
}
describe("opaque local image links", () => {
  it("redirects GET and HEAD only, with no-store and no-referrer", async () => {
    const service = await links();
    const original = "https://example.com/qq/image?long=sensitive-source";
    const short = service.shorten(original, "account:conversation");
    expect(short).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/i\/[A-Za-z0-9_-]{22}$/);
    expect(short).not.toContain("sensitive-source");
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(short, { method, redirect: "manual" });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(original);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(await response.text()).toBe("");
    }
    expect((await fetch(short, { method: "POST", redirect: "manual" })).status).toBe(405);
  });
  it("only resolves registered exact same-scope links and rejects redirect parameters", async () => {
    const service = await links();
    const short = service.shorten("https://example.com/img", "alice:room");
    expect(service.resolve(short, "alice:room")).toBe("https://example.com/img");
    expect(service.resolve(short, "bob:room")).toBeUndefined();
    expect(service.resolve(short.replace("127.0.0.1", "localhost"), "alice:room")).toBeUndefined();
    expect(service.resolve(`${short}?url=https://evil.example`, "alice:room")).toBeUndefined();
    expect((await fetch(`${short}?url=https://evil.example`, { redirect: "manual" })).status).toBe(
      404,
    );
    expect(
      (await fetch(short.replace(/.{22}$/, "A".repeat(22)), { redirect: "manual" })).status,
    ).toBe(404);
    expect(service.shorten("https://example.com/img", "alice:room")).toBe(short);
    expect(service.shorten("https://example.com/img", "bob:room")).not.toBe(short);
  });
  it("persists tokens across restart on the same port and expires them", async () => {
    const root = await mkdtemp(join(tmpdir(), "snowluma-images-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    let now = 1000;
    const path = join(root, "links.sqlite");
    const first = await links({ path, ttlMs: 100, now: () => now });
    const short = first.shorten("https://example.com/image", "scope");
    const port = Number(new URL(short).port);
    await first.close();
    const second = await links({ path, port, ttlMs: 100, now: () => now });
    expect(second.resolve(short, "scope")).toBe("https://example.com/image");
    expect(second.shorten("https://example.com/image", "scope")).toBe(short);
    now = 1101;
    expect(second.resolve(short, "scope")).toBeUndefined();
    expect((await fetch(short, { redirect: "manual" })).status).toBe(404);
  });
  it("bounds retained links and rejects unsupported or nested URL sources", async () => {
    let now = 1;
    const service = await links({ maxLinks: 2, now: () => now });
    const oldest = service.shorten("https://example.com/1", "scope");
    now++;
    const retained = service.shorten("https://example.com/2", "scope");
    now++;
    service.shorten("https://example.com/3", "scope");
    expect(service.resolve(oldest, "scope")).toBeUndefined();
    expect(service.resolve(retained, "scope")).toBe("https://example.com/2");
    expect(() => service.shorten("file:///etc/passwd", "scope")).toThrow("Invalid image");
    expect(() => service.shorten("https://user@example.com/img", "scope")).toThrow("Invalid image");
    expect(() => service.shorten(retained, "scope")).toThrow("local image-link");
  });
  it("requires start and releases its listener and database on close", async () => {
    const service = new ImageLinks({ path: ":memory:", port: 0 });
    expect(() => service.shorten("https://example.com/image", "scope")).toThrow("started first");
    await service.start();
    const short = service.shorten("https://example.com/image", "scope");
    await service.close();
    await service.close();
    expect(service.resolve(short, "scope")).toBeUndefined();
    await expect(service.start()).rejects.toThrow("closed");
    await expect(fetch(short)).rejects.toThrow();
  });
  it("fails visibly when its stable port is already occupied", async () => {
    const active = await links();
    const short = active.shorten("https://example.com/image", "scope");
    const duplicate = new ImageLinks({ path: ":memory:", port: Number(new URL(short).port) });
    cleanups.push(() => duplicate.close());
    await expect(duplicate.start()).rejects.toThrow("Unable to bind local image-link listener");
    expect(() => duplicate.shorten("https://example.com/image", "scope")).toThrow("started first");
    expect(active.resolve(short, "scope")).toBe("https://example.com/image");
  });
});
