# Web AI Assistant（Edge 扩展，BYOK）

自带 API Key 的 Edge 侧边栏 AI 助手：理解当前网页并对话。M1 骨架版本。

## 快速开始

```bash
pnpm install          # 安装依赖（自动 wxt prepare）
pnpm dev              # 开发模式（HMR，Edge 目标）
pnpm build            # 生产构建 → .output/edge-mv3/
pnpm zip              # 打包 zip（上架用）
pnpm compile          # 仅类型检查
```

## 在 Edge 中加载（验证步骤）

1. 运行 `pnpm build`，产物在 `.output/edge-mv3/`。
2. 打开 Edge，地址栏输入 `edge://extensions`。
3. 打开左下角/右上角「**开发人员模式**」开关。
4. 点击「**加载解压缩的扩展**」，选择 `extension/.output/edge-mv3` 目录。
5. 点击工具栏上的扩展图标 → 侧边栏打开。

## M1 验收清单

- [ ] 点击工具栏图标打开侧边栏（中英文按浏览器语言自动切换）
- [ ] 未配置 Key：直接提问 → **演示模式**本地模拟流式回复（认证走查路径）
- [ ] 设置 → 添加服务商（DeepSeek 等 8 个预设 + 自定义）→ 填 Key → **测试连接**通过
- [ ] 打开任意网页提问 → 发送前显示「将发送：正文/视口/选中」摘要 → 流式回答基于页面内容
- [ ] 「停止」可中断流式输出；回复后显示 token 估算
- [ ] 切换标签页后提问 → 若提示无权限，点击工具栏图标再试
- [ ] 历史记录：会话自动保存（本地），可删除/清空/重新打开
- [ ] 设置：演示模式 / 自动读页 / 发送前预览 / 记住密钥（session 与 local 切换，密钥迁移）

## M2 验收清单（网页操作，逐步确认）

- [ ] 配置 DeepSeek 等支持 function calling 的服务商后，在任意网页提问「把搜索框填上 XXX」：
  模型先自动读取交互元素快照 → 侧边栏弹出**操作确认卡片**（动作/目标/风险等级）→ 点「确认执行」→ 页面真实执行 → 结果回传
- [ ] 「取消」可拒绝操作；对话中可见「操作结果」记录
- [ ] 多步任务（如「点击登录 → 输入账号 → 点提交」）每一步都弹卡片，上限 10 步，可随时「停止」
- [ ] 无 Key 时：提问含「**演示操作**」（或 demo action）→ 走一遍模拟点击的确认流程（认证走查路径）
- [ ] 不支持 function calling 的服务商自动降级 JSON 模式（尽力而为）

> 合规红线：所有操作白名单校验（`src/core/tools.ts`），模型输出不落在白名单即拒绝；无任何全自动批量操作；页面操作只用原生 DOM 事件，不用 chrome.debugger。
> 白名单工具（17 个）：snapshot / click / type / select / scroll / read_text / read_html / **page_source（整页源码）** / **get_texts（文字元素清单）** / **translate_page（整页翻译替换）** / extract_table / copy / **edit_text / edit_html / set_attribute / remove_element / hide_element** / open_in_new_tab。
> 编辑工具防注入：edit_html 自动剥离 script/iframe/on* 事件属性与 javascript: 链接；set_attribute 拒绝 on* 属性名。修改仅在本机页面生效（刷新即恢复），等同于用户 F12 手动编辑。

## 技能（Skill）功能

- 位置：设置 → 「技能」栏目
- 形态：**指令包 + 可选工具引用**——技能把专业指令注入系统提示词；`tools` 字段只能引用内置白名单工具（导入时校验，越界拒绝）
- 来源：**内置商店**（5 个预置：网页总结/网页翻译/表格分析/表单助手/精读助手）+ **手动导入 JSON**
- 管理：安装 / 启用开关 / 查看详情 / 删除；启用的技能每次对话自动注入

导入示例（JSON）：

```json
{
  "id": "my-skill",
  "name": "我的技能",
  "nameEn": "My Skill",
  "description": "一句话说明",
  "descriptionEn": "One-line description",
  "version": "1.0.0",
  "author": "me",
  "whenToUse": "用户要求……时使用",
  "tools": ["read_text"],
  "instructions": "你负责……（至少 10 字，会被注入系统提示词）"
}
```

## 目录结构（单包分层）

```
extension/
├── wxt.config.ts            # WXT 配置：srcDir、权限、side_panel、i18n
├── src/
│   ├── entrypoints/
│   │   ├── background.ts    # SW：打开侧边栏 + READ_PAGE 消息处理（activeTab 按需注入）
│   │   └── sidepanel/       # 侧边栏 React 入口
│   ├── core/                # 领域层（与 UI 无关）
│   │   ├── protocol.ts      # 消息协议（zod，含快照/操作）
│   │   ├── providers.ts     # 8 服务商预设 + 配置 schema
│   │   ├── settings.ts      # 设置/密钥存取（session/local）
│   │   ├── prompts.ts       # 系统提示词 + 上下文组装
│   │   ├── chatEngine.ts    # SSE 流式直连 / function calling / 非流式降级
│   │   ├── tools.ts         # 工具白名单注册表（9 工具 + 风险分级 + 参数校验）
│   │   ├── skills.ts        # 技能包（Schema/白名单校验/内置商店 5 技能/存取）
│   │   ├── pageActions.ts   # 快照/操作执行（调 background）
│   │   ├── demo.ts          # 演示模式 mock 流
│   │   ├── pageReader.ts    # 调 background 读页
│   │   ├── sessions.ts      # 本地历史会话
│   │   └── tokenEstimate.ts # token 估算
│   └── ui/                  # 视图层（React）
│       ├── useChat.ts       # 聊天状态机 + agent 循环（提议→确认→执行→回传，上限 10 步）
│       └── components/      # ChatView / ActionCard(确认卡片) / SettingsView / HistoryView
├── public/
│   ├── content/page-reader.js    # 页面正文读取（按需注入）
│   ├── content/page-snapshot.js  # 交互元素快照采集（按需注入）
│   ├── content/page-actions.js   # 白名单操作执行器（原生 DOM 事件，不执行任何注入代码）
│   └── _locales/{en,zh_CN}/messages.json  # 双语词条
│   └── ui/                  # 视图层（React）
│       ├── SettingsContext.tsx
│       ├── useChat.ts       # 聊天状态机（读页→组上下文→流式→存会话）
│       └── components/      # ChatView / SettingsView / HistoryView
├── public/
│   ├── content/page-reader.js   # 按需注入的页面读取脚本（无依赖 IIFE）
│   └── _locales/{en,zh_CN}/messages.json  # 双语词条
└── docs 在上级目录（设计文档 + 架构 Prompt）
```

## 关键设计约束（详见上级 docs/）

- **权限**：`sidePanel/storage/scripting` + **`host_permissions: http(s)://*/*`**（页面读取是核心功能，打开面板即读当前网页，无逐站授权）+ `optional_host_permissions`（模型服务端点按 origin 单独申请）。不用 `chrome.debugger`；上架时在 Partner Center 权限理由中说明 host_permissions 的单一用途依据。
- **BYOK**：密钥存 `chrome.storage.session`（默认）或 `local`（用户选择「记住」）；扩展内无任何密钥埋点。
- **直连模型服务**：SSE 流式（OpenAI 兼容 `/chat/completions`），非流式自动降级；无自建后端。
- **无远程代码**：模型输出仅作为文本渲染，绝不 eval。
- M2 规划：交互元素快照 + 工具白名单 + 逐步确认的网页操作（未在本版本实现）。
