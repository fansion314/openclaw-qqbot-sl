# SnowLuma QQ for OpenClaw

通过 SnowLuma OneBot v11 将 QQ 群聊、私聊接入 OpenClaw。群聊可以自主参与，也可以只在被 @ 后处理积累消息。agent 通过结构化输出选择沉默、引用、@、逐条发送、拍一拍和表情回应。

插件：`world.fansionia.openclaw-qqbot-snowluma`；通道：`qq-snowluma`。

插件固定只连接独立 agent **rion**。必须配置 `agents.entries.rion`，并将 `qq-snowluma` 绑定到 rion；缺失或回退到 main 时会拒绝调用。出站同样要求 rion 会话来源，main 和无来源的 CLI 发送被拒绝。人格模板见 `examples/rion/`，实际工作区独立于 main。

## 安装

兼容基线为 OpenClaw **2026.11.2**、SnowLuma 服务端 **2.3.4**；插件运行需要 Node.js **26.12.1+**。SnowLuma SDK 2.4.2 仅调用服务端 2.3.4 已存在的聊天接口。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm pack
# 在运行 OpenClaw 的主机安装生成的包：
openclaw plugins install ./fansionia-openclaw-qqbot-snowluma-0.1.4.tgz
```

本地开发可在构建后使用 `openclaw plugins install --link .`。安装包包含已编译 JavaScript，不依赖主机即时编译 TypeScript。

## 配置

将 [examples/openclaw.json](examples/openclaw.json) 合并到现有 OpenClaw 配置。示例中的 QQ/群号是占位值，需要替换；令牌通过环境变量提供。插件默认只允许 `groups`、`privateChats` 中明确配置的会话，空配置不会调用 agent。`"*": {}` 显式允许全部会话，不建议误复制。

SnowLuma 启用 **WS 服务端**，消息格式选数组。插件连接该端点，同一连接接收事件并调用 API。它不连接 AstrBot 的反向 WS 接收端口。令牌应与所选 SnowLuma WS 服务端一致。可以同时保留 AstrBot 连接。

Docker 内监听地址和主机可访问地址可能不同：OpenClaw 在主机上运行时，WS 端口需要发布到主机或通过已授权的隧道访问。推荐仅绑定回环地址；跨主机可用 SSH 端口转发或 WSS。不要将 Docker 内部服务名直接当作主机 DNS 名称。

群聊默认自主模式，空队列的首条消息先等待10秒，连续消息可延长等待，但最晚在首条后30秒递交；其后最短30秒递交一次。间隔内消息在固定截止时间合并，不因持续来消息而无限推迟。真正 @ 机器人会跳过等待；运行中则等本轮结束立即处理。`mode: "mention"` 平时积累，@ 后才递交。私聊默认即时触发。

一轮默认最多100条，超限优先保留待处理@及最新消息，并向模型说明截断数量。SQLite 缓存默认500条/会话、7天；不是 QQ 无限历史备份。历史补取可能受 SnowLuma 锚点及 QQ 服务端限制。

自主模式群聊默认安静1小时后给 agent 一次开场机会。无论发言或沉默，本轮不再反复开场，直到真人新消息重置。可用 `activeHours` 和 `timeZone` 限定时段。私聊、mention模式群默认不开启。

工具权限沿用 OpenClaw。请使用现有 agent 绑定和工具策略管理宿主机能力；此插件不会将历史正文作为独立的管理命令。不同QQ会话默认独立路由。

## 配置项

根配置是账号默认值，`accounts.<id>` 覆盖默认值，`groups.<群号>` / `privateChats.<QQ号>` 覆盖会话行为。

| 字段                                                 | 默认 / 说明                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| `wsUrl`                                              | `ws://127.0.0.1:3001/`                                       |
| `accessToken` / `accessTokenFile` / `accessTokenEnv` | 按此优先级取令牌；不要把真实令牌提交到仓库                   |
| `selfId`                                             | 可选；连接后校验账号是否匹配                                 |
| `requestTimeoutMs`                                   | 30000；断线发送不自动重放                                    |
| `reconnect`                                          | true                                                         |
| `mode`                                               | `autonomous` 或 `mention`                                    |
| `batchIntervalMs`                                    | 群30000、私聊0                                               |
| `maxMessages`                                        | 每批100                                                      |
| `cacheLimit` / `retentionDays`                       | 500 / 7                                                      |
| `statePath`                                          | 可覆盖 SQLite 路径；多账号使用独立文件                       |
| `idleEnabled` / `idleAfterMs`                        | 自主群 true / 3600000                                        |
| `activeHours`                                        | `{ "start": "09:00", "end": "23:00" }`，可跨午夜，省略为全天 |
| `timeZone`                                           | `Asia/Shanghai`                                              |
| `style`                                              | 追加聊天风格提示，不覆盖宿主人格                             |
| `repairFormat`                                       | true；未产生可见操作时最多纠正一次                           |
| `maxOutputMessages` / `maxOutputChars`               | 输出操作数及每条长度限制                                     |
| `mediaMaxBytes` / `mediaRoots`                       | 媒体大小限制、允许读取的本地目录                             |

## 协议与行为

参见 [结构化协议](docs/protocol.md)、[聊天风格](docs/chat-style.md) 和 [验证及部署](docs/validation.md)。完整 `<msg>` 生成后进入账号发送队列；首条立即发送，后续按字数停顿1—10秒。原生发送工具已发送的内容不再次输出。发送回执证明 OneBot 接受请求，不代表接收方设备已展示或已读。

媒体识别使用 OpenClaw 已配置的模型和媒体理解能力。没有相应能力时保留类型占位。插件主机文件会先上传到 SnowLuma，再发送服务端资源，适用于两端不共享文件系统的部署。

## 开发

```sh
pnpm typecheck
pnpm test
pnpm build
```

测试使用内存/临时 SQLite、真实本地 WebSocket 测试服务器及注入的宿主运行时，不连接真实QQ账号。兼容验证同时覆盖 macOS 与原生 Linux x86_64。

## 输入上下文（0.1.1）

用户定义按实际OpenClaw sessionId持久化，同一session只在首次出现或昵称/群名片变化时补充。只有宿主确认运行接纳后才记录；新session和会话重置会重新提供。自身消息通过发送者QQ号或message_sent识别，仅缓存用于引用、去重和计时，不重复递交给agent。

WebUI以XML代码块保留换行，每条msg的标签和正文分行。`history`包含补取历史，以及@触发时积累的普通消息；`current`包含本次触发的新消息，@触发时明确列出被@消息。主动开场只有history，没有伪造的人类新消息。

## 节奏与短图链（0.1.2）

自主群聊在空队列且已过30秒递交间隔时，首条先等10秒；新消息重新等待10秒，最多首条后30秒递交。原有冷却内固定批次不延长；@仍立即递交，私聊仍即时。配置 `initialBatchWaitMs`（默认10000）、`initialBatchMaxWaitMs`（默认30000）；等待窗口持久化，重启不重置封顶时间。

每个账号独立串行发送，第一条立即发送；后续文字/图片/文件共享队列，停顿从上条完成时起算，按待发送文字Unicode字数计算：`1000 + 9000 * log(1+n)/log(101)` 毫秒，上限10000。纯媒体最低1000毫秒。可配置 `sendMinDelayMs`、`sendMaxDelayMs`、`sendSaturationChars`（默认100）。取消或停机丢弃尚未发出的排队操作，不自行重试发送。

空history/current分区省略，批次尾部只保留“仅必要时简短回复。”。系统提示强调默认一条、5—20字，确有必要才追加，不将长段复述当日常聊天。

图片属性提供28字符的 `qqimg:` 短引用，原始带签名URL保存在插件SQLite映射，不进入消息正文。旧HTTP短链服务只监听回环地址，随机128位标识、7天有效期、最多10000条。`view_image(path/paths)` 调用前只还原当前rion会话对应的图片参数，之后仍经过宿主网络检查；不放宽全局SSRF策略。引用和转发中的图片也缩短；资源ref仍可用于原样重发。

## 持久用户名字

模型可询问未命名用户想叫什么，再用 `<user-name user_id="当前标识" name="小明"/>` 或 `snowluma_context(operation="set_name")` 设定。后续 `user_id="小明"` 与 `at="小明"` 直接引用同一真实QQ；原短ID和旧名仍可解析，旧名不能转让给另一个QQ。命名按账号持久化，重名按Unicode规范化检查；支持修改名字。`operation="users"`列出当前会话用户标识。命名是内部操作，不会向QQ发消息。

## 多模态与self（0.1.3）

机器人在输入头、@、引用和通知内统一表示为self，内部仍绑定当前QQ账号。图片正文只包含ref、必要元数据和28字符的qqimg:引用，不再展示原始file标识；旧HTTP短链继续支持。当前OpenClaw图片工具是view_image(path/paths)，插件会按当前rion会话还原短引用再经过宿主网络检查。

当前触发消息中的图片会经受限下载保存到OpenClaw媒体目录，再以真实附件path提供给多模态模型，默认最多4张、每张10MiB、每轮总20MiB。历史图片保留短引用按需读取。下载失败不会中断文字对话；不会声称未成功下载的图片已经被识别。

## 原生 /new 命令

实时消息中的独立 `/new`（可带一次真实@机器人）在XML包装前识别，并通过OpenClaw原生命令流程重置当前群会话。历史、引用、代码或普通正文中的/new不触发。群白名单不授予命令权限；需在现有 `commands.allowFrom` 中追加 `"qq-snowluma": ["你的QQ号"]`，或使用宿主已有的所有者授权。不要覆盖其他通道的命令权限。

重置会保留旧记录、开始新的上下文；同批次中/new之后的新消息留给fresh会话。用户定义按实际会话生命周期重新提供，不因宿主复用sessionId而丢失。私有部署命令白名单不会包含在仓库示例。
