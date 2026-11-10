import {
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
  type ChannelIngressContextBinding,
} from "openclaw/plugin-sdk/channel-ingress-runtime";

/** The authenticated OneBot connection owns sender IDs; message text never grants command authority. */
export function resolveIngress(
  accountId: string,
  conversation: { kind: "group" | "direct"; id: string },
  senderId: string,
  contextBinding: ChannelIngressContextBinding,
) {
  return createChannelIngressResolver({
    channelId: "qq-snowluma",
    accountId,
    identity: defineStableChannelIngressIdentity({
      key: "qq",
      kind: "stable-id",
      authentication: "asserted",
      normalize: (value) => (/^[1-9]\d*$/.test(value) ? value : null),
    }),
    defaultDmPolicy: "allowlist",
    defaultGroupPolicy: "open",
    useDefaultPairingStore: false,
  }).message({
    subject: { stableId: senderId },
    conversation,
    contextBinding,
    allowFrom: [senderId],
    command: false,
    route: { id: conversation.id, kind: "route", configured: true, matched: true, allowed: true },
  });
}
