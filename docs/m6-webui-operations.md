# M6 WebUI 本地/LAN 运行说明

当前 WebUI 是单一登录用户模式：登录页是唯一免认证入口，登录后才能使用工作区、翻译、知识库、Provider 配置、备份和恢复。产品不区分普通用户和管理员角色。

## 启动

先为控制面准备一个只允许 uid `65532` 读写的宿主机数据目录；不要把 Provider key 写入镜像或提交到仓库。

```sh
mkdir -p data
chown 65532:65532 data
export LECTORIA_AUTH_TOKEN='generate-a-long-random-value'
export LECTORIA_ADMIN_PASSWORD='use-a-separate-password'
docker compose -f docker-compose.m6.yml up --build -d
```

控制面默认监听 `8787`，WebUI 静态服务默认监听 `4176`。Compose 对捆绑 WebUI 提供安全的本地默认来源 `http://127.0.0.1:4176`；如果修改 WebUI 端口、通过局域网地址访问，或使用反向代理，必须显式把 `LECTORIA_ALLOWED_ORIGINS` 配置为实际来源（逗号分隔），不能留空，也不能配置为任意来源。实际 LAN 暴露前，应在反向代理处终止 TLS，并把 `LECTORIA_COOKIE_SECURE=true` 配置为真实 HTTPS 部署；也可以为控制面直接配置证书和密钥环境变量。

例如：

```sh
export LECTORIA_ALLOWED_ORIGINS='http://192.168.1.20:4176'
```

## Provider 配置

登录后在“LLM / 工具来源配置”中添加来源。浏览器只提交一次凭据，服务端把它写入数据根目录下的私有文件；列表接口只返回来源、模型、能力和 `credentialConfigured`，不会回显 Secret。StagePreset 在服务端解析并绑定到 attempt 配置快照，浏览器不能伪造 Provider、模型或工具组合。

默认 `LECTORIA_TRANSLATION_MODE=fake` 适合离线验收。启用真实模式前，应确认预算、模型兼容性和凭据已配置：

```sh
export LECTORIA_TRANSLATION_MODE=real
docker compose -f docker-compose.m6.yml up -d lectoria-http
```

## 备份与恢复

登录 WebUI 的“备份与恢复”卡片即可创建和查看备份。备份由服务端生成，包含 SQLite、已提交对象和可携带知识事实；manifest、数据库完整性、对象 digest 和事实 digest 全部校验通过后才允许恢复。恢复始终创建新工作区，不覆盖已有工作区，也不接受任意文件路径。

登录后的“知识提案”卡片用于审核受控研究产生的待审事实。页面只展示提案的来源类型、操作、版本和脱敏内容摘要；批准和应用是两个独立动作，只有用户明确批准后才会写入本地知识库并重建 FTS 派生索引。提案的证据快照、冲突状态和应用结果由服务端校验，WebUI 不直接修改知识事实表。

升级前应先创建备份，升级后检查 `/healthz`、登录、工作区列表和 queued/running 状态，再继续任务。当前版本已在固定 Docker 环境完成 schema v31 → v32 的升级前检查、active task 状态恢复和 queued 任务续作；生产切换仍应按下方清单执行，不要跳过备份。

升级前可在“备份与恢复”卡片点击“升级前检查”，或调用登录后的 `GET /api/v1/upgrade/preflight?workspaceId=<id>`。检查会验证数据库完整性、外键、当前/预期 schema 版本，并报告 queued/running/retry-wait/paused 任务数量；`ready=false` 时应先备份并处理报告的问题，不要直接替换镜像。

推荐的升级/恢复清单：

1. 停止写入或确认任务账本中的 active task 数量，创建并核对备份 manifest。
2. 替换 API 镜像后先访问 `/healthz`，再登录 WebUI，确认工作区列表和升级前检查均正常。
3. 在每个有 active task 的工作区调用 `workflow:list` 和 `translation:task-get`，确认任务仍为可恢复状态；只通过 WebUI 的任务入口继续执行。
4. 如需恢复备份，在 WebUI 中使用“恢复为新工作区”。恢复完成后页面会自动切换到新工作区，可继续执行任务、编辑、Validator/QA、审核和导出。
5. 发现完整性、schema 或外键检查失败时停止升级，保留原数据目录并按备份恢复流程处理。

## 安全边界

- 控制面容器以 uid/gid `65532`、只读根文件系统、`cap-drop=ALL` 和 `no-new-privileges` 运行。
- `/healthz` 不返回业务数据；诊断路由必须登录且不返回 Secret、正文或数据根路径。
- 反向代理模式下不要把控制面直接暴露到公网；限制来源、启用 HTTPS、保留脱敏访问日志。固定验收已覆盖控制面直连 HTTPS 和独立 HTTPS 反向代理两种入口。
- `data/`、`.env`、证书、Provider key 和备份目录都不得提交 Git。
