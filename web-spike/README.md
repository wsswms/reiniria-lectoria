# M6.2a Vue 技术验证 Spike

这是 Vue 3 + Vite + Naive UI 的最小构建与静态托管验证，不是产品 WebUI。

固定版本：

- Vue `3.5.41`
- Vite `7.3.6`
- Naive UI `2.44.1`
- Node `22.23.1`（固定 digest 构建层）

验证内容：

- `npm ci --ignore-scripts` 可重复安装；
- `npm run build` 在固定 Node 22 镜像中通过；
- 输出使用相对 `base`，可由静态资源服务托管；
- 最小页面包含 Naive UI layout、input、button、tag、alert，并调用 `/api/v1/execute` fixture 路径；
- gzip 后主 JS 约 `92.44 KB`，未引入独立编辑器包；
- `npm audit --audit-level=high`：high/critical `0`；
- Distroless 预览容器以 uid/gid `65532:65532`、只读根文件系统和 `cap-drop ALL` 运行，index 与 asset smoke 请求通过。

本 Spike 不决定最终页面信息架构，不验证完整 WorkflowApi 接线，也不引入生产依赖到根项目；具体页面功能在 M6.3 单独讨论。
