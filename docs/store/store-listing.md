# 执要 Agent — Edge 商店上架文案（Partner Center 填写用）

> 提交入口：https://partner.microsoft.com/dashboard/microsoftedge/
> 本文所有字段已按审核要求准备好，直接复制即可；两处 `【】` 占位需你填写。

## 基本信息

| 字段 | 值 |
|---|---|
| 扩展名称（中文） | 执要 Agent |
| 扩展名称（英文） | Zhiyao Agent |
| 版本 | 1.0.0（跟随 package.json） |
| 类别 | 生产力（Productivity） |
| 搜索关键字 | AI 助手, 网页助手, 网页 AI, 网页对话, 整页翻译, 去广告, 定时监控, 价格监控, AI assistant, page AI, webpage chat, translate page |
| 支持网站 | 【GitHub 仓库地址】 |
| 发布者网站 | 【GitHub 仓库地址】 |

## 说明（Description，中文）

圣人执要，四方来效——执要 Agent 是 Edge 侧边栏里的网页 AI 助手：**自带你的 API Key（BYOK）**，打开面板即读懂当前网页，让它替你思考、替你动手。

核心能力：
- 网页对话：自动读取当前网页正文与视口，就页面内容提问、总结、分析
- Agent 操作网页：点击、输入、滚动、修改文字、移除广告等 17+ 工具，默认每步确认，「批准并自动执行」可进入任务模式（支付/提交/密码等危险动作永远强确认）
- 技能商店：21 个内置技能（总结、翻译、去广告、去 AI 味等），一键即装即用
- 整页翻译：直接把页面文字替换为译文，刷新即恢复
- 媒体下载：探测并下载页面直链媒体
- 定时任务：定时检查页面变化（价格、库存），到点弹系统通知
- 本地历史与日志，可导出、可清空

隐私与安全：完全本地运行、无任何服务器；页面内容只发送给你自己配置的模型服务；API Key、对话与页面数据只存本机；无埋点、无遥测。

## Description（English）

The sage holds the essentials; all directions come to serve. Zhiyao Agent is a web AI assistant in your Edge sidebar: bring your own OpenAI-compatible API key (BYOK), open the panel, and it reads the current page — then thinks and acts for you.

Highlights:
- Page chat: reads the page body/viewport and answers, summarizes and analyzes
- Agent page actions: click, type, scroll, edit text, remove ads and 17+ tools; every step confirmed by default, with a task mode (dangerous actions like pay/submit/password are always confirmed)
- Skill store: 21 built-in skills (summarize, translate, ad blocker, humanizer…), one-click install
- In-place page translation: replace page text with the translation, revert on refresh
- Media download: discover and download direct-linked media
- Scheduled checks: watch a page for changes (price, stock) and get a system notification
- Local history and logs: exportable and clearable

Privacy & security: runs fully locally with no server; page content is only sent to the model provider you configure; API keys, conversations and page data stay on your machine; no tracking, no telemetry.

## 单一用途声明（审核用）

本扩展的单一用途是：**作为网页 AI 助手，帮助用户理解当前网页内容并通过确认机制让 AI 操作网页**。所有功能（对话、操作、翻译、下载、定时检查）均围绕这一用途展开，无任何无关行为。

## 权限理由（Permission Justification，审核用）

| 权限 | 用途 |
|---|---|
| `host_permissions`（全部 http(s)） | 扩展的核心功能是「打开面板即读取当前网页」。为让用户在任何网站上打开即用、无需逐站授权，声明了全部 http(s) 站点权限。扩展**不注入常驻内容脚本**，仅在用户打开侧边栏并发送消息时，由后台按需注入读取脚本（page-reader/page-snapshot/page-actions）；不主动访问任何网站。 |
| `sidePanel` | 在 Edge 侧边栏中打开扩展界面。 |
| `storage` | 在用户本机保存设置、技能、历史会话、日志与定时任务。 |
| `scripting` | 按需向当前活动标签页注入页面读取/操作脚本（仅在用户操作时）。 |
| `downloads` | 用户确认后下载页面直链媒体文件。 |
| `alarms` | 驱动用户自建的定时检查任务。 |
| `notifications` | 定时检查完成时弹出本地系统通知。 |
| `optional_host_permissions`（http(s)） | 用户添加自定义模型服务商时，按需授权访问其 API 端点（浏览器弹窗由用户同意）。 |

## 隐私实践声明（审核用）

- 不收集、不传输任何用户数据到开发者服务器；扩展无后端、无账号体系
- 页面内容仅在用户发送消息/定时任务触发时，由用户自己的浏览器直接发送给用户自己配置的模型服务商
- API Key 仅存本机（storage.local/session），不离开浏览器
- 无遥测、无埋点、无第三方统计
- 隐私政策全文见 docs/store/privacy-policy.md（建议托管后填 URL）

## 联系方式

- 邮箱：3538982885@qq.com

## 注意事项

- 包内无混淆代码、无远程代码加载、无 eval 执行，符合商店「可审查性」要求
- `host_permissions` 全 http(s) 会触发人工审核，请把「权限理由」原样填入审核说明
