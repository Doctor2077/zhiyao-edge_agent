# 执要 Agent（Zhiyao Agent）

> **圣人执要，四方来效。** 用户是执要的圣人，AI 是四方来效的助手。

Edge 浏览器侧边栏网页 AI 助手（Manifest V3 扩展）。**纯客户端、无后端、BYOK**：自带任意 OpenAI 兼容的 API Key，即可与当前网页对话，让 AI 动手操作网页。

## 功能

- **网页对话**：自动读取当前网页（正文 / 视口 / 选区），就页面内容提问
- **Agent 操作网页**：点击、输入、滚动、修改文字、移除广告等 17+ 白名单工具；默认逐步确认，可「批准并自动执行」进入任务模式（支付/提交/密码等危险动作永远强确认）
- **技能商店**：21 个内置技能（总结、翻译、去广告、去 AI 味……），点击即装即用，支持 JSON 导入
- **整页翻译**：直接把页面文字替换为译文（刷新即恢复）
- **媒体下载**：探测并下载页面直链媒体（排除 m3u8 流媒体与 DRM）
- **定时任务**：定时检查指定网页（价格、库存、状态变化），到点弹系统通知
- **本地历史与日志**：会话记录、运行日志仅存本机，可导出 / 清空

## 隐私

- 页面内容只发送给你自己配置的模型服务，**不经过任何服务器**
- API Key、对话记录、页面数据全部只存本机浏览器
- 无埋点、无遥测、无账号体系

## 技术栈

WXT 0.21 · Vite · React 18 · TypeScript · zod

## 构建与安装

```bash
cd extension
pnpm install
pnpm run compile   # 类型检查
pnpm build         # 产物在 .output/edge-mv3
```

Edge 加载：`edge://extensions` → 打开「开发人员模式」→「加载解压缩的扩展」→ 选择 `extension/.output/edge-mv3`（权限变更后需移除后重新加载）。

## 目录结构

```
extension/
├── wxt.config.ts                # manifest 配置（host_permissions 全 http(s) 等）
├── src/
│   ├── entrypoints/background.ts # Service Worker：消息路由、定时任务执行器
│   ├── entrypoints/sidepanel/    # 侧边栏 React 入口
│   ├── core/                     # 领域层：工具白名单 / 聊天引擎 / 技能 / 设置 / 日志
│   └── ui/                       # 聊天循环与组件
└── public/
    ├── content/                  # 内容脚本（页面读取 / 快照 / 操作执行器）
    └── _locales/                 # 中英文词条
docs/                             # 设计文档与品牌资产
```

## 反馈与支持

- 反馈 / 定制：3538982885@qq.com
- 微信赞赏：扩展内「关于」页有收款二维码（`extension/public/donate-qr.jpg`）

## License

[MIT](LICENSE)
