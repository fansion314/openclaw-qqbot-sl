import { parseSegments } from "@snowluma/sdk";
import { resolveCommandAuthorizationAsync } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { OneBotEvent } from "./onebot.js";
import type { StoredEvent } from "./store.js";
import { CHANNEL_ID } from "./config.js";

export type LiveCommandEvent = StoredEvent & { liveCommand?: "/new" };

/** Called only on authenticated live events, never on history or hydrated quotes. */
export function detectNewCommand(event: OneBotEvent, selfId: string): "/new" | undefined {
  if (event.post_type !== "message" || String(event.user_id) === selfId) return;
  const parts = Array.isArray(event.message)
    ? event.message
    : parseSegments(String(event.message ?? event.raw_message ?? ""));
  let text = "";
  let mentions = 0;
  for (const part of parts) {
    if (part.type === "text") text += String(part.data.text ?? "");
    else if (part.type === "at" && String(part.data.qq) === selfId && ++mentions <= 1) text += " ";
    else return;
  }
  return text.trim() === "/new" ? "/new" : undefined;
}

/** A channel allowlist admits chat, not control commands. SDK owner and command policies decide. */
export async function authorizeNewCommand(
  cfg: OpenClawConfig,
  accountId: string,
  event: StoredEvent,
  to: string,
) {
  const ctx = {
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    AccountId: accountId,
    SenderId: event.userId,
    From: to,
    To: to,
    ChatType: event.kind === "group" ? "group" : "direct",
    RawBody: "/new",
    CommandBody: "/new",
    CommandSource: "text" as const,
  };
  const authorization = await resolveCommandAuthorizationAsync({
    cfg,
    ctx,
    commandAuthorized: false,
  });
  if (cfg.commands?.text === false) return { ...authorization, isAuthorizedSender: false };
  if (authorization.isAuthorizedSender || !authorization.senderIsOwner) return authorization;
  return resolveCommandAuthorizationAsync({ cfg, ctx, commandAuthorized: true });
}

export function liveNewCommand(events: StoredEvent[]): LiveCommandEvent | undefined {
  return (events as LiveCommandEvent[]).findLast(
    (event) => event.liveCommand === "/new" && !event.self && event.trigger !== false,
  );
}
