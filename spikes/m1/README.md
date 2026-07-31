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
