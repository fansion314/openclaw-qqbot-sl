import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { snowlumaPlugin, registerConversationTools } from "./src/channel.js";
import { PLUGIN_ID } from "./src/config.js";
import { setRuntime } from "./src/runtime.js";
export default {
  id: PLUGIN_ID,
  name: "SnowLuma QQ",
  description: "Natural QQ conversations over SnowLuma OneBot v11",
  register(api: OpenClawPluginApi) {
    setRuntime(api.runtime);
    if (api.runtime.version !== "2026.11.2")
      api.logger.warn(
        `SnowLuma is tested with OpenClaw 2026.11.2; host reports ${api.runtime.version}`,
      );
    api.registerChannel({ plugin: snowlumaPlugin });
    registerConversationTools(api);
  },
};
export { snowlumaPlugin, registerConversationTools };
