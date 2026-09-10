#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""冒烟测试：验证「真扩展 + 假模型服务 + 演示网页」这条录制链路是否可用。

跑通即说明：
  1. Playwright 能加载真实扩展（Edge 渠道，无需下载浏览器）
  2. 侧边栏面板能在独立窗口里渲染，且内容页仍是扩展眼里的「当前标签页」
  3. 扩展能读到演示网页正文，并把提问发给我们自己的假模型服务
  4. 假模型能以 SSE 流式回答，面板真实渲染出气泡

产物：.smoke/panel-*.png、.smoke/page-*.png，人工核对渲染是否正常。
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
EXT = os.path.join(ROOT, "extension", ".output", "edge-mv3")
OUT = os.path.join(HERE, ".smoke")
PORT = 8791
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

PAGE_W, PAGE_H = 1220, 920
PANEL_W, PANEL_H = 380, 920


async def wait_extension_id(ctx, timeout=20.0) -> str:
    end = time.time() + timeout
    while time.time() < end:
        for w in ctx.service_workers:
            if "background.js" in w.url:
                return w.url.split("/")[2]
        await asyncio.sleep(0.25)
    raise RuntimeError("没等到扩展 service worker")


async def set_metrics(page, w, h, dsf=1):
    cdp = await page.context.new_cdp_session(page)
    await cdp.send("Emulation.setDeviceMetricsOverride", {
        "width": w, "height": h, "deviceScaleFactor": dsf, "mobile": False,
    })
    return cdp


async def main() -> int:
    if not os.path.isdir(EXT):
        print("!! 找不到构建产物，先跑 pnpm build：", EXT)
        return 2
    os.makedirs(OUT, exist_ok=True)

    mock = subprocess.Popen(
        [sys.executable, os.path.join(HERE, "mock_provider.py"),
         "--port", str(PORT), "--scenario", "promo",
         "--events", os.path.join(OUT, "events.jsonl")],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
    )
    await asyncio.sleep(1.0)
    profile = tempfile.mkdtemp(prefix="zhiyao-smoke-")
    try:
        async with async_playwright() as p:
            ctx = await p.chromium.launch_persistent_context(
                user_data_dir=profile,
                executable_path=EDGE,
                headless=True,
                viewport=None,
                args=[
                    f"--disable-extensions-except={EXT}",
                    f"--load-extension={EXT}",
                    "--no-first-run", "--no-default-browser-check",
                    "--disable-background-timer-throttling",
                    "--disable-renderer-backgrounding",
                    "--disable-backgrounding-occluded-windows",
                    "--disable-features=CalculateNativeWinOcclusion",
                    "--hide-scrollbars",
                ],
            )
            eid = await wait_extension_id(ctx)
            print("[smoke] 扩展 ID:", eid)

            # 1) 内容页：演示用电商页
            page = await ctx.new_page()
            await set_metrics(page, PAGE_W, PAGE_H)
            await page.goto(f"http://127.0.0.1:{PORT}/scenes/shop.html")
            await page.wait_for_timeout(500)

            # 2) 面板页：独立窗口，避免抢走「当前标签页」
            cdp_page = await ctx.new_cdp_session(page)
            await cdp_page.send("Target.createTarget", {
                "url": f"chrome-extension://{eid}/sidepanel.html",
                "newWindow": True,
            })
            panel = None
            for _ in range(60):
                for pg in ctx.pages:
                    if "sidepanel.html" in pg.url:
                        panel = pg
                        break
                if panel:
                    break
                await asyncio.sleep(0.25)
            if panel is None:
                raise RuntimeError("没等到面板页")
            await panel.wait_for_load_state("domcontentloaded")
            await set_metrics(panel, PANEL_W, PANEL_H)

            # 3) 写入设置：自定义服务商指向本地假模型
            provider = {
                "id": "mock-1", "presetId": "custom", "name": "本地演示模型",
                "baseUrl": f"http://127.0.0.1:{PORT}/v1",
                "models": ["zhiyao-demo-chat"], "activeModel": "zhiyao-demo-chat",
                "enabled": True,
            }
            settings = {
                "providers": [provider], "activeProviderId": "mock-1",
                "rememberKeys": True, "demoMode": False,
                "autoReadPage": True, "previewBeforeSend": True,
                "enabledSkillIds": [], "defaultSkillsSeeded": True, "lang": "zh",
            }
            await panel.evaluate(
                "async ([s, k]) => { await chrome.storage.local.set({ settings: s, apiKeys: { 'mock-1': k } }); }",
                [settings, "sk-demo"],
            )
            await panel.reload()
            await panel.wait_for_timeout(1200)
            print("[smoke] 面板标题:", await panel.title())
            panel.on("console", lambda m: print(f"    [panel:{m.type}] {m.text[:200]}"))
            panel.on("pageerror", lambda e: print(f"    [panel:error] {str(e)[:300]}"))
            page.on("console", lambda m: print(f"    [page:{m.type}] {m.text[:200]}") if m.type == "error" else None)

            # 4) 内容页必须是扩展眼里的当前标签页
            await page.bring_to_front()
            active = await panel.evaluate(
                "async () => { const [t] = await chrome.tabs.query({active:true,lastFocusedWindow:true}); return t ? (t.url || String(t.id)) : 'none'; }"
            )
            print("[smoke] 扩展看到的当前标签页:", active)

            await panel.screenshot(path=os.path.join(OUT, "panel-1-initial.png"))
            await page.screenshot(path=os.path.join(OUT, "page-1-shop.png"))

            # 5) 提问并等待流式回答
            await panel.click("textarea")
            await panel.type("textarea", "这个耳机多少钱？有什么优惠？", delay=45)
            await panel.wait_for_timeout(400)
            await panel.screenshot(path=os.path.join(OUT, "panel-2-typed.png"))
            print("[smoke] 输入框内容:", await panel.input_value("textarea"))
            print("[smoke] 发送按钮:", await panel.eval_on_selector_all(
                ".send-btn", "els => els.map(e => e.className + '|disabled=' + e.disabled)"))
            await panel.click(".send-btn")
            print("[smoke] 已点发送，等待回答…")

            try:
                await panel.wait_for_selector(".send-btn.stop", timeout=8000)
            except Exception:
                print("[smoke] !! 没有进入生成态。面板当前文本：")
                print(await panel.inner_text("body"))
                raise
            await panel.wait_for_timeout(1200)
            await panel.screenshot(path=os.path.join(OUT, "panel-3-streaming.png"))
            try:
                await panel.wait_for_selector(".send-btn.stop", state="detached", timeout=30000)
            except Exception:
                print("[smoke] !! 流式没有正常结束")
            await panel.wait_for_timeout(500)
            await panel.screenshot(path=os.path.join(OUT, "panel-4-done.png"))

            body = await panel.inner_text(".messages")
            print("[smoke] 对话内容：\n" + body[:800])
            chip = await panel.inner_text(".page-chip") if await panel.query_selector(".page-chip") else "(无)"
            print("[smoke] 页面上下文 chip:", chip.replace("\n", " "))

            await ctx.close()
    finally:
        mock.terminate()
        try:
            mock.wait(timeout=5)
        except Exception:
            mock.kill()
        shutil.rmtree(profile, ignore_errors=True)
    print("[smoke] 完成，截图在", OUT)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
