/** Real host discovery/load smoke; isolated state, no gateway or QQ account. */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const state = await mkdtemp(join(tmpdir(), "snowluma-openclaw-smoke-"));
try {
  const configPath = join(state, "openclaw.json");
  await writeFile(
    configPath,
    JSON.stringify({
      agents: { entries: { rion: { workspace: join(state, "rion-workspace") } } },
      bindings: [{ agentId: "rion", match: { channel: "qq-snowluma" } }],
      plugins: {
        allow: ["world.fansionia.openclaw-qqbot-snowluma"],
        load: { paths: [root] },
        entries: { "world.fansionia.openclaw-qqbot-snowluma": { enabled: true } },
      },
      channels: {
        "qq-snowluma": {
          enabled: true,
          wsUrl: "ws://127.0.0.1:1/",
          groups: { 20001: { mode: "autonomous" } },
        },
      },
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/openclaw/openclaw.mjs"),
      "plugins",
      "inspect",
      "world.fansionia.openclaw-qqbot-snowluma",
      "--runtime",
      "--json",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_SKIP_CHANNELS: "1",
      },
      encoding: "utf8",
      timeout: 90000,
    },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`OpenClaw smoke exited ${result.status}`);
  const report = JSON.parse(result.stdout);
  if (
    report.plugin?.id !== "world.fansionia.openclaw-qqbot-snowluma" ||
    !report.plugin?.imported ||
    report.plugin?.status !== "loaded"
  )
    throw new Error("Host did not load plugin runtime");
  if (report.diagnostics?.length) throw new Error("Host emitted plugin diagnostics");
  if (report.workspaceDir !== join(state, "rion-workspace"))
    throw new Error("Host did not select rion workspace");
  if (!report.plugin.toolNames?.includes("snowluma_context"))
    throw new Error("Conversation tool not registered");
} finally {
  await rm(state, { recursive: true, force: true });
}
