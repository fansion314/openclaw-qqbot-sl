import { parseSegments } from "@snowluma/sdk";
import type { OneBotEvent, OneBotTransport } from "./onebot.js";
import { escapeXml } from "./protocol.js";

export interface InboundMedia {
  kind: string;
  url?: string;
  messageId: string;
  ref: string;
  file?: string;
  name?: string;
  data?: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function short(value: unknown): string {
  const id = text(value);
  return /^\d+$/.test(id) && BigInt(id) > 0n ? `u${BigInt(id).toString(36)}` : "unknown";
}
function attrs(values: Record<string, unknown>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([name, value]) => ` ${name}="${escapeXml(text(value).slice(0, 4096))}"`)
    .join("");
}
function iso(value: unknown): string {
  const time = Number(value) * 1000;
  return Number.isFinite(time) && time > 0 && time < 8_640_000_000_000_000
    ? new Date(time).toISOString()
    : "";
}

/** Translate native message segments into data-only XML; never interpret XML supplied in chat text. */
export async function formatInboundMessage(
  event: OneBotEvent,
  transport: Pick<OneBotTransport, "getMessage" | "getForward">,
  options: {
    maxForwardDepth?: number;
    maxForwardNodes?: number;
    maxBytes?: number;
    maxSegments?: number;
    maxLookups?: number;
    refRootId?: string;
  } = {},
): Promise<{ body: string; media: InboundMedia[] }> {
  const maxDepth = Math.max(0, Math.min(10, options.maxForwardDepth ?? 3));
  const maxNodes = Math.max(1, Math.min(1000, options.maxForwardNodes ?? 100));
  const maxBytes = Math.max(1024, Math.min(1_000_000, options.maxBytes ?? 32_768));
  const maxSegments = Math.max(1, Math.min(10_000, options.maxSegments ?? 500));
  const maxLookups = Math.max(0, Math.min(100, options.maxLookups ?? 20));
  let bytes = 0;
  let nodes = 0;
  let segments = 0;
  let lookups = 0;
  let exhausted = false;
  const output: string[] = [];
  const media: InboundMedia[] = [];
  const forwardCache = new Map<string, ReturnType<OneBotTransport["getForward"]>>();
  const replyCache = new Map<string, Promise<OneBotEvent>>();
  const rootId = options.refRootId ?? (text(event.message_id) || "unknown");
  function append(value: string): boolean {
    if (exhausted) return false;
    const size = Buffer.byteLength(value);
    if (bytes + size > maxBytes - 512) {
      exhausted = true;
      output.push('<truncated reason="byte-limit"></truncated>');
      return false;
    }
    bytes += size;
    output.push(value);
    return true;
  }
  function close(tag: string): void {
    output.push(`</${tag}>`);
  }
  function unavailable(kind: string, reason: string): void {
    append(`<unavailable${attrs({ kind, reason })}></unavailable>`);
  }
  function sameConversation(target: OneBotEvent): boolean {
    if (event.message_type === "group")
      return target.message_type === "group" && Number(target.group_id) === Number(event.group_id);
    if (target.message_type !== "private") return false;
    const peer = Number(event.user_id === event.self_id ? event.target_id : event.user_id);
    return (
      peer > 0 &&
      (Number(target.user_id) === peer ||
        (Number(target.user_id) === Number(event.self_id) && Number(target.target_id) === peer))
    );
  }

  async function renderMessage(
    value: unknown,
    path: string,
    depth: number,
    ancestry: ReadonlySet<string>,
    quoteDepth = 0,
  ): Promise<void> {
    if (exhausted) return;
    let input: unknown[];
    if (typeof value === "string") {
      if (Buffer.byteLength(value) > maxBytes) {
        unavailable("message", "text-byte-limit");
        return;
      }
      input = parseSegments(value);
    } else if (Array.isArray(value)) input = value;
    else if (record(value).type) input = [value];
    else {
      unavailable("message", "invalid-content");
      return;
    }
    for (let i = 0; i < input.length && !exhausted; i++) {
      if (++segments > maxSegments) {
        unavailable("message", "segment-limit");
        return;
      }
      const segment = record(input[i]);
      const data = record(segment.data);
      const type = text(segment.type);
      const ref = `${rootId}:${path}${i}`;
      if (type === "text") {
        append(escapeXml(text(data.text)));
        continue;
      }
      if (type === "at") {
        append(
          `<at${attrs({ user_id: data.qq === "all" ? "all" : short(data.qq), nickname: data.name })}></at>`,
        );
        continue;
      }
      if (type === "face") {
        append(`<face${attrs({ id: data.id })}></face>`);
        continue;
      }
      if (["image", "record", "video", "file"].includes(type)) {
        const item: InboundMedia = {
          kind: type,
          messageId: rootId,
          ref,
          url: text(data.url) || undefined,
          file: text(data.file ?? data.file_id) || undefined,
          name: text(data.name ?? data.file_name) || undefined,
          data,
        };
        if (
          append(
            `<${type}${attrs({ ref, url: item.url, file: type === "image" ? undefined : item.file, name: item.name, summary: data.summary, emoji_id: data.emoji_id })}></${type}>`,
          )
        )
          media.push(item);
        continue;
      }
      if (type === "reply") {
        const id = text(data.id);
        if (quoteDepth >= 1) {
          append(`<reply${attrs({ msg_id: id, unavailable: "nested-quote" })}></reply>`);
          continue;
        }
        let target: OneBotEvent | undefined;
        let error: string | undefined;
        if (data.message !== undefined)
          target = {
            user_id: Number(data.qq) || undefined,
            time: Number(data.time) || undefined,
            message: data.message as OneBotEvent["message"],
          };
        else if (/^-?[1-9]\d*$/.test(id)) {
          try {
            let pending = replyCache.get(id);
            if (!pending) {
              if (lookups++ >= maxLookups) throw new Error("lookup limit");
              pending = transport.getMessage(id);
              replyCache.set(id, pending);
            }
            const fetched = await pending;
            if (sameConversation(fetched)) target = fetched;
            else error = "outside-conversation";
          } catch {
            error = "lookup-failed";
          }
        } else error = "missing-reference";
        if (
          append(
            `<reply${attrs({
              msg_id: id,
              user_id: target ? short(target.user_id ?? target.sender?.user_id) : undefined,
              nickname: target?.sender?.nickname,
              groupcard: target?.sender?.card,
              time: iso(target?.time),
              unavailable: error,
            })}>`,
          )
        ) {
          if (target)
            await renderMessage(
              target.message ?? target.raw_message ?? "",
              `${path}${i}:reply:`,
              depth,
              ancestry,
              quoteDepth + 1,
            );
          close("reply");
        }
        continue;
      }
      if (type === "forward" || type === "node") {
        const id = text(data.id ?? data.res_id ?? data.forward_id);
        if (depth >= maxDepth) {
          unavailable("forward", "depth-limit");
          continue;
        }
        if (nodes >= maxNodes) {
          unavailable("forward", "node-limit");
          continue;
        }
        if (id && ancestry.has(id)) {
          unavailable("forward", "cycle");
          continue;
        }
        if (!append(`<forward${attrs({ id: id || undefined })}>`)) continue;
        const next = new Set(ancestry);
        if (id) next.add(id);
        let children: unknown[];
        if (type === "node") children = [data];
        else {
          try {
            let pending = forwardCache.get(id);
            if (!id) throw new Error("missing id");
            if (!pending) {
              if (lookups++ >= maxLookups) throw new Error("lookup limit");
              pending = transport.getForward(id);
              forwardCache.set(id, pending);
            }
            const result = await pending;
            if (!Array.isArray(result.messages)) throw new Error("invalid forward result");
            children = result.messages;
          } catch {
            unavailable("forward", "lookup-failed");
            close("forward");
            continue;
          }
        }
        for (let j = 0; j < children.length && !exhausted; j++) {
          if (++nodes > maxNodes) {
            unavailable("forward", "node-limit");
            break;
          }
          const child = record(children[j]);
          const sender = record(child.sender);
          // Forward node IDs are not locally resolvable OneBot message IDs.
          if (
            append(
              `<forward-msg${attrs({
                node_id: child.message_id ?? child.id,
                user_id: short(child.user_id ?? sender.user_id),
                nickname: sender.nickname ?? child.nickname,
                groupcard: sender.card,
                time: iso(child.time),
              })}>`,
            )
          ) {
            await renderMessage(
              child.message ?? child.content ?? child.raw_message ?? "",
              `${path}${i}:forward:${j}:`,
              depth + 1,
              next,
              quoteDepth,
            );
            close("forward-msg");
          }
        }
        close("forward");
        continue;
      }
      // Cards and unknown native segments remain visible as inert data.
      append(
        `<segment${attrs({ type: type || "unknown" })}>${escapeXml(JSON.stringify(data).slice(0, 4096))}</segment>`,
      );
    }
  }

  await renderMessage(event.message ?? event.raw_message ?? "", "", 0, new Set());
  return { body: output.join(""), media };
}
