#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""大肥鱼桌宠 · Windows 桌面宠物（Python/tkinter 单文件版）

- 透明无边框置顶窗口，常驻桌面
- 待机游走 / 睡觉 / 碎碎念气泡
- 拖拽 + 抛掷物理（重力、弹跳、摩擦）
- 监听 ~/.workbuddy/dafeiyu-state.json，与 WorkBuddy 大肥鱼技能联动：
  thinking（想）→ working（干活）→ done（庆祝）→ error（冒汗）→ idle

运行：pythonw dafeiyu_pet.py        （无控制台窗口）
自检：python dafeiyu_pet.py --selftest
"""
import json
import math
import os
import random
import sys
import time
import tkinter as tk

APP_W, APP_H = 300, 380          # 画布尺寸（含气泡区）
FISH_W, FISH_H = 130, 130        # 鱼本体大小基准
CHROMA = "magenta"               # 透明色
GROUND_MARGIN = 6

STATE_PATH = os.path.join(os.path.expanduser("~"), ".workbuddy", "dafeiyu-state.json")
CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".workbuddy", "dafeiyu-config.json")

C_BODY = "#7ec8f2"
C_BODY_D = "#3e86b8"
C_BELLY = "#e8f6ff"
C_HAIR = "#3e6fa8"
C_BRIGHT = "#8fccf0"
C_DARK = "#2b3a4a"
C_PINK = "#ffb3c0"
C_BOW = "#ff8fb3"

MURMURS = [
    "吃什么……吃什么……", "白饭好吃，白饭好吃……", "今天也在认真摸鱼",
    "主人主人，要吃白饭！", "唔……有点困了", "咕噜咕噜~",
    "别看我胖，我跑得可快了", "Token 就是白饭，白饭就是力量",
    "（尾巴拍打地面）", "游啊游，游啊游~", "嘘——我在摸鱼",
    "今天的心情是：饭饭",
]
THINK_LINES = ["让鱼想想……", "唔……让我想想", "鱼在想很厉害的东西"]
WORK_LINES = ["鱼在干活！很认真那种", "开工开工~", "这个鱼熟，交给我"]
DONE_LINES = ["干完啦！鱼要吃白饭！", "任务完成！夸我！", "搞定~白饭呢白饭呢"]
ERROR_LINES = ["呜……翻车了", "这里好像有点问题……", "鱼错了，鱼改"]
THROW_LINES = ["哇啊啊啊——", "飞鱼！飞鱼！", "我还会回来的~"]
GRAB_LINES = ["哇！被抓起来了", "放我下来啦~", "唔？！"]


def load_config():
    cfg = {"name": "大肥鱼", "scale": 1.0, "murmur": True, "topmost": True}
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            cfg.update(json.load(f))
    except (OSError, ValueError):
        pass
    return cfg


def save_config(cfg):
    try:
        os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except OSError:
        pass


class DaFeiYu:
    def __init__(self, selftest=False):
        self.cfg = load_config()
        self.selftest = selftest
        self.root = tk.Tk()
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", self.cfg["topmost"])
        try:
            self.root.attributes("-transparentcolor", CHROMA)
        except tk.TclError:
            pass
        self.cv = tk.Canvas(self.root, width=APP_W, height=APP_H,
                            bg=CHROMA, highlightthickness=0)
        self.cv.pack()

        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        self.screen_w, self.screen_h = sw, sh
        self.ground_y = sh - GROUND_MARGIN  # 鱼脚底的屏幕 y

        # 宠物状态
        self.x = sw / 2 - APP_W / 2       # 窗口左上角
        self.y = self.ground_y - APP_H    # 让鱼站在地面
        self.vx = 0.0
        self.vy = 0.0
        self.state = "idle"               # idle/walk/sleep/drag/fly/think/work/done/error
        self.dir = 1
        self.state_until = 0              # 临时状态的结束时间戳
        self.next_decide = time.time() + 3
        self.t = 0.0                      # 动画时间
        self.talk = False                 # 嘴巴动
        self.bubble_text = ""
        self.bubble_until = 0
        self.drag_off = (0, 0)
        self.pointer_hist = []
        self.last_extern = None           # 上次外部状态 (state, task)
        self.rice = 0

        self.last = time.time()
        self._make_menu()
        self._bind()
        self.root.after(30, self._loop)

    # ---------- 右键菜单 ----------
    def _make_menu(self):
        self.menu = tk.Menu(self.root, tearoff=0)
        self.menu.add_command(label="小一点", command=lambda: self._rescale(0.85))
        self.menu.add_command(label="大一点", command=lambda: self._rescale(1.18))
        self.menu.add_separator()
        self.m_murmur = tk.BooleanVar(value=self.cfg["murmur"])
        self.menu.add_checkbutton(label="碎碎念", variable=self.m_murmur,
                                  command=self._toggle_murmur)
        self.m_top = tk.BooleanVar(value=self.cfg["topmost"])
        self.menu.add_checkbutton(label="始终置顶", variable=self.m_top,
                                  command=self._toggle_top)
        self.menu.add_separator()
        self.menu.add_command(label="退出", command=self.root.destroy)

    def _rescale(self, k):
        self.cfg["scale"] = max(0.5, min(2.0, self.cfg["scale"] * k))
        save_config(self.cfg)

    def _toggle_murmur(self):
        self.cfg["murmur"] = self.m_murmur.get()
        save_config(self.cfg)

    def _toggle_top(self):
        self.cfg["topmost"] = self.m_top.get()
        save_config(self.cfg)
        self.root.attributes("-topmost", self.cfg["topmost"])

    # ---------- 事件 ----------
    def _bind(self):
        cv = self.cv
        cv.bind("<ButtonPress-1>", self._on_down)
        cv.bind("<B1-Motion>", self._on_move)
        cv.bind("<ButtonRelease-1>", self._on_up)
        cv.bind("<Button-3>", self._on_menu)
        cv.bind("<Double-Button-1>", self._on_pat)

    def _fish_center(self):
        s = self.cfg["scale"]
        cx = APP_W / 2
        base = APP_H - GROUND_MARGIN - 10 * s  # 鱼底部在画布内的 y
        return cx, base, s

    def _on_down(self, e):
        self.state = "drag"
        _, base, _ = self._fish_center()
        # 画布内鱼的中心
        fcx, fby = APP_W / 2, base - FISH_H * self.cfg["scale"] / 2
        self.drag_off = (e.x - fcx, e.y - fby)
        self.pointer_hist = [(time.time(), self.x, self.y)]
        self.say(random.choice(GRAB_LINES), 1800)

    def _on_move(self, e):
        if self.state != "drag":
            return
        _, base, _ = self._fish_center()
        fcx, fby = APP_W / 2, base - FISH_H * self.cfg["scale"] / 2
        self.x = e.x_root - self.drag_off[0] - fcx + APP_W / 2
        self.y = e.y_root - self.drag_off[1] - fby + (base - FISH_H * self.cfg["scale"])
        now = time.time()
        self.pointer_hist.append((now, self.x, self.y))
        while len(self.pointer_hist) > 6:
            self.pointer_hist.pop(0)

    def _on_up(self, e):
        if self.state != "drag":
            return
        now = time.time()
        p0 = self.pointer_hist[0] if self.pointer_hist else (now - 0.05, self.x, self.y)
        dt = max(now - p0[0], 0.02)
        self.vx = (self.x - p0[1]) / dt
        self.vy = (self.y - p0[2]) / dt
        speed = abs(self.vx) + abs(self.vy)
        if speed > 260:
            self.state = "fly"
            self.state_until = 0
            self.say(random.choice(THROW_LINES), 2000)
        else:
            self.vx = self.vy = 0
            self.state = "idle"
            self.next_decide = time.time() + 1

    def _on_menu(self, e):
        try:
            self.menu.tk_popup(e.x_root, e.y_root)
        finally:
            self.menu.grab_release()

    def _on_pat(self, e):
        if self.state in ("drag", "fly"):
            return
        self.say(random.choice(["咕噜咕噜~", "主人好！", "要吃白饭吗？", "嘿嘿~"]), 2200)

    # ---------- 气泡 ----------
    def say(self, text, ms=4000):
        self.bubble_text = text
        self.bubble_until = time.time() + ms / 1000

    # ---------- 外部状态（WorkBuddy 技能写入） ----------
    def _poll_state_file(self):
        try:
            with open(STATE_PATH, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return
        ext = (data.get("state"), data.get("task") or "", data.get("detail") or "")
        key = (ext[0], ext[1])
        if key == self.last_extern:
            return
        self.last_extern = key
        st, task, detail = ext
        now = time.time()
        if st == "thinking":
            self.state = "think"
            self.state_until = 0
            self.say(task or random.choice(THINK_LINES), 6000)
        elif st == "working":
            self.state = "work"
            self.state_until = 0
            self.talk = True
            self.say(task or detail or random.choice(WORK_LINES), 8000)
        elif st == "done":
            self.state = "done"
            self.state_until = now + 6
            self.talk = False
            self.say((task or "") + " " + random.choice(DONE_LINES), 6000)
        elif st == "error":
            self.state = "error"
            self.state_until = now + 8
            self.talk = False
            self.say((detail or task or "") + " " + random.choice(ERROR_LINES), 8000)
        elif st == "idle":
            if self.state in ("think", "work"):
                self.state = "idle"
                self.talk = False
                self.next_decide = time.time() + 2

    # ---------- 自主行为 ----------
    def _decide(self, now):
        r = random.random()
        if r < 0.4:
            self.state = "walk"
            self.dir = random.choice((-1, 1))
            self.vx = self.dir * (35 + random.random() * 45)
            self.state_until = now + 2 + random.random() * 3.5
        elif r < 0.55:
            self.state = "sleep"
            self.state_until = now + 8 + random.random() * 8
            self.say("Zzz……", 2500)
        elif self.cfg["murmur"]:
            self.say(random.choice(MURMURS))
        self.next_decide = now + 4 + random.random() * 5

    # ---------- 物理 ----------
    def _physics(self, dt):
        if self.state == "drag":
            return
        flying = self._fish_bottom_y() < self.ground_y - 1
        if flying:
            self.vy += 1000 * dt
        self.x += self.vx * dt
        self.y += self.vy * dt
        bottom = self._fish_bottom_y()
        if bottom >= self.ground_y:
            if self.vy > 150:
                self.vy = -self.vy * 0.55
                if abs(self.vy) < 130:
                    self.vy = 0
            else:
                self.vy = 0
            self.y = self.ground_y - (APP_H - GROUND_MARGIN)  # 鱼贴地
            self.vx *= 0.88
            if self.state == "fly" and abs(self.vx) < 10 and self.vy == 0:
                self.state = "idle"
                self.next_decide = time.time() + 1
        w = APP_W
        if self.x < -20:
            self.x = -20
            self.vx = abs(self.vx) * 0.6
        if self.x > self.screen_w - w + 20:
            self.x = self.screen_w - w + 20
            self.vx = -abs(self.vx) * 0.6

    def _fish_bottom_y(self):
        return self.y + (APP_H - GROUND_MARGIN)

    # ---------- 绘制 ----------
    def _draw_bubble(self):
        self.cv.delete("bubble")
        if not self.bubble_text or time.time() > self.bubble_until:
            return
        lines = self.bubble_text
        maxw = 200
        font = ("Microsoft YaHei", 11)
        self.cv.create_text(APP_W / 2, 40, text=lines, font=font,
                            width=maxw, tags="bubble", state="hidden", fill=C_DARK)
        # 用真实文本 bbox 画圆角气泡
        tmp = self.cv.find_withtag("bubble")
        bbox = self.cv.bbox(tmp[0]) if tmp else (0, 0, 100, 30)
        self.cv.delete("bubble")
        x0, y0, x1, y1 = bbox
        pad = 8
        x0 -= pad; y0 -= pad; x1 += pad; y1 += pad
        x0 = max(4, min(x0, APP_W - (x1 - x0) - 4))
        x1 = x0 + (x1 - x0)
        self.cv.create_rectangle(x0, y0, x1, y1, fill="#ffffff",
                                 outline="#9fd0ec", width=1.5, tags="bubble")
        self.cv.create_text((x0 + x1) / 2, (y0 + y1) / 2, text=lines, font=font,
                            width=maxw, tags="bubble", fill=C_DARK)
        # 气泡尾巴指向鱼
        fy_top = APP_H - GROUND_MARGIN - FISH_H * self.cfg["scale"] + 4
        self.cv.create_polygon(x0 + 24, y1 - 1, x0 + 40, y1 - 1, x0 + 30, y1 + 8,
                               fill="#ffffff", outline="", tags="bubble")

    def _draw_fish(self):
        self.cv.delete("fish")
        _, base, s = self._fish_center()
        t = self.t
        cx = APP_W / 2
        # 状态偏移
        oy = 0
        st = self.state
        if st == "idle" or st == "sleep":
            oy = math.sin(t * 2.2) * 4
        elif st == "walk":
            oy = abs(math.sin(t * 9)) * -6
        elif st == "done":
            oy = abs(math.sin(t * 6)) * -18
        by = base + oy  # 鱼底部 y
        d = self.dir
        if st == "sleep":
            oy += math.sin(t * 1.2) * 2

        def X(px):  # 本地坐标 -> 画布坐标（含翻转）
            return cx + px * s * d

        def Y(py):
            return by + py * s

        def ovals(x0, y0, x1, y1, **kw):
            a, b = min(x0, x1), max(x0, x1)
            c, e = min(y0, y1), max(y0, y1)
            self.cv.create_oval(X(a), Y(c), X(b), Y(e), tags="fish", **kw)

        # 尾巴（摆动）
        wag = math.sin(t * 3) * (10 if st in ("idle", "walk") else 3)
        self.cv.create_polygon(
            X(46), Y(-40 + wag * 0.2), X(92), Y(-64 + wag * 0.4), X(96), Y(-40 + wag),
            X(86), Y(-12 + wag * 0.5), X(48), Y(-16), tags="fish",
            fill=C_BODY, outline=C_BODY_D, width=2)
        # 身体
        ovals(-64, -120, 64, 0, fill=C_BODY, outline=C_BODY_D, width=3)
        # 肚皮
        ovals(-40, -30, 40, -4, fill=C_BELLY, outline="")
        # 刘海
        self.cv.create_polygon(
            X(-58), Y(-72), X(-50), Y(-108), X(0), Y(-118), X(50), Y(-108),
            X(58), Y(-72), X(38), Y(-92), X(22), Y(-80), X(0), Y(-92),
            X(-22), Y(-80), X(-38), Y(-92), tags="fish", fill=C_HAIR, outline="")
        # 女仆发带
        self.cv.create_line(X(-56), Y(-92), X(0), Y(-114), X(56), Y(-92),
                            fill="#ffffff", width=max(3, 7 * s), tags="fish",
                            capstyle="round", smooth=True)
        # 蝴蝶结
        ovals(30, -122, 44, -110, fill=C_BOW, outline="")
        ovals(44, -122, 58, -110, fill=C_BOW, outline="")
        ovals(42, -118, 48, -112, fill="#ff6a9b", outline="")
        # 呆毛
        self.cv.create_line(X(-6), Y(-114), X(-2), Y(-128), X(6), Y(-122),
                            fill=C_HAIR, width=max(2, 3 * s), tags="fish", smooth=True)
        # 眼睛
        ey = -78
        if st == "sleep":
            self.cv.create_arc(X(-34), Y(ey - 8), X(-14), Y(ey + 8), start=180,
                               extent=180, style="arc", outline=C_DARK,
                               width=max(2, 3 * s), tags="fish")
            self.cv.create_arc(X(14), Y(ey - 8), X(34), Y(ey + 8), start=180,
                               extent=180, style="arc", outline=C_DARK,
                               width=max(2, 3 * s), tags="fish")
        elif st == "done":
            self.cv.create_arc(X(-34), Y(ey - 8), X(-14), Y(ey + 8), start=0,
                               extent=180, style="arc", outline=C_DARK,
                               width=max(2, 3 * s), tags="fish")
            self.cv.create_arc(X(14), Y(ey - 8), X(34), Y(ey + 8), start=0,
                               extent=180, style="arc", outline=C_DARK,
                               width=max(2, 3 * s), tags="fish")
        else:
            blink = (t % 2.7) < 0.12
            if blink:
                self.cv.create_line(X(-33), Y(ey), X(-15), Y(ey), tags="fish",
                                    fill=C_DARK, width=max(2, 3 * s))
                self.cv.create_line(X(15), Y(ey), X(33), Y(ey), tags="fish",
                                    fill=C_DARK, width=max(2, 3 * s))
            else:
                er = 8 * s
                ovals(-33, ey - 11, -15, ey + 11, fill=C_DARK, outline="")
                ovals(15, ey - 11, 33, ey + 11, fill=C_DARK, outline="")
                ovals(-31, ey - 9, -24, ey - 2, fill="#ffffff", outline="")
                ovals(17, ey - 9, 24, ey - 2, fill="#ffffff", outline="")
        # 腮红
        ovals(-52, ey + 16, -40, ey + 24, fill=C_PINK, outline="")
        ovals(40, ey + 16, 52, ey + 24, fill=C_PINK, outline="")
        # 嘴
        my = -46
        if self.talk and st in ("work", "think"):
            self.cv.create_oval(X(-8), Y(my - 6), X(8), Y(my + 6),
                                fill=C_DARK, outline="", tags="fish")
        else:
            self.cv.create_line(X(-10), Y(my - 2), X(0), Y(my + 4), X(10), Y(my - 2),
                                fill=C_DARK, width=max(2, 3 * s), smooth=True,
                                tags="fish")
        # 小手（干活时一只上下敲）
        tap = math.sin(t * 10) * 4 if st == "work" else 0
        ovals(-76, -26 + tap, -58, -14 + tap, fill=C_BRIGHT, outline=C_BODY_D)
        ovals(58, -26, 76, -14, fill=C_BRIGHT, outline=C_BODY_D)
        # 睡觉 Zzz
        if st == "sleep":
            z1 = (t * 14) % 26
            self.cv.create_text(X(62), Y(-130 - z1), text="Z", font=("Arial", 13, "bold"),
                                fill="#6b8ca6", tags="fish")
            self.cv.create_text(X(74), Y(-146 - z1), text="z", font=("Arial", 9, "bold"),
                                fill="#9db9cc", tags="fish")
        # 思考齿轮
        if st in ("think", "work"):
            gx, gy = X(0), Y(-142)
            self.cv.create_oval(gx - 8 * s, gy - 8 * s, gx + 8 * s, gy + 8 * s,
                                outline="#ff9a2e", width=3, tags="fish")
            ang = t * 3
            for i in range(4):
                a = ang + i * math.pi / 2
                self.cv.create_line(gx + math.cos(a) * 9 * s, gy + math.sin(a) * 9 * s,
                                    gx + math.cos(a) * 13 * s, gy + math.sin(a) * 13 * s,
                                    fill="#ff9a2e", width=3, tags="fish")
        # 出错汗滴
        if st == "error":
            drop = (t * 30) % 16
            ovals(36, -116 + drop, 44, -104 + drop, fill="#7fc0ea", outline="")

    # ---------- 主循环 ----------
    def _loop(self):
        now = time.time()
        dt = min(now - self.last, 0.06)
        self.last = now
        self.t += dt

        if self.selftest and self.t > 2.0:
            self.root.destroy()
            return

        self._poll_state_file()

        # 状态推进
        if self.state not in ("drag", "fly", "think", "work", "error"):
            if self.state in ("walk", "sleep") and now > self.state_until:
                self.state = "idle"
                self.vx = 0
                self.next_decide = now + 2 + random.random() * 3
            if self.state == "idle" and now > self.next_decide:
                self._decide(now)
        elif self.state in ("done", "error") and now > self.state_until:
            self.state = "idle"
            self.next_decide = now + 2
        if self.bubble_text and now > self.bubble_until:
            self.bubble_text = ""

        self._physics(dt)
        self.root.geometry(f"{APP_W}x{APP_H}+{int(self.x)}+{int(self.y)}")
        self._draw_fish()
        self._draw_bubble()
        self.root.after(30, self._loop)

    def run(self):
        self.root.mainloop()


def selftest():
    app = DaFeiYu(selftest=True)
    # 写一条测试状态验证监听
    try:
        os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
        with open(STATE_PATH, "w", encoding="utf-8") as f:
            json.dump({"state": "working", "task": "自检测试", "detail": "", "ts": ""}, f, ensure_ascii=False)
    except OSError:
        pass
    app.run()
    print("SELFTEST_OK")
    return 0


def main():
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    DaFeiYu().run()


if __name__ == "__main__":
    main()
