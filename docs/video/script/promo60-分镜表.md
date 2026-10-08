# 执要 Agent · 60 秒宣传片 · 分镜表

- 画幅 **1920×1080 / 120fps**，成片 **1:03.8**（63.8s），**无音轨**
- 画面来源：**真实扩展 + 本地假模型服务 + 演示网页**逐帧合成，非后期贴图或动画示意
- 时间码取自实际采集（`out/promo60-take.json`），非估算

## 生产管线

这一版把**采集**和**渲染**拆成了两轮，这是能跑到 120fps 的前提：

| 轮次 | 脚本 | 产物 |
|---|---|---|
| 采集 | `record.py --capture` | `page.mp4` / `panel.mp4`（两块「面」，30fps）+ 120Hz 状态采样 + 离散事件日志 |
| 渲染 | `render.py --fps 120` | 逐帧重放状态并合成，分片并行，12 进程约 5 分钟 |

- **真·120fps**：镜头推拉、光标移动、大字入场、光晕全部逐帧重算
- **30fps 上限**：浏览器内容本身受限于 CDP 录屏，这是实时采集无法回避的；但画面「运动感」几乎全部来自前者
- 采集倍率 页面 1.6x / 面板 2.0x —— **必须不低于镜头放大倍率**，否则推近时是把源图拉伸放大，整块发糊

## 镜头总表

| # | 章节 · 时间 | 时长 | 机位 | 大字 | 副标 |
|---|---|---|---|---|---|
| 1 | — · 0:00.0–0:06.0 | 6.0s | `wide` | （整屏卡） | — |
| 2 | 痛点 · 0:06.0–0:11.5 | 5.5s | `page_top` | 网页太长，广告太多 | 长文读不完 · 广告满天飞 |
| 3 | 网页对话 · 0:11.5–0:18.0 | 6.5s | `wide` | 打开就已经读完这一页 | 正文 · 视口 · 选区，都是上下文 |
| 4 | 网页对话 · 0:18.0–0:25.5 | 7.5s | `panel` | 就当前页面提问 | 答案来自你正在看的这一页 |
| 5 | Agent 操作 · 0:25.5–0:36.5 | 11.0s | `panel` | 17 个工具，真的动手操作网页 | 每一步都等你点头 |
| 6 | 整页翻译 · 0:36.5–0:46.3 | 9.8s | `page_top` | 整页翻译，一键换译文 | 刷新即恢复英文原文 |
| 7 | 定时任务 · 0:46.3–0:52.8 | 6.5s | `panel_bottom` | 盯住一个页面，变了就叫你 | 价格 · 库存 · 状态一变，系统通知直接找你 |
| 8 | 隐私 · 0:52.8–0:58.8 | 6.0s | `panel_top` | 没有服务器 · 没有账号 · 没有埋点 | 密钥与数据只存在你自己的浏览器里 |
| 9 | — · 0:58.8–1:03.8 | 5.0s | `panel` | （整屏卡） | — |

## 逐镜说明

### 01 · s1 — 整屏卡

- **时间** 0:00.0–0:06.0（6.0s），画面 wide（—s 到位）
- **大字** —
- **副标** —
- **动作** sceneshop → cardintro → card_off

### 02 · s2 — 痛点

- **时间** 0:06.0–0:11.5（5.5s），画面 page_top（1.0s 到位）
- **大字** 网页太长，广告太多
- **副标** 长文读不完 · 广告满天飞
- **动作** highlight.ad-top → scroll640 → highlight.ad-inline → highlight.ad-float → scroll

### 03 · s3 — 网页对话

- **时间** 0:11.5–0:18.0（6.5s），画面 wide（—s 到位）
- **大字** 打开就已经读完这一页
- **副标** 正文 · 视口 · 选区，都是上下文
- **动作** camerapanel_top → camerapanel → highlight.app-header

### 04 · s4 — 网页对话

- **时间** 0:18.0–0:25.5（7.5s），画面 panel（—s 到位）
- **大字** 就当前页面提问
- **副标** 答案来自你正在看的这一页
- **动作** camerapanel_bottom → click.composer textarea → type → enter → wait.send-btn.stop → highlight.page-chip → camerapanel_top → wait_gone.send-btn.stop

### 05 · s5 — Agent 操作

- **时间** 0:25.5–0:36.5（11.0s），画面 panel（—s 到位）
- **大字** 17 个工具，真的动手操作网页
- **副标** 每一步都等你点头
- **动作** camerapanel_zoom → click.composer textarea → type → enter → camerawide → wait.action-card → highlight.ad-top → click.action-card .btn-primary → wait_gone.action-card → wait.action-card → highlight.ad-float → click.action-card .btn-primary → wait_gone.action-card → wait.action-card → highlight.ad-inline → click.action-card .btn-primary → wait_gone.action-card → camerapage

### 06 · s6 — 整页翻译

- **时间** 0:36.5–0:46.3（9.8s），画面 page_top（—s 到位）
- **大字** 整页翻译，一键换译文
- **副标** 刷新即恢复英文原文
- **动作** scenearticle → scroll420 → camerapanel_zoom → click.composer textarea → type → enter → wait.action-card → click.action-card .btn-primary → camerapage_top → wait_gone.send-btn.stop

### 07 · s7 — 定时任务

- **时间** 0:46.3–0:52.8（6.5s），画面 panel_bottom（—s 到位）
- **大字** 盯住一个页面，变了就叫你
- **副标** 价格 · 库存 · 状态一变，系统通知直接找你
- **动作** click.composer-plus → wait.composer-menu .composer-menu-item:nth-child(2) → click.composer-menu .composer-menu-item:nth-child(2) → wait.quick-task-form → toast

### 08 · s8 — 隐私

- **时间** 0:52.8–0:58.8（6.0s），画面 panel_top（—s 到位）
- **大字** 没有服务器 · 没有账号 · 没有埋点
- **副标** 密钥与数据只存在你自己的浏览器里
- **动作** click.app-nav button:nth-child(5) → camerapanel → highlight.app-nav

### 09 · s9 — 整屏卡

- **时间** 0:58.8–1:03.8（5.0s），画面 panel（—s 到位）
- **大字** —
- **副标** —
- **动作** cardoutro

## 画面语言

- **舞台** 近黑渐变 + 两团缓慢漂移的品牌色光晕 + 极细网格 + 暗角
- **环境背板** 窗口盖不到的地方用窗口自身的超低分辨率模糊放大图垫底（Apple 式 ambient），消除死黑
- **窗口** 悬浮玻璃：圆角 18、重投影、顶缘细高光、外圈描边
- **大字** 小标签 + 大字标题 + 副标三段式，遮罩揭幕 + 上浮，关键词下一条品牌渐变横线
- **标注** 整屏压暗 + 品牌色准星框（四角断口），取代红框
- **取景规则** 页面特写让窗口**左右同时出血**（避免露出「半个侧边栏」）；面板特写只从左侧出血，面板整个可见并贴住右缘

## 成片

- `out/promo60.mp4` —— 1920×1080 / **120fps** / 25.9 MB
- `out/promo60-60fps.mp4` —— 同内容 60fps 兼容版 / 17.6 MB
