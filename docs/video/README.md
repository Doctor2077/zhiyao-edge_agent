# 执要 Agent · 演示视频生产线

这里有两条片子：**60–90 秒宣传片**和**3–5 分钟完整教程**。它们不是剪出来的，
而是**跑出来的**——每次改完扩展 UI，重跑一遍命令就能得到一条与新 UI 完全一致的片子。

## 为什么这样做

常规做法是「拿屏幕录制软件录一遍」，问题是：需要真 API Key、回答不可复现、
鼠标会抖、录错了得重来、UI 一改素材全废。

这条生产线换了三个思路：

1. **加载真实扩展**：Playwright 用本机 Edge 加载 `extension/.output/edge-mv3`，
   视频里的侧边栏就是真扩展在跑，不是画出来的 mock。
2. **本地假模型服务**：`mock_provider.py` 起一个 OpenAI 兼容的 SSE 服务，
   按脚本表返回回答与 function calling。于是「AI 操作网页」走的是扩展完整真实代码路径
   （快照 → 参数校验 → 确认卡片 → 内容脚本改 DOM → 结果回传），但一分钱不花、每次结果一致。
3. **逐帧合成而不是录屏**：两个网页分别用 CDP screencast 采帧，再合成进一台「虚拟 Edge 窗口」，
   附带镜头推拉、合成光标、高亮框、系统通知气泡、烧入字幕。所以能做出录屏做不到的运镜。

## 环境依赖

| 用途 | 依赖 | 说明 |
|---|---|---|
| 浏览器自动化 | `playwright`（Python） | 用 `executable_path` 指向本机 Edge，**不需要** `playwright install` 下载浏览器 |
| 画面合成 | `Pillow`、`numpy` | 逐帧贴图与绘图 |
| 编码 | `imageio-ffmpeg` | 自带静态 ffmpeg，无需另装 |
| 配音 | Windows 自带中文语音 | SAPI「Microsoft Huihui Desktop」，完全离线 |

## 目录

```
docs/video/
├── script/          分镜脚本（唯一事实来源）与生成的分镜表
│   ├── promo.json         宣传片：镜头、旁白、动作时间点
│   └── promo-分镜表.md     生成物，给人审阅用
├── pipeline/        生产线代码
│   ├── mock_provider.py   假模型服务（SSE + function calling）+ 演示网页托管
│   ├── scenes/            演示网页：shop.html（电商页，含 3 个广告位）、article.html（英文长文）
│   ├── tts.py             逐句合成配音并量出真实时长
│   ├── record.py          录制引擎：驱动扩展、逐帧合成、管道编码
│   ├── compose.py         画面合成器：虚拟窗口、镜头、光标、高亮、字幕
│   ├── cards.py           片头/片尾卡与品牌标记（D1 合符·点睛）
│   ├── build.py           总装：贴配音、混 BGM、生成字幕、合成成片
│   ├── make_dict.py       整页翻译用的译文字典（对齐扩展真实的文字元素序号）
│   └── makesheet.py       导出文字镜头表
├── assets/voice/    配音 wav 与时长清单
└── out/             成片与中间产物
```

## 跑一条片子

```bash
cd docs/video/pipeline

# 1) 合成配音，量出每句真实时长
python tts.py --script ../script/promo.json --out ../assets/voice/promo --rate 2

# 2) 录制（先空转彩排可加 --dry-run；只录几个镜头可加 --shots s1,s2）
python record.py --script ../script/promo.json \
                 --tts ../assets/voice/promo/tts.json \
                 --dict scenes/article.dict.json \
                 --out ../out/promo-silent.mp4 \
                 --take ../out/promo-take.json

# 3) 总装：贴旁白、混音乐、生成字幕、合成成片
python build.py --take ../out/promo-take.json --script ../script/promo.json \
                --tts ../assets/voice/promo/tts.json \
                --silent ../out/promo-silent.mp4 --bgm ../assets/bgm-promo.wav \
                --out ../out/promo.mp4 --srt ../out/promo.srt

# 4) 导出分镜表（给人审阅）
python makesheet.py --script ../script/promo.json --tts ../assets/voice/promo/tts.json \
                    --take ../out/promo-take.json --out ../script/promo-分镜表.md
```

## 两个关键设计

**时间轴由实测决定，不由估算决定。**
录制时把每个镜头真实的起始时刻、旁白起点写进 `take.json`，`build.py` 再据此摆放配音与字幕。
所以模型流式回答快一点慢一点都不会让音画错位——这也意味着换配音语速或改文案后，
**不需要重录画面**，只要重新走一遍第 1、3 步。

**内容页必须始终是扩展眼里的「当前标签页」。**
扩展通过 `tabs.query({active, lastFocusedWindow})` 找页面。面板如果抢了焦点，
扩展就会去读面板自己、报「无法访问当前标签页」。所以面板放在**同一个窗口的后台标签页**，
所有交互都走 CDP 底层输入（`Input.dispatchMouseEvent` / `insertText` / `dispatchKeyEvent`），
不会激活标签页；后台标签页照样实时渲染、照样能 screencast 采帧。

## 已知取舍

- 输出 25fps。合成一帧在「面板流式输出」时约 15ms、「页面滚动」约 37ms、「镜头运动」约 40ms，
  正好卡在 40ms 预算内。用 `record.py` 收尾打印的「迟到帧」可以自查（应为 0）。
- 演示网页是本地 http 服务托管的虚构页面，不是真实网站——避免视频里出现他人版权内容。
- 片尾「商店搜索」文案需与实际上架名称一致。
