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

控制面默认监听 `8787`，WebUI 静态服务默认监听 `4176`。实际 LAN 暴露前，应在反向代理处终止 TLS，并把 `LECTORIA_COOKIE_SECURE=true`、`LECTORIA_ALLOWED_ORIGINS` 配置为真实 WebUI 来源；也可以为控制面直接配置证书和密钥环境变量。

## Provider 配置

登录后在“LLM / 工具来源配置”中添加来源。浏览器只提交一次凭据，服务端把它写入数据根目录下的私有文件；列表接口只返回来源、模型、能力和 `credentialConfigured`，不会回显 Secret。StagePreset 在服务端解析并绑定到 attempt 配置快照，浏览器不能伪造 Provider、模型或工具组合。

默认 `LECTORIA_TRANSLATION_MODE=fake` 适合离线验收。启用真实模式前，应确认预算、模型兼容性和凭据已配置：

```sh
export LECTORIA_TRANSLATION_MODE=real
docker compose -f docker-compose.m6.yml up -d lectoria-http
```

## 备份与恢复

登录 WebUI 的“备份与恢复”卡片即可创建和查看备份。备份由服务端生成，包含 SQLite、已提交对象和可携带知识事实；manifest、数据库完整性、对象 digest 和事实 digest 全部校验通过后才允许恢复。恢复始终创建新工作区，不覆盖已有工作区，也不接受任意文件路径。

升级前应先创建备份，升级后检查 `/healthz`、登录、工作区列表和 queued/running 状态，再继续任务。跨版本升级和灾难恢复演练仍是 M6.5 的后续验收项。

## 安全边界

- 控制面容器以 uid/gid `65532`、只读根文件系统、`cap-drop=ALL` 和 `no-new-privileges` 运行。
- `/healthz` 不返回业务数据；诊断路由必须登录且不返回 Secret、正文或数据根路径。
- 反向代理模式下不要把控制面直接暴露到公网；限制来源、启用 HTTPS、保留脱敏访问日志。
- `data/`、`.env`、证书、Provider key 和备份目录都不得提交 Git。
