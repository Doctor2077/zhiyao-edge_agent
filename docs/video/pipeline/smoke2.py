#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""录制可行性验证（第二版）：

  1. 用 CDP 底层输入操作面板，保证内容页始终是扩展眼里的「当前标签页」
  2. 验证后台标签页能不能截屏、能不能跑 CDP screencast（录制引擎的基础）
  3. 验证假模型服务能收到请求并流式回答
"""
import asyncio, base64, json, os, shutil, subprocess, sys, tempfile, time
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
EXT = os.path.join(ROOT, "extension", ".output", "edge-mv3")
OUT = os.path.join(HERE, ".smoke")
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PORT = 8792
PAGE_W, PAGE_H, PANEL_W, PANEL_H = 1220, 920, 380, 920


async def cdp_click(cdp, x, y):
    for t in ("mousePressed", "mouseReleased"):
        await cdp.send("Input.dispatchMouseEvent", {"type": t, "x": x, "y": y, "button": "left", "clickCount": 1})


async def cdp_center(cdp, selector):
    doc = await cdp.send("DOM.getDocument", {"depth": -1})
    node = await cdp.send("DOM.querySelector", {"nodeId": doc["root"]["nodeId"], "selector": selector})
    box = await cdp.send("DOM.getBoxModel", {"nodeId": node["nodeId"]})
    q = box["model"]["content"]
    return (q[0] + q[2]) / 2, (q[1] + q[5]) / 2


async def cdp_focus(cdp, selector):
    doc = await cdp.send("DOM.getDocument", {"depth": -1})
    node = await cdp.send("DOM.querySelector", {"nodeId": doc["root"]["nodeId"], "selector": selector})
    await cdp.send("DOM.focus", {"nodeId": node["nodeId"]})


async def cdp_type(cdp, text, delay=0.04):
    for ch in text:
        await cdp.send("Input.insertText", {"text": ch})
        await asyncio.sleep(delay)


async def cdp_enter(cdp):
    for t in ("keyDown", "keyUp"):
        await cdp.send("Input.dispatchKeyEvent", {"type": t, "key": "Enter", "code": "Enter",
                                                  "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13})


async def main():
    os.makedirs(OUT, exist_ok=True)
    mock = subprocess.Popen([sys.executable, os.path.join(HERE, "mock_provider.py"),
                             "--port", str(PORT), "--scenario", "promo",
                             "--events", os.path.join(OUT, "events2.jsonl")],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8")
    await asyncio.sleep(1.0)
    profile = tempfile.mkdtemp(prefix="zhiyao-smoke2-")
    try:
        async with async_playwright() as p:
            ctx = await p.chromium.launch_persistent_context(
                user_data_dir=profile, executable_path=EDGE, headless=True, viewport=None,
                args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}",
                      "--no-first-run", "--no-default-browser-check",
                      "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
                      "--disable-backgrounding-occluded-windows",
                      "--disable-features=CalculateNativeWinOcclusion", "--hide-scrollbars"])
            eid = None
            for _ in range(60):
                for w in ctx.service_workers:
                    if "background.js" in w.url: eid = w.url.split("/")[2]
                if eid: break
                await asyncio.sleep(0.25)

            page = await ctx.new_page()
            pc = await ctx.new_cdp_session(page)
            await pc.send("Emulation.setDeviceMetricsOverride",
                          {"width": PAGE_W, "height": PAGE_H, "deviceScaleFactor": 1, "mobile": False})
            await page.goto(f"http://127.0.0.1:{PORT}/scenes/shop.html")

            await pc.send("Target.createTarget", {"url": f"chrome-extension://{eid}/sidepanel.html", "newWindow": False})
            panel = None
            for _ in range(60):
                for pg in ctx.pages:
                    if "sidepanel.html" in pg.url: panel = pg; break
                if panel: break
                await asyncio.sleep(0.25)
            await panel.wait_for_load_state("domcontentloaded")
            nc = await ctx.new_cdp_session(panel)
            await nc.send("Emulation.setDeviceMetricsOverride",
                          {"width": PANEL_W, "height": PANEL_H, "deviceScaleFactor": 1, "mobile": False})

            provider = {"id": "mock-1", "presetId": "custom", "name": "本地演示模型",
                        "baseUrl": f"http://127.0.0.1:{PORT}/v1", "models": ["zhiyao-demo-chat"],
                        "activeModel": "zhiyao-demo-chat", "enabled": True}
            settings = {"providers": [provider], "activeProviderId": "mock-1", "rememberKeys": True,
                        "demoMode": False, "autoReadPage": True, "previewBeforeSend": True,
                        "enabledSkillIds": [], "defaultSkillsSeeded": True, "lang": "zh"}
            await panel.evaluate("async ([s,k]) => { await chrome.storage.local.set({settings: s, apiKeys: {'mock-1': k}}); }",
                                 [settings, "sk-demo"])
            await panel.reload()
            await panel.wait_for_timeout(1000)

            await page.bring_to_front()
            await asyncio.sleep(0.4)

            async def who_is_active():
                return await panel.evaluate("""async () => {
                  const [t] = await chrome.tabs.query({active:true,lastFocusedWindow:true});
                  const all = await chrome.tabs.query({});
                  return {active: t && t.id, activeUrl: (t && t.url) || '(hidden)',
                          all: all.map(x => (x.url||'(hidden)').replace('chrome-extension://'+chrome.runtime.id, 'EXT'))};
                }""")

            print("发送前 active:", json.dumps(await who_is_active(), ensure_ascii=False))

            # ---- 验证 1：后台标签页能否截屏 + screencast ----
            frames = {"n": 0, "last": 0.0, "bytes": 0}
            async def on_frame(params):
                frames["n"] += 1
                frames["bytes"] = len(base64.b64decode(params["data"]))
                frames["last"] = params["metadata"].get("timestamp", 0)
                try:
                    await nc.send("Page.screencastFrameAck", {"sessionId": params["sessionId"]})
                except Exception:
                    pass
            nc.on("Page.screencastFrame", lambda p: asyncio.create_task(on_frame(p)))
            await nc.send("Page.startScreencast", {"format": "jpeg", "quality": 90, "everyNthFrame": 1})
            await asyncio.sleep(1.0)
            print(f"静态页面 1 秒内 screencast 帧数: {frames['n']}（只推变化帧，静态时少是正常的）")

            # ---- 验证 2：CDP 输入是否抢焦点 ----
            await cdp_focus(nc, "textarea")
            await cdp_type(nc, "这个耳机多少钱？有什么优惠？")
            await asyncio.sleep(0.4)
            print("输入框内容:", await panel.input_value("textarea"))
            print("输入后 active:", json.dumps(await who_is_active(), ensure_ascii=False))

            before = frames["n"]
            sx, sy = await cdp_center(nc, ".send-btn")
            await cdp_enter(nc)
            await asyncio.sleep(1.0)
            print("发送后 active:", json.dumps(await who_is_active(), ensure_ascii=False))
            print("是否进入生成态:", bool(await panel.query_selector(".send-btn.stop")))

            await asyncio.sleep(3.0)
            print(f"3 秒内新增 screencast 帧: {frames['n'] - before}（流式输出时应为几十帧）")
            shot1 = await panel.screenshot()
            await asyncio.sleep(1.0)
            shot2 = await panel.screenshot()
            print("两次截屏是否不同（说明后台标签页仍在实时渲染）:", shot1 != shot2, len(shot1), len(shot2))

            for _ in range(40):
                if not await panel.query_selector(".send-btn.stop"): break
                await asyncio.sleep(0.5)
            await asyncio.sleep(0.5)
            text = await panel.inner_text(".messages")
            print("\n=== 面板对话内容 ===\n" + text[:900])
            chip = await panel.query_selector(".page-chip")
            print("\n页面上下文 chip:", (await chip.inner_text()).replace("\n", " ") if chip else "(无)")
            await panel.screenshot(path=os.path.join(OUT, "panel2-done.png"))
            await nc.send("Page.stopScreencast")
            await ctx.close()
    finally:
        mock.terminate()
        shutil.rmtree(profile, ignore_errors=True)
        try:
            with open(os.path.join(OUT, "events2.jsonl"), encoding="utf-8") as f:
                print("\n=== 假模型事件 ===\n" + f.read())
        except Exception:
            pass

asyncio.run(main())
