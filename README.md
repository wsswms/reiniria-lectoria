# Reiniria Lectoria

Reiniria Lectoria 是本地优先、工作区强隔离的独立文档翻译平台。M2 数据底座已经完成，当前正在实现 M3 单机文档工作流。

## M2 验证

固定 linux/arm64 Node 22.19.0 容器用于构建和测试：

```sh
DOCKER_BIN=/path/to/docker ./scripts/test-m2-1.sh
DOCKER_BIN=/path/to/docker ./scripts/test-m2-2.sh
DOCKER_BIN=/path/to/docker ./scripts/test-m2-3.sh
DOCKER_BIN=/path/to/docker GIT_BIN=/path/to/git ./scripts/test-m2-4.sh
DOCKER_BIN=/path/to/docker ./scripts/test-m2-5.sh
DOCKER_BIN=/path/to/docker ./scripts/test-m3-1.sh
```

该入口不调用模型或外部内容 API，运行时使用只读根文件系统、无网络、无额外 capabilities，并把测试数据库限制在临时内存文件系统。

## 项目状态

项目目前已建立工作区生命周期、服务端强制作用域、分层存储、备份恢复与 schema v6。M3.1 已将稳定 segment 身份与修订内容分离，并把翻译工作流固定到原文修订和目标语言；后续 M3 子阶段继续实现安全导入、编辑、审核与导出。公开接口、部署方法和贡献指南将在相应实现稳定后补充。

## 方向

- 本地优先，并适合通过 Docker 部署在个人设备或局域网服务器。
- 工作区之间默认强隔离，不隐式共享文档、知识、缓存或运行数据。
- 核心能力面向通用文档翻译，内容系统通过可选 Adapter 接入。
- 在 AI 能力之外保留可独立运作的导入、编辑、审核和导出流程。
