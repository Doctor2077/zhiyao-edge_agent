#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""执要 Agent 演示视频 · 假模型服务（OpenAI 兼容）+ 演示网页托管。

录制演示视频时，用它替代真实模型服务商：

  * 回答由脚本表驱动——同一句提问永远得到同一段回答，视频可复现、可重录；
  * 真实支持 function calling，所以「AI 操作网页」走的是扩展的完整真实代码路径
    （快照 → 校验 → 确认卡片 → 内容脚本执行 → 结果回传 → 收尾回答）；
  * 顺带托管 scenes/ 下的演示网页——扩展的 host_permissions 只覆盖 http(s)，
    演示页必须走 http，不能是 file://。

端点：
  POST /v1/chat/completions   SSE 流式（含 tool_calls 增量）
  GET  /v1/models             模型列表（教程里演示「获取模型列表」按钮用）
  GET  /scenes/<name>.html    演示网页
  GET  /events                录制事件日志（JSON Lines，供字幕/标注对齐）
  GET  /health                就绪探针

用法：
  python mock_provider.py --scenario promo --port 8791 --events events.jsonl
"""

from __future__ import annotations

import argparse
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
SCENES_DIR = os.path.join(HERE, "scenes")

T0 = time.monotonic()
EVENTS_PATH: str | None = None
DICT: dict[str, str] = {}
CFG = {"cps": 34.0, "think": 0.45, "tool_pause": 0.5, "scenario": "promo"}
_lock = threading.Lock()


def now() -> float:
    return time.monotonic() - T0


def emit(kind: str, **kw) -> None:
    """记录事件（录制引擎据此对齐字幕/标注）。"""
    if not EVENTS_PATH:
        return
    rec = {"t": round(now(), 3), "kind": kind, **kw}
    with _lock:
        with open(EVENTS_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")


# --------------------------------------------------------------------------
# 脚本表：把「用户提问」映射到「一串回答/工具调用」
#
# 每个 step 是下列之一：
#   {"say": "要先说的话", "tool": "工具名", "args": {...}}   说完再发起工具调用
#   {"say": "只有回答"}                                      纯文本回答，结束本轮
#   {"kind": "translate"}                                    由 get_texts 结果 + 词典生成 translate_page
#
# 扩展每轮只执行 tools[0]，所以脚本必须一次给一个工具调用。
# --------------------------------------------------------------------------

PRICE_ANSWER = """页面显示：到手价 ¥1,299（原价 ¥1,599）。

优惠一共三层：双十一满 1000 减 150、以旧换新补贴 200 元、白条 12 期免息，活动今晚 24:00 结束。

其他要点：自营次日达、已售 2.3 万件，支持 7 天无理由退货和一年质保。核心参数是 40mm 镀铍振膜、主动降噪 -48dB、续航 38 小时。

需要我把同价位的另外两款也拉出来对比吗？"""

SCENARIOS: dict[str, list[dict]] = {
    "promo": [
        {
            "id": "price",
            "match": ["多少钱", "价格", "优惠", "贵不贵", "划算"],
            "steps": [{"say": PRICE_ANSWER}],
        },
        {
            "id": "ads",
            "match": ["广告"],
            "steps": [
                {
                    "say": "好，我先看一下页面上有哪些可操作的元素。",
                    "tool": "snapshot",
                    "args": {},
                },
                {
                    "say": "顶部这条横幅是广告位，先去掉它。",
                    "tool": "remove_element",
                    "args": {"selector": ".ad-top"},
                    "mark": ".ad-top",
                },
                {
                    "say": "右下角这个悬浮弹窗也是，去掉。",
                    "tool": "remove_element",
                    "args": {"selector": ".ad-float"},
                    "mark": ".ad-float",
                },
                {
                    "say": "正文里这条「猜你喜欢」同样是推广位。",
                    "tool": "remove_element",
                    "args": {"selector": ".ad-inline"},
                    "mark": ".ad-inline",
                },
                {
                    "say": "清理完成，一共去掉了 3 个广告位：顶部横幅、右下角弹窗、正文里的推广块。\n\n正文、价格、参数这些真正要看的内容都还在。如果渲染出来了空白，刷新页面即可恢复原状。"
                },
            ],
        },
        {
            "id": "translate",
            "match": ["翻译", "translate", "中文"],
            "steps": [
                {
                    "say": "我先取出页面上所有文字元素，再批量替换成中文。",
                    "tool": "get_texts",
                    "args": {},
                },
                {"kind": "translate", "say": "拿到清单了，开始整页替换。"},
                {"say": "整页翻译完成，正文、标题、导航都换成中文了。\n\n替换只在本机生效、不改动服务器，刷新页面就能恢复英文原文。"},
            ],
        },
    ],
    "tutorial": [],  # 教程复用 promo 的场景，后面按需追加
}


def pick_scenario(question: str) -> dict | None:
    table = SCENARIOS.get(CFG["scenario"], []) + SCENARIOS.get("promo", [])
    for sc in table:
        for kw in sc["match"]:
            if kw.lower() in question.lower():
                return sc
    return None


def last_user_index(messages: list[dict]) -> int:
    for i in range(len(messages) - 1, -1, -1):
        m = messages[i]
        if m.get("role") == "user" and isinstance(m.get("content"), str):
            return i
    return -1


def tool_rounds_since(messages: list[dict], idx: int) -> int:
    n = 0
    for m in messages[idx + 1:]:
        if m.get("role") == "assistant" and m.get("tool_calls"):
            n += 1
    return n


def find_tool_result(messages: list[dict], want: str) -> dict | None:
    """在消息历史里找某个工具的最近一次返回（用于按清单生成译文）。"""
    for m in reversed(messages):
        if m.get("role") != "tool":
            continue
        try:
            payload = json.loads(m.get("content") or "{}")
        except Exception:
            continue
        data = payload.get("data")
        if isinstance(data, str) and (want == "texts"):
            try:
                items = json.loads(data)
            except Exception:
                continue
            if isinstance(items, list) and items and isinstance(items[0], dict) and "i" in items[0]:
                return {"items": items, "message": payload.get("message", "")}
    return None


def build_translate_args(messages: list[dict]) -> dict | None:
    got = find_tool_result(messages, "texts")
    if not got:
        return None
    items = []
    for el in got["items"]:
        src = (el.get("text") or "").strip()
        if not src:
            continue
        zh = DICT.get(src)
        if not zh and len(src) > 24:
            zh = DICT.get(src[:24])
        if zh:
            items.append({"index": el["i"], "text": zh})
    if not items:
        return None
    return {"lang": "中文", "items_json": json.dumps(items, ensure_ascii=False)}


# --------------------------------------------------------------------------
# SSE 输出
# --------------------------------------------------------------------------

def sse(obj: dict) -> bytes:
    return ("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8")


def chunk_delta(text: str) -> dict:
    return {"choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}]}


def tool_delta(index: int, *, id: str | None = None, name: str | None = None, args: str | None = None) -> dict:
    fn: dict = {}
    if name is not None:
        fn["name"] = name
    if args is not None:
        fn["arguments"] = args
    call: dict = {"index": index, "function": fn}
    if id is not None:
        call["id"] = id
        call["type"] = "function"
    return {"choices": [{"index": 0, "delta": {"tool_calls": [call]}, "finish_reason": None}]}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ZhiyaoMock/1.0"

    def log_message(self, fmt, *a):  # 静音
        pass

    # ---------- 基础 ----------
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/health", "/"):
            return self._json({"ok": True, "t": round(now(), 2), "scenario": CFG["scenario"]})
        if path == "/events":
            try:
                with open(EVENTS_PATH, encoding="utf-8") as f:
                    body = f.read().encode("utf-8")
            except Exception:
                body = b""
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/v1/models":
            ids = ["zhiyao-demo-chat", "zhiyao-demo-pro", "deepseek-chat", "gpt-4o-mini"]
            return self._json({"object": "list", "data": [{"id": i, "object": "model"} for i in ids]})
        if path.startswith("/scenes/"):
            return self._static(path)
        self._json({"error": "not found", "path": path}, 404)

    def _static(self, path: str):
        name = os.path.basename(path)
        full = os.path.join(SCENES_DIR, name)
        if not os.path.isfile(full):
            return self._json({"error": "no such scene", "name": name}, 404)
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    # ---------- 模型接口 ----------
    def do_POST(self):
        path = urlparse(self.path).path
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        if path != "/v1/chat/completions":
            return self._json({"error": "not found"}, 404)
        try:
            body = json.loads(raw or b"{}")
        except Exception:
            return self._json({"error": "bad json"}, 400)
        try:
            self._completions(body)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # 不要让演示录制因为一个异常卡住
            emit("error", message=repr(exc))
            try:
                self._json({"error": repr(exc)}, 500)
            except Exception:
                pass

    def _completions(self, body: dict):
        messages = body.get("messages") or []
        tools = body.get("tools") or []
        tool_names = set()
        for t in tools:
            try:
                tool_names.add(t["function"]["name"])
            except Exception:
                pass

        ui = last_user_index(messages)
        question = messages[ui].get("content", "") if ui >= 0 else ""
        if isinstance(question, list):  # 兼容多段 content
            question = " ".join(p.get("text", "") for p in question if isinstance(p, dict))
        question = str(question)
        rounds = tool_rounds_since(messages, ui)

        scenario = pick_scenario(question)
        step = None
        if scenario:
            steps = scenario["steps"]
            if rounds < len(steps):
                step = steps[rounds]
        if step is None:
            step = {"say": "（演示脚本里没有为这句话准备回答）"}

        emit(
            "request",
            round=rounds,
            scenario=(scenario or {}).get("id", "fallback"),
            question=question[-120:],
            tool_names=sorted(tool_names),
        )

        # 关键：SSE 响应没有 Content-Length，必须显式关闭连接，
        # 否则 HTTP/1.1 keep-alive 会让浏览器读流永不结束（扩展会一直停在「生成中」）。
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self._cors()
        self.end_headers()

        model = body.get("model") or "zhiyao-demo"
        head = {"id": "chatcmpl-demo", "object": "chat.completion.chunk", "model": model}

        def send(obj: dict):
            self.wfile.write(sse({**head, **obj}))
            self.wfile.flush()

        # 1) 先流式吐文本
        say = step.get("say") or ""
        if say:
            emit("say_start", scenario=(scenario or {}).get("id"), chars=len(say))
            cps = float(CFG["cps"])
            i = 0
            while i < len(say):
                size = max(2, int(cps * 0.07))
                piece = say[i:i + size]
                send(chunk_delta(piece))
                i += size
                time.sleep(0.07)
            emit("say_end", scenario=(scenario or {}).get("id"))

        # 2) 工具调用
        tool = step.get("tool")
        args = step.get("args")
        if step.get("kind") == "translate":
            args = build_translate_args(messages)
            tool = "translate_page" if args else None
            if not args:
                emit("translate_no_dict")
                send(chunk_delta("\n\n（没有找到可用的译文字典，已跳过替换）"))
        if tool:
            if tool_names and tool not in tool_names:
                emit("tool_unavailable", tool=tool)
            else:
                time.sleep(float(CFG["think"]))
                if tool == "snapshot":
                    args = {}
                    emit("tool_call", tool=tool)
                else:
                    emit("tool_call", tool=tool, args=args, mark=step.get("mark"))
                raw_args = json.dumps(args or {}, ensure_ascii=False)
                send(tool_delta(0, id="call_" + tool, name=tool, args=""))
                for j in range(0, len(raw_args), 80):
                    send(tool_delta(0, args=raw_args[j:j + 80]))
                    time.sleep(0.02)
                time.sleep(float(CFG["tool_pause"]))

        send({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        emit("response_done", round=rounds)


def main() -> None:
    global EVENTS_PATH, CFG
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8791)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--scenario", default="promo", choices=sorted(SCENARIOS))
    ap.add_argument("--cps", type=float, default=34.0, help="文字流式速度（字/秒）")
    ap.add_argument("--dict", dest="dict_path", default="", help="译文词典 JSON（text→译文）")
    ap.add_argument("--events", default="", help="事件日志输出路径")
    a = ap.parse_args()

    CFG["scenario"] = a.scenario
    CFG["cps"] = a.cps
    if a.events:
        EVENTS_PATH = os.path.abspath(a.events)
        open(EVENTS_PATH, "w", encoding="utf-8").close()
    if a.dict_path and os.path.isfile(a.dict_path):
        with open(a.dict_path, encoding="utf-8") as f:
            DICT.update(json.load(f))
    emit("server_start", scenario=a.scenario, port=a.port, dict=len(DICT))

    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    srv.daemon_threads = True
    print(f"[mock] http://{a.host}:{a.port}  scenario={a.scenario}  dict={len(DICT)} 条", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
