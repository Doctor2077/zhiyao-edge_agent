#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从演示页里抽出「整页翻译」需要的中文对照词典。

做法：把扩展自己的内容脚本 page-actions.js 注入页面，调用它真实的 get_texts，
拿到与扩展完全一致的文字元素清单（序号 + 原文），再按清单产出 text→译文 的词典。
这样假模型在演示时就能生成 indices 完全对得上的 items_json，
走的是扩展真实的 translate_page 代码路径，而不是我伪造的替换动画。

用法：
  python make_dict.py --scene article --map scenes/article.zh.json --out scenes/article.dict.json
  python make_dict.py --scene article --dump      # 只导出原文清单，便于翻译
"""
from __future__ import annotations
import argparse, asyncio, json, os, sys
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
ACTIONS_JS = os.path.join(ROOT, "extension", "public", "content", "page-actions.js")
PORT = 8791


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene", default="article")
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--dump", default="")
    ap.add_argument("--map", dest="map_path", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--width", type=int, default=1220)
    ap.add_argument("--height", type=int, default=920)
    a = ap.parse_args()

    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=EDGE, headless=True,
                                    args=["--no-first-run", "--hide-scrollbars"])
        pg = await b.new_page(viewport={"width": a.width, "height": a.height})
        await pg.goto(f"http://127.0.0.1:{a.port}/scenes/{a.scene}.html")
        await pg.wait_for_timeout(300)
        await pg.add_script_tag(path=ACTIONS_JS)
        res = await pg.evaluate("() => window.__zhiyaoExec({tool: 'get_texts'})")
        items = json.loads(res["data"])
        print(f"[dict] {a.scene}: {len(items)} 个文字元素；{res['message']}")
        if a.dump:
            with open(a.dump, "w", encoding="utf-8") as f:
                json.dump(items, f, ensure_ascii=False, indent=1)
            print("[dict] 原文清单 →", a.dump)
        if a.map_path and os.path.isfile(a.map_path):
            with open(a.map_path, encoding="utf-8") as f:
                zh = json.load(f)
            out, missing = {}, []
            for it in items:
                src = (it.get("text") or "").strip()
                if not src:
                    continue
                if src in zh:
                    out[src] = zh[src]
                elif len(src) > 24 and src[:24] in zh:
                    out[src[:24]] = zh[src[:24]]
                else:
                    missing.append(src)
            print(f"[dict] 命中 {len(out)} / 缺 {len(missing)}")
            for m in missing[:25]:
                print("   缺:", m[:60])
            if a.out:
                with open(a.out, "w", encoding="utf-8") as f:
                    json.dump(out, f, ensure_ascii=False, indent=1)
                print("[dict] 词典 →", a.out)
        await b.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
