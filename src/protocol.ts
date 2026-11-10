/** Model output is data: only complete, validated blocks may cause effects. */
export type ReplyPart =
  | { type: "text"; text: string }
  | { type: "face"; id: string }
  | { type: "image" | "record" | "video" | "file"; ref?: string; src?: string; name?: string };
export type ReplyAction =
  | { type: "message"; replyTo?: string; at?: string; parts: ReplyPart[] }
  | { type: "poke"; userId: string }
  | { type: "reaction"; messageId: string; emojiId: string; set: boolean }
  | { type: "user-name"; userId: string; name: string }
  | { type: "no-reply" };
export class ProtocolError extends Error {
  override name = "ProtocolError";
}
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
function decode(value: string): string {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(value))
    throw new ProtocolError("Invalid XML entity");
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (_, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (named[entity]) return named[entity];
    const point = entity.startsWith("#x")
      ? Number.parseInt(entity.slice(2), 16)
      : Number(entity.slice(1));
    if (
      !Number.isInteger(point) ||
      point <= 0 ||
      point > 0x10ffff ||
      (point >= 0xd800 && point <= 0xdfff)
    )
      throw new ProtocolError("Invalid XML codepoint");
    return String.fromCodePoint(point);
  });
}
function attrs(source: string, allowed: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  let rest = source;
  while (rest.trim()) {
    const match = /^\s+([a-z_]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);
    if (!match || !allowed.includes(match[1]) || Object.hasOwn(result, match[1]))
      throw new ProtocolError("Invalid or duplicate attribute");
    const value = match[2] ?? match[3];
    if (value.includes("<")) throw new ProtocolError("Unescaped attribute");
    result[match[1]] = decode(value);
    rest = rest.slice(match[0].length);
  }
  return result;
}
function messageId(value: string): string {
  if (
    !/^-?\d+$/.test(value) ||
    !Number.isInteger(Number(value)) ||
    Number(value) === 0 ||
    Number(value) < -2147483648 ||
    Number(value) > 2147483647
  )
    throw new ProtocolError("Invalid signed message ID");
  return String(Number(value));
}
function userId(value: string): string {
  if (!value || value !== value.trim() || [...value].length > 32 || /[\p{Cc}\p{Cf}]/u.test(value))
    throw new ProtocolError(
      "Use a supplied user label of 1–32 characters without controls or surrounding whitespace",
    );
  const normalized = value.normalize("NFKC").toLowerCase();
  if (
    !normalized ||
    normalized !== normalized.trim() ||
    [...normalized].length > 32 ||
    /[\p{Cc}\p{Cf}]/u.test(normalized) ||
    ["all", "bot"].includes(normalized)
  )
    throw new ProtocolError("Invalid or reserved user label");
  return value;
}
function userName(value: string): string {
  const name = userId(value);
  if (
    /^u[0-9a-z]+$/i.test(name.normalize("NFKC")) ||
    name.normalize("NFKC").toLowerCase() === "self"
  )
    throw new ProtocolError("User name is reserved");
  return name;
}
function parts(body: string): ReplyPart[] {
  const result: ReplyPart[] = [];
  let rest = body;
  while (rest) {
    const index = rest.indexOf("<");
    if (index !== 0) {
      const end = index < 0 ? rest.length : index;
      result.push({ type: "text", text: decode(rest.slice(0, end)) });
      rest = rest.slice(end);
      continue;
    }
    // A literal comparison or kaomoji '<' does not introduce an XML tag.
    // Keep actual markup strict so an unknown script/card cannot become text.
    if (!/^[A-Za-z/!?]/.test(rest.slice(1))) {
      result.push({ type: "text", text: "<" });
      rest = rest.slice(1);
      continue;
    }
    const tag = /^<(image|record|audio|video|file|face)((?:[^>"']|"[^"]*"|'[^']*')*)\/>/.exec(rest);
    if (!tag) throw new ProtocolError("Only self-closing media/face tags are allowed inside msg");
    const type = tag[1] === "audio" ? "record" : tag[1];
    const a = attrs(tag[2], type === "face" ? ["id"] : ["ref", "src", "name"]);
    if (type === "face") {
      if (!/^\d+$/.test(a.id ?? "")) throw new ProtocolError("Invalid face ID");
      result.push({ type, id: a.id });
    } else {
      if (Boolean(a.ref) === Boolean(a.src))
        throw new ProtocolError("Media requires exactly one ref or src");
      result.push({ type: type as "image" | "record" | "video" | "file", ...a });
    }
    rest = rest.slice(tag[0].length);
  }
  if (!result.some((p) => p.type !== "text" || p.text.trim()))
    throw new ProtocolError("Empty message");
  return result;
}

export class StructuredReplyStream {
  private text = "";
  private consumed = 0;
  private assistantIndex = 0;
  private blockIndex = 0;
  private count = 0;
  private actionCount = 0;
  private noReply = false;
  private failure: unknown;
  private tail: Promise<void> = Promise.resolve();
  constructor(
    private readonly onAction: (
      action: ReplyAction,
      identity: { assistantIndex: number; blockIndex: number },
    ) => Promise<void>,
    private readonly options: { maxActions?: number; maxMessageChars?: number } = {},
  ) {}
  get visibleActions(): number {
    return this.count;
  }
  get silent(): boolean {
    return this.noReply;
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      await work();
    });
    this.tail = next.catch((error) => {
      this.failure = error;
    });
    return next;
  }
  update(payload: { text?: string; delta?: string; replace?: boolean }): Promise<void> {
    return this.enqueue(async () => {
      const next =
        payload.text !== undefined
          ? payload.text
          : payload.replace
            ? (payload.delta ?? "")
            : this.text + (payload.delta ?? "");
      if (!next.startsWith(this.text.slice(0, this.consumed)))
        throw new ProtocolError("Replacement changed an already accepted block");
      if (next.length > 262144) throw new ProtocolError("Output buffer limit exceeded");
      this.text = next;
      await this.parse();
    });
  }
  startAssistant(): Promise<void> {
    return this.enqueue(async () => {
      this.validateEnd();
      this.text = "";
      this.consumed = 0;
      this.assistantIndex++;
      this.blockIndex = 0;
    });
  }
  async finish(text?: string): Promise<void> {
    if (text !== undefined) await this.update({ text });
    await this.enqueue(async () => this.validateEnd());
  }
  private validateEnd(): void {
    const pending = this.text.slice(this.consumed).trim();
    if (pending === "NO_REPLY" && this.count === 0) {
      this.noReply = true;
      this.consumed = this.text.length;
      return;
    }
    if (pending) throw new ProtocolError("Incomplete or unstructured model output");
  }
  private async emit(action: ReplyAction): Promise<void> {
    if (action.type === "no-reply") {
      if (this.count || this.noReply)
        throw new ProtocolError("no-reply must be an exclusive result");
      this.noReply = true;
    } else {
      if (this.noReply) throw new ProtocolError("Message after no-reply");
      if (this.actionCount >= (this.options.maxActions ?? 12))
        throw new ProtocolError("Action limit exceeded");
      this.actionCount++;
      if (action.type !== "user-name") this.count++;
    }
    await this.onAction(action, {
      assistantIndex: this.assistantIndex,
      blockIndex: this.blockIndex++,
    });
  }
  private async parse(): Promise<void> {
    while (true) {
      const remaining = this.text.slice(this.consumed);
      const whitespace = /^\s*/.exec(remaining)![0].length;
      this.consumed += whitespace;
      const rest = remaining.slice(whitespace);
      if (!rest || rest === "NO_REPLY") return;
      if (!rest.startsWith("<")) throw new ProtocolError("Text outside structured blocks");
      const open = /^<([a-z-]+)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(rest);
      if (!open) {
        if (rest.includes(">") || rest.length > 8192)
          throw new ProtocolError("Invalid opening tag");
        return;
      }
      const name = open[1];
      const selfClosing = open[2].endsWith("/");
      const rawAttrs = selfClosing ? open[2].slice(0, -1) : open[2];
      if (name === "msg" && !selfClosing) {
        const end = rest.indexOf("</msg>", open[0].length);
        if (end < 0) return;
        const a = attrs(rawAttrs, ["reply_to", "at"]);
        const body = rest.slice(open[0].length, end);
        if (body.length > (this.options.maxMessageChars ?? 5000))
          throw new ProtocolError("Message length limit exceeded");
        const action: ReplyAction = {
          type: "message",
          parts: parts(body),
          ...(a.reply_to !== undefined ? { replyTo: messageId(a.reply_to) } : {}),
          ...(a.at !== undefined ? { at: userId(a.at) } : {}),
        };
        this.consumed += end + 6;
        await this.emit(action);
      } else if (name === "no-reply") {
        attrs(rawAttrs, []);
        const close = "</no-reply>";
        if (!selfClosing && rest.length < open[0].length + close.length) return;
        if (!selfClosing && !rest.slice(open[0].length).startsWith(close))
          throw new ProtocolError("no-reply must be empty");
        this.consumed += open[0].length + (selfClosing ? 0 : close.length);
        await this.emit({ type: "no-reply" });
      } else if (name === "user-name" && selfClosing) {
        const a = attrs(rawAttrs, ["user_id", "name"]);
        const action: ReplyAction = {
          type: "user-name",
          userId: userId(a.user_id ?? ""),
          name: userName(a.name ?? ""),
        };
        this.consumed += open[0].length;
        await this.emit(action);
      } else if ((name === "poke" || name === "reaction") && selfClosing) {
        const a = attrs(rawAttrs, name === "poke" ? ["user_id"] : ["msg_id", "emoji_id", "set"]);
        let action: ReplyAction;
        if (name === "poke") action = { type: "poke", userId: userId(a.user_id ?? "") };
        else {
          if (
            !/^\d+$/.test(a.emoji_id ?? "") ||
            (a.set !== undefined && !["true", "false"].includes(a.set))
          )
            throw new ProtocolError("Invalid reaction");
          action = {
            type: "reaction",
            messageId: messageId(a.msg_id ?? ""),
            emojiId: a.emoji_id,
            set: a.set !== "false",
          };
        }
        this.consumed += open[0].length;
        await this.emit(action);
      } else throw new ProtocolError("Unknown output block");
    }
  }
}
