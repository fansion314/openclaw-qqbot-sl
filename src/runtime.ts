import type { PluginRuntime } from "openclaw/plugin-sdk/core";
let runtime: PluginRuntime | undefined;
export function setRuntime(value: PluginRuntime): void {
  runtime = value;
}
export function getRuntime(): PluginRuntime {
  if (!runtime) throw new Error("SnowLuma plugin runtime is not registered");
  return runtime;
}
