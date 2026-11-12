import { afterEach, describe, expect, it } from "vite-plus/test";
import { WebSocketServer, type WebSocket } from "ws";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { OneBotTransport, SendCancelledError, type OneBotEvent } from "../src/onebot.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
type Call = { action: string; params: Record<string, unknown>; echo: string };
async function fixture(responder?: (call: Call, socket: WebSocket) => boolean) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of server.clients) socket.terminate();
        server.close(() => resolve());
      }),
  );
  const calls: Call[] = [];
  let latest: WebSocket | undefined;
  server.on("connection", (socket) => {
    latest = socket;
    socket.on("message", (bytes) => {
      const call = JSON.parse(String(bytes)) as Call;
      calls.push(call);
      if (responder?.(call, socket)) return;
      let data: unknown = null;
      if (call.action === "get_login_info") data = { user_id: 10001, nickname: "Test bot" };
      if (call.action.endsWith("_msg_history"))
        data = {
          messages: [
            {
              message_id: -123456,
              user_id: 10002,
              message: [{ type: "text", data: { text: "history" } }],
            },
          ],
        };
      if (call.action === "send_group_msg" || call.action === "send_private_msg")
        data = { message_id: -234567 };
      if (call.action === "get_msg") data = { message_id: -123456, message: [] };
      if (call.action === "get_forward_msg")
        data = {
          messages: [
            {
              message_id: "forward-node-1",
              user_id: 10002,
              message: [{ type: "text", data: { text: "forwarded" } }],
            },
          ],
        };
      if (call.action.endsWith("_list")) data = [];
      socket.send(JSON.stringify({ status: "ok", retcode: 0, data, echo: call.echo }));
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const transport = new OneBotTransport({
    url: `ws://127.0.0.1:${address.port}/`,
    requestTimeoutMs: 500,
    pacing: { minDelayMs: 0, maxDelayMs: 0 },
  });
  cleanup.push(() => transport.close());
  await transport.connect();
  return { transport, calls, socket: () => latest!, url: `ws://127.0.0.1:${address.port}/` };
}

describe("SnowLuma v2.3.4 wire compatibility", () => {
  it("resolves conditional replies only when a queued message reaches native dispatch", async () => {
    let release: (() => void) | undefined;
    const { transport, calls } = await fixture((call, socket) => {
      if (call.action !== "send_group_msg" || release) return false;
      release = () =>
        socket.send(
          JSON.stringify({ status: "ok", retcode: 0, data: { message_id: -1 }, echo: call.echo }),
        );
      return true;
    });
    const target = { kind: "group" as const, id: "20001" };
    const first = transport.send(target, [{ type: "text", data: { text: "blocking" } }]);
    await expect.poll(() => Boolean(release)).toBe(true);
    let hasNewMessage = false;
    let preparations = 0;
    const second = transport.send(target, [{ type: "text", data: { text: "answer" } }], {
      prepare: (parts) => {
        preparations++;
        return hasNewMessage ? [{ type: "reply", data: { id: "-123" } }, ...parts] : parts;
      },
    });
    expect(preparations).toBe(0);
    hasNewMessage = true;
    release!();
    await Promise.all([first, second]);
    expect(preparations).toBe(1);
    expect(calls.at(-1)?.params.message).toEqual([
      { type: "reply", data: { id: "-123" } },
      { type: "text", data: { text: "answer" } },
    ]);
  });

  it("cancels stale queued text and file sends before any platform effect", async () => {
    let release: (() => void) | undefined;
    const { transport, calls } = await fixture((call, socket) => {
      if (call.action !== "send_group_msg" || release) return false;
      release = () =>
        socket.send(
          JSON.stringify({ status: "ok", retcode: 0, data: { message_id: -1 }, echo: call.echo }),
        );
      return true;
    });
    const target = { kind: "group" as const, id: "20001" };
    const first = transport.send(target, [{ type: "text", data: { text: "blocking" } }]);
    await expect.poll(() => Boolean(release)).toBe(true);
    let current = true;
    const assertCurrent = () => {
      if (!current) throw new SendCancelledError();
    };
    const text = transport.send(target, [{ type: "text", data: { text: "stale" } }], {
      assertCurrent,
    });
    const file = transport.sendFile(target, "/server/file", undefined, { assertCurrent });
    const rejected = Promise.all([
      expect(text).rejects.toBeInstanceOf(SendCancelledError),
      expect(file).rejects.toBeInstanceOf(SendCancelledError),
    ]);
    current = false;
    release!();
    await first;
    await rejected;
    expect(calls.filter((call) => call.action === "send_group_msg")).toHaveLength(1);
    expect(calls.some((call) => call.action.includes("upload_group_file"))).toBe(false);
  });

  it("rechecks guards after asynchronous preparation and validates prepared segments", async () => {
    const { transport, calls } = await fixture();
    let current = true;
    await expect(
      transport.send({ kind: "group", id: "20001" }, [{ type: "text", data: { text: "answer" } }], {
        prepare: async (parts) => {
          current = false;
          return parts;
        },
        assertCurrent: () => {
          if (!current) throw new SendCancelledError();
        },
      }),
    ).rejects.toBeInstanceOf(SendCancelledError);
    await expect(
      transport.send(
        { kind: "private", id: "10002" },
        [{ type: "text", data: { text: "answer" } }],
        {
          prepare: () => [{ type: "at", data: { qq: "10002" } }],
        },
      ),
    ).rejects.toThrow("do not support");
    await expect(
      transport.send({ kind: "group", id: "20001" }, [{ type: "text", data: { text: "answer" } }], {
        prepare: () => [{ type: "reply", data: { id: "0" } }],
      }),
    ).rejects.toThrow("Invalid message");
    expect(calls.filter((call) => call.action.startsWith("send_"))).toHaveLength(0);
    const assertCurrent = () => {
      throw new SendCancelledError();
    };
    await expect(
      transport.poke({ kind: "group", id: "20001" }, "10002", { assertCurrent }),
    ).rejects.toBeInstanceOf(SendCancelledError);
    await expect(
      transport.reaction("-123", "128077", true, { assertCurrent }),
    ).rejects.toBeInstanceOf(SendCancelledError);
    expect(calls.some((call) => ["group_poke", "set_msg_emoji_like"].includes(call.action))).toBe(
      false,
    );
  });

  it("preserves signed history anchors and sends reply and @ independently", async () => {
    const { transport, calls } = await fixture();
    const history = await transport.history({ kind: "group", id: "20001" }, 20, -123456);
    expect(history[0].message_id).toBe(-123456);
    expect(calls.at(-1)?.params).toEqual({
      group_id: 20001,
      count: 20,
      message_id: -123456,
      reverse_order: true,
    });
    expect(
      await transport.send({ kind: "group", id: "20001" }, [
        { type: "reply", data: { id: "-123456" } },
        { type: "at", data: { qq: "10002" } },
        { type: "text", data: { text: "hello" } },
      ]),
    ).toEqual({ message_id: -234567 });
    expect(calls.at(-1)?.params.message).toEqual([
      { type: "reply", data: { id: "-123456" } },
      { type: "at", data: { qq: "10002" } },
      { type: "text", data: { text: "hello" } },
    ]);
    await transport.send({ kind: "group", id: "20001" }, [
      { type: "text", data: { text: "plain" } },
    ]);
    expect(calls.at(-1)?.params.message).toEqual([{ type: "text", data: { text: "plain" } }]);
  });
  it("keeps temporary private replies private with their source group", async () => {
    const { transport, calls } = await fixture();
    await transport.send({ kind: "private", id: "10002", groupId: "20001" }, [
      { type: "text", data: { text: "reply" } },
    ]);
    expect(calls.at(-1)?.action).toBe("send_private_msg");
    expect(calls.at(-1)?.params.group_id).toBe(20001);
    await expect(
      transport.send({ kind: "private", id: "10002" }, [{ type: "at", data: { qq: "10002" } }]),
    ).rejects.toThrow("do not support");
  });
  it("rejects cross-account events and unsubscribes handlers", async () => {
    const { transport, socket } = await fixture();
    const events: OneBotEvent[] = [];
    const off = transport.onEvent((event) => {
      events.push(event);
    });
    socket().send(JSON.stringify({ post_type: "message", self_id: 99999, user_id: 10002 }));
    socket().send(JSON.stringify({ post_type: "message", self_id: 10001, user_id: 10002 }));
    await expect.poll(() => events.length).toBe(1);
    expect(events[0].self_id).toBe(10001);
    off();
    socket().send(JSON.stringify({ post_type: "message", self_id: 10001 }));
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(events).toHaveLength(1);
  });
  it("stops on an unexpected login identity", async () => {
    const { url } = await fixture();
    const transport = new OneBotTransport({ url, expectedSelfId: "10003" });
    cleanup.push(() => transport.close());
    await expect(transport.connect()).rejects.toThrow("expectedSelfId");
    await expect(transport.login()).rejects.toThrow("not connected");
  });
  it("never replays a send whose connection closed before acknowledgement", async () => {
    const { transport, calls } = await fixture((call, socket) => {
      if (call.action === "send_group_msg") {
        socket.close();
        return true;
      }
      return false;
    });
    await expect(
      transport.send({ kind: "group", id: "20001" }, [{ type: "text", data: { text: "once" } }]),
    ).rejects.toThrow();
    await transport.connect();
    expect(calls.filter((call) => call.action === "send_group_msg")).toHaveLength(1);
  });
  it("redacts credentials from provider failure diagnostics", async () => {
    const { url } = await fixture((call, socket) => {
      if (call.action === "send_group_msg") {
        socket.send(
          JSON.stringify({
            status: "failed",
            retcode: 1200,
            wording: "secret-token-123 ws://host/?access_token=secret-token-123",
            data: null,
            echo: call.echo,
          }),
        );
        return true;
      }
      return false;
    });
    const transport = new OneBotTransport({ url, accessToken: "secret-token-123" });
    cleanup.push(() => transport.close());
    await transport.connect();
    let message = "";
    try {
      await transport.send({ kind: "group", id: "20001" }, [
        { type: "text", data: { text: "test" } },
      ]);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("[redacted]");
    expect(message).not.toContain("secret-token-123");
  });
  it("rejects media outside allowed roots, including symlink escapes", async () => {
    const { transport } = await fixture();
    const root = await mkdtemp(join(tmpdir(), "snowluma-media-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "outside.txt"), "private");
    const nested = await mkdtemp(join(root, "allowed-"));
    await symlink(join(root, "outside.txt"), join(nested, "escape.txt"));
    await expect(
      transport.uploadLocal(join(nested, "escape.txt"), { roots: [nested] }),
    ).rejects.toThrow("outside allowed");
    await expect(transport.uploadLocal(join(root, "outside.txt"))).rejects.toThrow(
      "outside allowed",
    );
  });
  it("uploads local media in acknowledged chunks before sending a server path", async () => {
    const content = Buffer.alloc(70_000, "x");
    let received = 0;
    const { transport, calls } = await fixture((call, socket) => {
      if (call.action !== "upload_file_stream") return false;
      const { stream_id } = call.params;
      const data = call.params.is_complete
        ? {
            type: "response",
            status: "file_complete",
            stream_id,
            received_chunks: received,
            total_chunks: 2,
            file_size: content.length,
            file_path: "/server/upload.jpg",
            file_name: "image.jpg",
            sha256: createHash("sha256").update(content).digest("hex"),
          }
        : {
            type: "stream",
            status: "chunk_received",
            stream_id,
            received_chunks: ++received,
            total_chunks: 2,
          };
      socket.send(
        JSON.stringify({
          status: "ok",
          retcode: 0,
          data,
          echo: call.echo,
          stream: "stream-action",
        }),
      );
      return true;
    });
    const root = await mkdtemp(join(tmpdir(), "snowluma-upload-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const file = join(root, "image.jpg");
    await writeFile(file, content);
    const serverPath = await transport.uploadLocal(file, { roots: [root] });
    expect(serverPath).toBe("/server/upload.jpg");
    await transport.send({ kind: "group", id: "20001" }, [
      { type: "image", data: { file: serverPath } },
    ]);
    const uploads = calls.filter((call) => call.action === "upload_file_stream");
    expect(uploads).toHaveLength(3);
    expect(uploads[0].params.chunk_index).toBe(0);
    expect(uploads[1].params.chunk_index).toBe(1);
    expect(uploads[2].params.is_complete).toBe(true);
    expect(calls.at(-1)?.params.message).toEqual([
      { type: "image", data: { file: "/server/upload.jpg" } },
    ]);
    await expect(transport.uploadLocal(file, { roots: [root], maxBytes: 10 })).rejects.toThrow(
      "exceeds upload limit",
    );
  });
  it("exposes only chat actions, validates identifiers, and supports poke/reactions", async () => {
    const { transport, calls } = await fixture();
    await transport.poke({ kind: "group", id: "20001" }, "10002");
    expect(calls.at(-1)?.action).toBe("group_poke");
    await transport.reaction("-123456", "128077", false);
    expect(calls.at(-1)?.params).toEqual({ message_id: -123456, emoji_id: "128077", set: false });
    await expect(transport.getMessage(0)).rejects.toThrow("Invalid message");
    await expect(
      transport.send({ kind: "group", id: "20001" }, [{ type: "json", data: { data: "{}" } }]),
    ).rejects.toThrow("Unsupported");
  });
  it("fetches merged-forward resources without confusing node IDs with native IDs", async () => {
    const { transport, calls } = await fixture();
    const result = await transport.getForward("forward-resource");
    expect(calls.at(-1)?.params).toEqual({ id: "forward-resource" });
    expect(result.messages[0].user_id).toBe(10002);
    expect(result.messages[0].message_id).toBe("forward-node-1");
    await expect(transport.getForward("")).rejects.toThrow("Invalid forward");
  });
  it("downloads received server media with framing validation and byte caps", async () => {
    const content = Buffer.from("inbound media");
    const { transport, calls } = await fixture((call, socket) => {
      if (call.action !== "download_file_record_stream") return false;
      const encoded = content.toString("base64");
      for (const data of [
        {
          type: "stream",
          data_type: "file_info",
          file_name: "voice.amr",
          file_size: content.length,
          chunk_size: 65536,
        },
        {
          type: "stream",
          data_type: "file_chunk",
          index: 0,
          data: encoded,
          size: content.length,
          base64_size: encoded.length,
          progress: 100,
        },
        {
          type: "response",
          data_type: "file_complete",
          file_name: "voice.amr",
          total_chunks: 1,
          total_bytes: content.length,
          message: "done",
        },
      ])
        socket.send(
          JSON.stringify({
            status: "ok",
            retcode: 0,
            stream: "stream-action",
            data,
            echo: call.echo,
          }),
        );
      return true;
    });
    const downloaded = await transport.downloadMedia("known-received-id", { kind: "record" });
    expect(downloaded).toEqual({ buffer: content, filename: "voice.amr" });
    expect(calls.at(-1)?.params).toEqual({ file: "known-received-id", chunk_size: 65536 });
    await expect(
      transport.downloadMedia("known-received-id", { kind: "record", maxBytes: 2 }),
    ).rejects.toThrow("exceeds byte limit");
  });
});
