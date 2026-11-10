import os, urllib.parse, urllib.request, concurrent.futures, sys

BASE = "https://cdn.jsdelivr.net/gh/PC2005-cloud/dsh-pet@main/dsh-pet/assets/webm/"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "anims")
os.makedirs(OUT, exist_ok=True)

MAPPING = [
    ("待机呼吸休闲", "idle_breath"),
    ("东张西望", "look_around"),
    ("睡觉-开始", "sleep_start"),
    ("睡觉-循环", "sleep_loop"),
    ("睡觉-起来", "sleep_wake"),
    ("工作状态-思考冒泡", "think"),
    ("工作状态-忙碌点按", "work"),
    ("写代码", "work_code"),
    ("工作状态-雀跃庆祝", "done"),
    ("工作状态-垂头叹气冒汗", "error"),
    ("被鼠标拖拽悬空反馈", "drag"),
    ("点击回应-元气挥手", "pat_wave"),
    ("点击回应-开心跃动", "pat_happy"),
    ("打瞌睡被惊醒", "startle"),
    ("吃白饭", "eat_rice"),
    ("吃Token", "eat_token"),
    ("吃冰淇淋融化", "eat_icecream"),
    ("吃汤圆", "eat_tangyuan"),
    ("大口吃零食", "eat_snack"),
    ("涮火锅", "eat_hotpot"),
    ("超大伸懒腰", "stretch"),
    ("可爱宅舞", "dance"),
    ("轻快摇摆舞", "sway"),
    ("小幅度原地360度旋转展示", "spin"),
    ("女仆屈膝礼仪", "bow"),
    ("鲸鱼吐泡泡特效", "bubble"),
    ("哈欠连天", "yawn"),
    ("悠闲哼歌", "sing"),
    ("玩水枪", "watergun"),
    ("撸猫", "cat"),
    ("摇扇纳凉", "fan"),
    ("堆雪人", "snowman"),
    ("放风筝", "kite"),
    ("荡秋千", "swing_ride"),
    ("骑木马", "horse"),
    ("吹笛子", "flute"),
    ("小提琴演奏", "violin"),
]

def fetch(item):
    zh, name = item
    dest = os.path.join(OUT, name + ".webm")
    if os.path.exists(dest) and os.path.getsize(dest) > 20000:
        return ("skip", name, os.path.getsize(dest))
    url = BASE + urllib.parse.quote(zh + ".webm")
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=90) as r:
                data = r.read()
            if len(data) < 20000:
                raise ValueError("too small " + str(len(data)))
            with open(dest, "wb") as f:
                f.write(data)
            return ("ok", name, len(data))
        except Exception as e:
            if attempt == 2:
                return ("fail", name, str(e))
    return ("fail", name, "unknown")

with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
    for res in ex.map(fetch, MAPPING):
        print(res[0], res[1], res[2], flush=True)

files = [f for f in os.listdir(OUT) if f.endswith(".webm")]
total = sum(os.path.getsize(os.path.join(OUT, f)) for f in files)
print("DONE", len(files), "files", round(total / 1048576, 1), "MB", flush=True)
