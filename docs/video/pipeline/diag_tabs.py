#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""诊断：扩展 tabs.query({active,lastFocusedWindow}) 到底指向谁，怎么摆才指对。"""
import asyncio, os, shutil, sys, tempfile, time
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
EXT = os.path.join(ROOT, "extension", ".output", "edge-mv3")
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

DUMP = """async () => {
  const tabs = await chrome.tabs.query({});
  const wins = await chrome.windows.getAll({ populate: true });
  return {
    tabs: tabs.map(t => ({ id: t.id, win: t.windowId, active: t.active, url: t.url || '(hidden)', title: (t.title||'').slice(0,40) })),
    wins: wins.map(w => ({ id: w.id, focused: w.focused, tabs: (w.tabs||[]).map(t => t.id) })),
    lastFocused: await chrome.windows.getLastFocused({ populate: true }).then(w => ({ id: w.id, tabs: (w.tabs||[]).map(t => t.id) })).catch(e => String(e)),
  };
}"""

async def main():
    profile = tempfile.mkdtemp(prefix="zhiyao-diag-")
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
                    if "background.js" in w.url:
                        eid = w.url.split("/")[2]
                if eid: break
                await asyncio.sleep(0.25)
            print("ext id:", eid)

            content = await ctx.new_page()
            await content.goto("http://127.0.0.1:8791/scenes/shop.html")
            content_t = await ctx.new_cdp_session(content)

            # 变体一：面板作为「同一个窗口的新标签页」
            await content_t.send("Target.createTarget", {"url": f"chrome-extension://{eid}/sidepanel.html", "newWindow": False})
            panel = None
            for _ in range(60):
                for pg in ctx.pages:
                    if "sidepanel.html" in pg.url: panel = pg; break
                if panel: break
                await asyncio.sleep(0.25)
            await panel.wait_for_load_state("domcontentloaded")
            await asyncio.sleep(0.8)

            await content.bring_to_front()
            await asyncio.sleep(0.5)
            print("\n=== 变体一：面板=同窗口新标签页，内容页置前后 ===")
            print(json.dumps(await panel.evaluate(DUMP), ensure_ascii=False, indent=1))

            # 变体二：再开一个窗口放面板
            await content_t.send("Target.createTarget", {"url": f"chrome-extension://{eid}/sidepanel.html", "newWindow": True})
            panel2 = None
            for _ in range(60):
                for pg in ctx.pages:
                    if "sidepanel.html" in pg.url and pg is not panel: panel2 = pg; break
                if panel2: break
                await asyncio.sleep(0.25)
            await panel2.wait_for_load_state("domcontentloaded")
            await asyncio.sleep(0.8)
            await content.bring_to_front()
            await asyncio.sleep(0.5)
            print("\n=== 变体二：面板=独立窗口，内容页置前后 ===")
            print(json.dumps(await panel2.evaluate(DUMP), ensure_ascii=False, indent=1))
            await ctx.close()
    finally:
        shutil.rmtree(profile, ignore_errors=True)

import json
asyncio.run(main())
