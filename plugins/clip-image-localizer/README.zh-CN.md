# Clip Image Localizer（剪藏图片本地化）

将剪藏笔记 Markdown / HTML 中的**外链图片**下载到当前 EdgeEver 实例的 **R2 对象存储**，并把正文里的 `![](https://…)` 替换为实例内的 `/api/v1/resources/…/blob` 地址，避免外链失效或防盗链导致无法显示。

## 功能

- **手动同步（全部剪藏）**：命令「Sync clip images to storage」——扫描带 `web-clip` 标签（可在插件设置里改）的笔记。
- **手动同步（当前笔记）**：命令「Sync images in current note」——仅处理编辑器中打开的笔记。
- **每日自动同步**：
  - **桌面端**：通过插件计划任务（默认 UTC 03:00，可在设置中改 cron）。
  - **Web 端**：在 EdgeEver 保持打开时，约每 24 小时自动跑一次（无法后台常驻时使用）。
- **可选**：新建带剪藏标签的笔记后，在后台自动本地化（设置「Localize after new web clip」）。

单张图片通过公开网络拉取时上限约 **2 MB**（与 EdgeEver 插件公共网络策略一致）；更大图片会被跳过并在控制台记录。

## 安装

1. 在 EdgeEver **插件市场** 或 **设置 → 插件** 中，选择「从 Manifest 安装」。
2. 填写 manifest 地址（需 HTTPS 且允许 CORS），例如自托管或 GitHub Release 上的 `manifest.json`：
   ```text
   https://raw.githubusercontent.com/<你的账号>/edgeever/main/plugins/clip-image-localizer/manifest.json
   ```
3. 启用插件 **Clip Image Localizer**，在插件设置中确认标签与计划任务。

本地开发时，可用静态服务器托管 `plugins/clip-image-localizer/` 目录，再用 manifest URL 安装。

## 权限说明

插件需要读写笔记、上传资源、访问网络（含公开 URL 中继）及（桌面端）计划任务权限。所有写入经 EdgeEver 官方 Repository 完成，与 Web 端手动上传附件相同，存入工作区绑定的 R2。

## 与 Web Clipper 的关系

浏览器剪藏扩展**不会**在上传时拉取图片；本插件在剪藏**之后**处理笔记正文，适合「先快速保存、再批量/定时把图存进 R2」的工作流。
