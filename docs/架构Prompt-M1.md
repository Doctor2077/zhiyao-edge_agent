# 架构 Prompt — M1（编码约束文档）

> 依据 vibe-coding-architect 方法论 Phase 4 生成。本文件是 M1 阶段所有编码工作的约束：每个模块开工前先读本文件。

## 1. 项目背景

Edge 浏览器扩展「网页 AI 助手（BYOK）」：用户自带 API Key，在侧边栏与当前网页对话（M1），后续逐步确认式操作网页（M2）。M1 目标是「可运行骨架」——能在 Edge 中加载、配置模型、基于页面流式问答、无 Key 可演示。

## 2. 目标用户

使用 Microsoft Edge（≥114）、拥有任意 OpenAI 兼容模型服务（DeepSeek/OpenAI/Kimi/GLM/千问/SiliconFlow/Ollama）API Key 的用户。

## 3. 核心需求（M1 范围，按优先级）

1. 侧边栏：对话流 UI、SSE 流式渲染、会话历史（本地）、中英双语
2. 页面感知：读取当前页正文 / 视口文本 / 用户选区
3. 服务商配置：8 个预设 + 自定义端点；密钥存储可选「仅本次会话 / 记住」；测试连接
4. 直连对话：OpenAI 兼容 `/chat/completions`，流式优先、非流式降级
5. 演示模式：未配置 Key 时 mock 流式回复，全 UI 可走查（供商店认证测试）
6. 隐私：发送前内容预览、自动读页开关

## 4. 架构设定

- 产品形态：浏览器扩展（MV3，Edge 目标）
- 架构模式：**单包分层**——`src/ui`（React 视图）/ `src/core`（领域逻辑：配置、对话引擎、prompt、协议）/ `src/entrypoints`（WXT 入口：sidepanel、background）/ `public/content`（按需注入的独立脚本，无 import）
- 运行环境：纯本地，无后端

## 5. 技术约束

- 构建：**WXT ^0.20 + Vite + TypeScript ^5**，browser 目标 `edge`
- UI：**React 18.3 + 原生 CSS**（不引 UI 组件库、不引 Tailwind）
- 校验：**zod ^3**
- 存储：WXT 的 `browser.storage.local/session`（session 需 `chrome.storage.session.setAccessLevel`）
- Node ≥ 20，pnpm ≥ 9
- 消息协议：sidepanel ↔ background ↔ content 的 payload 全部用 zod schema 定义于 `src/core/protocol.ts`

## 6. 非功能需求

- 权限最小：`sidePanel`、`storage`、`activeTab`、`scripting` + `optional_host_permissions`（添加服务商时才按 origin 申请），绝不申请 `<all_urls>` 常规权限
- 密钥不进日志、不进错误信息、不进 manifest；UI 掩码展示（前 4 后 4）
- 无埋点、无远程代码、扩展内不 eval 任何模型输出
- 兼容 Edge ≥ 114；中英双语（`locales/en.json`、`locales/zh_CN.json`，默认 locale `en`）

## 7. 实施计划（= Phase 3 任务拆解，见会话）

M1.0 脚手架 → M1.1 服务商配置 → M1.2 页面读取 → M1.3 对话引擎 → M1.4 演示模式 → M1.5 侧边栏 UI → M1.6 构建验证。每次只做一个模块，构建通过再进下一个。

## 8. 输出要求

每个模块完成后：① 代码（TS 类型完整）；② 一句话说明；③ `pnpm build` 通过；④ 涉及 UI 的给出 Edge 加载后的人工验证步骤。

## 9. 验收标准（M1 完成定义）

- `pnpm build` 零错误；`edge://extensions` 开发者模式加载 `dist` 成功
- 点击工具栏图标打开侧边栏（`setPanelBehavior openPanelOnActionClick`）
- 未配置 Key → 演示模式对话流式可用
- 配置 DeepSeek Key → 测试连接通过 → 基于当前页面问答流式返回，可中止
- 切换语言（zh-CN / en）界面文案生效
- 拒绝某服务商 origin 权限时给出可操作的授权引导，不崩溃

## 10. 限制条件（不要做什么）

1. 不做积分/支付/账号/后端——谁提都不做，v3 已拍板
2. 不做网页操作执行器（M2 范围），但 `src/core` 预留工具定义接口（tool registry 的 schema 位）
3. 不申请 `<all_urls>` 常规权限；页面读取只走 activeTab + 按需注入
4. 不引入 UI 组件库、状态管理库、Tailwind（M1 保持依赖最小）
5. 不把密钥写入 manifest / 日志 / 错误上报 / URL
6. 不过度设计：M1 不做加密存储（v2 路线图）、不做云同步、不做多步 agent 循环
7. 技术栈 Phase 2 锁定后不再变（WXT + React + zod）
