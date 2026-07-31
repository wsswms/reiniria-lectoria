# M1 可行性 Spike

这里保存 M1 的可丢弃原型和自动验证。代码只使用自建 fixture、fake Provider 和本地测试材料，不连接真实模型或商业服务。

## 固定基线

- 主机：Apple Silicon macOS
- 容器：`node@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90`（Node 22.19.0，linux/arm64）
- Pi 上游审阅提交：`696a828a4d4473ba06bb1353d5976c53f78bb43a`
- npm 包：`@earendil-works/pi-coding-agent@0.83.0`

## M1.1 运行

```sh
DOCKER_BIN=/path/to/docker ./scripts/test-m1-1.sh
```

脚本以非 root、只读根文件系统、`tmpfs /tmp`、无 Linux capabilities、无新增权限和无网络运行测试镜像。它不会使用本机 Node.js。

## M1.2 运行

```sh
DOCKER_BIN=/path/to/docker ./scripts/test-m1-2.sh
```

M1.2 使用 18 个 Markdown 与 6 个 HTML 自建 fixture，验证关键 AST 结构 round-trip、保护项严格恢复，以及插入、删除、移动、格式变化、轻微改写、拆分和合并七类 segment 更新。

## M1.3 运行

```sh
DOCKER_BIN=/path/to/docker ./scripts/test-m1-3.sh
```

M1.3 使用 Node 容器内置 SQLite/FTS5，不引入向量、Embedding 或 Rerank 依赖。固定语料含中、日、英各 20 条，固定查询每种语言各 12 条。
