import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image
import compose as C

HERE = os.path.dirname(os.path.abspath(__file__))
SMOKE = os.path.join(HERE, ".smoke")
page = Image.open(os.path.join(SMOKE, "page-1-shop.png")).convert("RGB")
panel = Image.open(os.path.join(SMOKE, "panel2-done.png")).convert("RGB")
page = page.resize((int(page.width*1.5), int(page.height*1.5)), Image.LANCZOS)
panel = panel.resize((panel.width*2, panel.height*2), Image.LANCZOS)
comp = C.Compositor(page, panel, url="https://item.yunji.com/100058712345.html",
                    title="云声 X5 Pro 无线降噪耳机 - 云集商城", favicon=(225,37,27))
comp.cursor.jump(900, 500); comp.caption.set("测试字幕", 0.0)

def bench(name, fn, n=24):
    ts = []
    for i in range(n):
        fn(i)
        t = time.perf_counter(); comp.frame(2.0 + i/25, 1/25); ts.append((time.perf_counter()-t)*1000)
    ts.sort()
    print(f"  {name:<28} 中位 {ts[len(ts)//2]:5.1f}ms  最慢 {ts[-1]:5.1f}ms   → {1000/ts[len(ts)//2]:4.0f} fps")

comp.cam.jump(C.preset("wide"))
bench("面板每帧变（流式输出）", lambda i: comp.set_layers(panel=panel.point(lambda v: v)))
comp.cam.jump(C.preset("wide"))
bench("网页每帧变（页面滚动）", lambda i: comp.set_layers(page=page.point(lambda v: v)))
comp.cam.jump(C.preset("wide"))
def cam_move(i):
    if i % 12 == 0: comp.cam.to(C.preset("panel"), 0.8, 2.0 + i/25)
bench("镜头运动中", cam_move)
