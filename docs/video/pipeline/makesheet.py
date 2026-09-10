#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把分镜脚本 + 实测时间轴导出成可审阅的文字镜头表（Markdown）。

按 B站分镜的写法组织：章节与叙事节拍、时间范围、画面任务、景别与构图、
机位与预期运镜、口播与字幕、B-roll / 图文提示、静帧画面说明。
时间码取自 record.py 的 take.json —— 是真实录制出来的时刻，不是估算。

用法：
  python makesheet.py --script ../script/promo.json --tts ../assets/voice/promo/tts.json \
                      --take ../out/promo-take.json --out ../script/promo-分镜表.md
"""

from __future__ import annotations

import argparse
import json


SHEET = {
    "s1": dict(chapter="片头", beat="品牌亮相", size="整屏图形（无实拍）",
               task="黑底品牌卡淡入：D1 标记 + 产品名 + 标语",
               camera="整屏卡片，0.55s 淡入，无运镜",
               broll="品牌标记按 128 网格几何绘制（圆角方外框 + 右半实心 + 两道锯齿合缝 + 双符眼）",
               still="黑底居中白色标记，下方「执要 Agent」，再下方标语「圣人执要 · 四方来效」，最下一行「Edge 侧边栏 · 网页 AI 助手 · 自带 API Key」"),
    "s2": dict(chapter="痛点", beat="问题具象化", size="全景（浏览器窗口全貌）",
               task="电商长页平滑下滚，逐个高亮 3 个广告位后回到页首",
               camera="全窗口固定机位；页内 scrollTo 缓动下滚 660 → 1080 → 0",
               broll="三个广告位依次高亮：顶部横幅 / 正文「猜你喜欢」推广块 / 右下角优惠券浮层",
               still="虚拟 Edge 窗口占据画面，页面滚到正文中部，红框圈住带「广告」标记的推广块"),
    "s3": dict(chapter="开场钩子 · 功能一", beat="侧边栏登场", size="全景 → 近景（面板）",
               task="侧边栏从右侧滑入，镜头推进到面板，高亮扩展顶栏",
               camera="滑入 0.75s；推镜 wide → panel 1.0s（smoothstep）",
               broll="面板顶栏：执要 Agent + 对话/技能/历史/设置/关于",
               still="窗口右侧出现 380px 侧边栏，左侧网页仍清晰可见，蓝色高亮框落在面板顶栏"),
    "s4": dict(chapter="功能一 · 网页对话", beat="提问与回答", size="近景（面板）",
               task="在输入框逐字敲入问题 → 发送 → 流式回答 → 高亮「将发送」上下文提示",
               camera="推近 panel_zoom 0.9s；答完退回 panel 0.8s",
               broll="上下文提示条：将发送 · 正文 1316 字 · 视口 2779 字 · 选中 0 字",
               still="面板占画面主体，用户气泡在上、助手气泡流式增长，末尾有闪烁光标"),
    "s5": dict(chapter="功能二 · 操作网页", beat="第一次确认", size="近景 → 全景",
               task="输入「帮我把这个页面的广告都去掉」→ 模型取交互元素快照 → 弹出确认卡片 → 点「确认执行」→ 顶部广告消失",
               camera="推近 panel_zoom 0.8s → 拉远 wide 0.9s（确认时看得到页面变化）",
               broll="红色高亮框圈住顶部横幅；确认卡片含风险徽标与「确认执行 / 批准并自动执行 / 取消」",
               still="左页顶部广告位被红框圈住，右面板浮着操作确认卡，光标停在主按钮上"),
    "s6": dict(chapter="功能二 · 操作网页", beat="连续确认与收尾", size="全景 → 中景",
               task="连续两次确认，右下角浮层与正文推广块消失；镜头切到页面看清理结果",
               camera="固定 wide → 收尾推近 page 1.0s",
               broll="每次确认前先高亮对应广告位，确认后该元素从页面消失",
               still="页面已无广告，正文与价格完整；面板里助手给出清理总结"),
    "s7": dict(chapter="功能三 · 整页翻译", beat="换页与整页替换", size="全景 → 近景 → 全景",
               task="切到英文长文 → 地址栏与标题随之改变 → 取文字元素清单 → 确认 → 整页中文",
               camera="wide → panel_zoom 0.9s → page_top 1.0s",
               broll="英文原文与中文译文同机位对比（同一屏、同一滚动位置）",
               still="英文博客标题 Why Reading the Web Still Feels Broken 变成中文标题，正文同步替换"),
    "s8": dict(chapter="功能四 · 定时任务", beat="设置与到点提醒", size="近景（面板）",
               task="打开加号菜单里的定时推送面板，随后弹出系统通知气泡",
               camera="panel_zoom 固定机位；通知从右上角淡入",
               broll="Windows 11 风格通知气泡：价格已降至 ¥1,099 · 云声 X5 Pro",
               still="面板显示定时任务表单，右上角浮着系统通知"),
    "s9": dict(chapter="隐私", beat="数据留在本机", size="近景（面板）",
               task="切到关于页，镜头推近，配合旁白讲本地运行",
               camera="panel → panel_zoom 0.9s",
               broll="关于页的隐私说明与联系方式",
               still="面板显示关于页，强调没有服务器、没有账号、没有埋点"),
    "s10": dict(chapter="片尾", beat="行动号召", size="整屏图形",
                task="品牌卡淡入，给出商店搜索引导",
                camera="整屏卡片，0.9s 淡入",
                broll="D1 标记 + Edge 加载项商店搜索「执要 Agent」+ 一行要点",
                still="黑底居中：标记、产品名、商店搜索指引、三个卖点用间隔号分隔"),
}


def ts(t: float) -> str:
    m, s = divmod(max(0.0, t), 60)
    return f"{int(m)}:{s:04.1f}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--script", required=True)
    ap.add_argument("--tts", required=True)
    ap.add_argument("--take", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--title", default="")
    a = ap.parse_args()

    script = json.load(open(a.script, encoding="utf-8"))
    tts = json.load(open(a.tts, encoding="utf-8"))
    take = json.load(open(a.take, encoding="utf-8"))
    times = {s["id"]: s for s in take["shots"]}

    title = a.title or script.get("title", script.get("id", "视频"))
    total = take.get("duration", 0)
    L = []
    L.append("# " + title + " · 分镜表")
    L.append("")
    L.append("- 画幅 **1920×1080 / " + str(script.get("fps", 25)) + "fps**，成片约 **" + ts(total) + "**")
    L.append("- 旁白：Windows 本地中文语音（" + str(tts.get("voice", "")) + "，语速 " + str(tts.get("rate", "")) + "），逐句合成后按实测时刻贴回画面")
    L.append("- 画面来源：**真实扩展 + 本地假模型服务 + 演示网页**，逐帧合成带浏览器外壳的画面（不是后期贴图或动画示意）")
    L.append("- 时间码取自实际录制，非估算；旁白起点 = 该镜头内旁白开始的时刻")
    L.append("")
    L.append("## 镜头总表")
    L.append("")
    L.append("| # | 章节 · 节拍 | 时间范围 | 时长 | 景别 | 机位 / 运镜 | 画面任务 | 口播 · 字幕 |")
    L.append("|---|---|---|---|---|---|---|---|")
    for i, shot in enumerate(script["shots"], 1):
        sid = shot["id"]
        t = times.get(sid, {})
        sh = SHEET.get(sid, {})
        t0, t1 = t.get("start", 0.0), t.get("end", 0.0)
        narr = (shot.get("narration") or "").strip()
        cap = (shot.get("caption") or "").strip()
        cell = narr + ("<br>**字幕**：" + cap if cap else "")
        L.append("| " + " | ".join([
            str(i), sh.get("chapter", "") + " · " + sh.get("beat", ""),
            ts(t0) + "–" + ts(t1), f"{t1 - t0:.1f}s", sh.get("size", ""),
            sh.get("camera", ""), sh.get("task", ""), cell]) + " |")
    L.append("")
    L.append("## 逐镜说明")
    for i, shot in enumerate(script["shots"], 1):
        sid = shot["id"]
        sh, t = SHEET.get(sid, {}), times.get(sid, {})
        line = tts.get("lines", {}).get(sid, {})
        L.append("")
        L.append("### " + f"{i:02d}" + " · " + sid + " — " + sh.get("chapter", "") + " · " + sh.get("beat", ""))
        L.append("")
        L.append(f"- **时间**：{ts(t.get('start',0))}–{ts(t.get('end',0))}"
                 f"（{t.get('end',0)-t.get('start',0):.1f}s），旁白起点 {ts(t.get('narration_at',0))}，"
                 f"语音净长 {line.get('speech', t.get('speech',0)):.1f}s")
        L.append("- **景别与构图**：" + sh.get("size", ""))
        L.append("- **机位与运镜**：" + sh.get("camera", ""))
        L.append("- **画面任务**：" + sh.get("task", ""))
        acts = shot.get("actions", [])
        if acts:
            L.append("- **动作序列**：" + " → ".join(_fmt(x) for x in acts))
        L.append("- **B-roll / 图文**：" + sh.get("broll", ""))
        L.append("- **静帧画面说明**：" + sh.get("still", ""))
        L.append("- **口播**：" + str(shot.get("narration", "")))
        if shot.get("caption"):
            L.append("- **画面字幕**：" + str(shot["caption"]))
    L.append("")
    L.append("## 声音提示")
    L.append("")
    L.append("- 旁白全程中文女声，语速偏快；每句之间留 0.5–1.2s 呼吸间隔")
    L.append("- 背景音乐：极简氛围电子，垫底音量（约 -30dB），首尾 2.5s 淡入淡出；旁白出现时不做闪避，靠音量差让位")
    L.append("- 无音效、无转场音；确认卡片出现时不做提示音（避免抢戏）")
    L.append("")
    if take.get("warnings"):
        L.append("## 录制警告")
        L.append("")
        for w in take["warnings"]:
            L.append("- " + str(w))
        L.append("")

    with open(a.out, "w", encoding="utf-8") as f:
        f.write("\n".join(L))
    print("[sheet] 分镜表 →", a.out, "（" + str(len(script["shots"])) + " 个镜头）")
    return 0


def _fmt(x: dict) -> str:
    d = x.get("do")
    m = {
        "click": lambda: "点击 " + str(x.get("selector")) + "（" + str(x.get("target", "panel")) + "）",
        "type": lambda: "输入「" + str(x.get("text")) + "」",
        "enter": lambda: "回车发送",
        "camera": lambda: f"镜头切到 {x.get('to')}（{x.get('dur', 0.9)}s）",
        "highlight": lambda: f"高亮 {x.get('selector')}（{x.get('dur')}s）",
        "scroll": lambda: f"页面滚到 {x.get('to')}px（{x.get('dur')}s）",
        "wait": lambda: "等待 " + str(x.get("selector")) + " 出现",
        "wait_gone": lambda: "等待 " + str(x.get("selector")) + " 消失",
        "panel": lambda: "侧边栏滑入" if x.get("open") else "侧边栏收起",
        "card": lambda: "整屏卡片：" + str(x.get("name")),
        "card_off": lambda: "卡片淡出",
        "toast": lambda: "系统通知气泡：" + str(x.get("title")),
        "scene": lambda: "切到演示页 " + str(x.get("page")) + "（地址栏显示 " + str(x.get("url", "")) + "）",
        "sleep": lambda: f"停顿 {x.get('t')}s",
        "hover": lambda: "移动光标",
    }
    return m.get(d, lambda: str(d))()


if __name__ == "__main__":
    raise SystemExit(main())
