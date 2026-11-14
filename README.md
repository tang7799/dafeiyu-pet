<div align="center">

<img src="docs/images/logo.png" width="120" alt="Dafeiyu Pet"/>

# Dafeiyu Pet (大肥鱼桌宠)

A chubby blue whale-girl who lives on your Windows desktop and eats rice.

`v1.1.14` · Electron 45 · Windows x64 · Developer **Dudu Studio**

> 🇨🇳 中文文档：[AtomGit mirror](https://atomgit.com/jettyjoy/dafeiyu-pet)

</div>

---

A DeepSeek "Big Fat Fish" (dsh-pet) style desktop pet: a transparent always-on-top window with an official-style chibi whale-girl driven by webm animations. She strolls around, sleeps, slacks off, and lets you drag and toss her around. Hook her up to AI and she can also **chat with you, operate your computer, draw pictures and make videos, write code, watch Bilibili videos and summarize them, and even surf the web on her own**.

<div align="center">
<table>
<tr>
<td align="center"><img src="docs/images/pet.png" width="220" alt="Desktop pet"/><br/><sub>The pet herself (chibi whale-girl, webm-driven)</sub></td>
<td align="center"><img src="docs/images/chat.png" width="220" alt="Chat window"/><br/><sub>AI chat window (streaming replies)</sub></td>
</tr>
</table>
</div>

## ✨ Features

### 🐟 The pet itself
- **State-machine animations**: idle breathing, sleeping (fall asleep → loop → wake up), thinking, working, celebration, error, drag struggling, hopping and more — all official-style transparent webm clips with cross-fading between two video layers
- **Physics interaction**: drag & throw (gravity + bouncing + flinging), resize, idle edge-resting (automatically lies down on the top/left/right screen edge, moving with fade-out → teleport → fade-in)
- **Right-click menu**: play animation (25 official clips on demand), AI chat, weather, feeding, hopping, sleep, settings submenu, rename, color themes (classic blue / sakura pink / matcha green / grape purple), auto-start on boot, exit
- **Feeding** 🍚: click once and food drops from the top of the window — one of **6 random eating animations** (rice / Token / snacks / ice cream / tangyuan / hotpot), followed by a happy spin
- **Mood system** ❤️: mood decays over time and is restored by interaction / feeding / chatting; when it gets too low the fish turns cold and distant
- **Pomodoro** 🍅: reads system idle time every minute — reminds you to rest after 25 minutes of continuous activity, and complains about slacking if you idle for 5–45 minutes (optional)
- **Weather briefing** ☁️: on first meeting each morning, reports the weather and umbrella advice (wttr.in)
- **Hover mode** 🪁: toggle it on and the fish stays wherever you drop her, no falling; toggle off to restore gravity
- **Murmuring** 💬: random speech bubbles while idle
- **Companionship extras**: works alongside you when you keep typing (BongoCat-inspired), complains when your CPU runs hot (RunCat-inspired), water-drinking reminders, time-of-day greetings and holiday easter eggs, gets angry if you rapidly click her 3 times

### 💬 AI chat window
- Streaming replies, animated mouth while talking, stop mid-generation, clear conversation, local history persistence
- Dedicated whale-girl persona (soft and cuddly, calls tokens "rice bowls"), natural spoken-style constraints (no Markdown / emojis / role-play brackets)
- Tool calling: the fish can invoke all the "computer control" tools below while chatting
- **🧠 Brain picker** (new in v1.1.14): right-click the fish → Settings → Brain — a WorkBuddy-style model selector with quick presets (Auto / Fast / Balanced / Max) plus a scrollable list of all 37 cloud models, each row showing its credit multiplier (`0.69x` style), a green "limited-time free" tag for zero-cost models, and a ✓ on the current one. Switching takes effect instantly, no chat-window restart needed
- **✏️ Custom model** (new in v1.1.14): connect any OpenAI-compatible endpoint — DeepSeek, Zhipu, Tongyi, SiliconFlow, Volcengine Ark, self-hosted relays, or a local Ollama. Just fill in base URL + API key + model ID; requests are relayed by the main process so browser CORS never gets in the way. The clean build can chat through this route even without any cloud configuration
- **Send images** (new in v1.1.11): 📎 button / Ctrl+V paste / drag-and-drop into the chat window — the model can actually "see" the picture, and it is stored in the art gallery for the drawing tools to reference
- **Daily usage meter** (new in v1.1.11): today's conversation count and input / output tokens shown at the bottom of the chat window

### 🎨 Creation Studio: drawing & video (one sentence in chat gets it done)
- **Drawing**: say "draw a whale-girl in the snow" and the artwork lands in `~/.workbuddy/dafeiyu-art`, with a one-click "set as wallpaper"
- **Video**: text-to-video and image-to-video (turn a gallery picture into a moving clip), MP4 saved automatically
- **Swappable platforms** (new in v1.1.13): built-in **Zhipu / SiliconFlow / Tongyi Wanxiang (Alibaba Bailian) / Volcengine Ark (Jimeng)** — say "use Tongyi Wanxiang for drawing, my key is sk-xxx" and it is saved on the spot. Fully custom platforms are supported too, with both OpenAI-compatible and Alibaba Bailian async protocols. When you name a platform, that one is used strictly — on failure you get the real error instead of a silent channel switch
- **Aggregated errors** (new in v1.1.10): when multiple channels are tried, every platform's real failure reason is reported in one message, so an invalid key is obvious at a glance

### 💻 Let the fish write code (new in v1.1.12)
- In chat, the fish can run shell commands (`run_cmd`), execute Python / Node scripts (`run_code`), and make precise file edits (`edit_file`) — completing the whole loop of "write a script → run it → read the error → fix it → run it green" on her own
- Dangerous commands (formatting, registry edits, shutdown, …) are blocked at code level; every command run pops a native confirmation dialog with a "don't ask again" checkbox (resettable in Settings)
- UTF-8 output never garbles Chinese, and Windows CRLF line endings are preserved exactly

### 🖥 Computer control (34 tools, callable from chat)
- Mouse & keyboard: move / click / scroll / drag / type / key presses
- Screen understanding: screenshots + OCR (including `click_text` — OCR-locate and click on-screen text without coordinates)
- Browser: open bookmarked URLs, read page DOM, click, type, scroll, fetch any URL
- Files & apps: read/write files, list directories, move/create, open apps or files and focus their windows
- Bilibili suite: video summaries (with subtitles & frames), uploader video rankings, read comments, post comments (with a confirmation dialog before publishing — always human-approved)
- Scheduled tasks: daily HH:MM / every N minutes / one-shot reminders or autonomous tasks
- Long-term memory: `memory_search` / `memory_write` — remembers watched videos and posted comments across sessions

### 🌊 Autonomous surfing (new in v1.1.7)
Turn on the "Autonomous Surfing" switch and the fish will browse Bilibili on her own at your chosen interval:
- **Checks memory first**: only watches videos she hasn't seen, never double-posts a comment
- **Self-adjusting pace**: patrols more frequently when content is fun, stretches the interval when bored; automatically rests between 23:00 and 07:00
- **Hard-coded guardrails** (not left to the model's self-discipline): max 24 rounds per day; comments disabled by default (require explicit authorization), even when enabled: 1 comment per video, ≤3 per day, ≥15 minutes apart, and every comment pops a confirmation dialog for you to approve
- **Desktop-pet reactions**: while surfing she glances around, hums "watching a video…", curtsies before writing a comment, and stretches when the round ends

### 🔗 WorkBuddy integration
- With the companion WorkBuddy skill (`dfy_state.py`), the pet switches to thinking / working / done / error animations in real time while an agent works, and celebrates when the job is done

## 🚀 Quick start

1. After installing, right-click the fish on your desktop: **💬 AI Chat** opens the chat window and you'll get a reply to your very first message
2. Give her jobs in plain words: `draw a whale-girl in the snow`, `summarize this Bilibili video BV1xxx`, `write a script to organize my Downloads folder`, `remind me to drink water at 9 every morning`
3. Explore the right-click menu: 🎬 play animations (25 clips), 🍚 feed, ⚙️ Settings (color themes / auto-start / hover mode / pomodoro / water reminders / brain picker…)

## 🔑 AI capabilities & API key setup

Every AI feature needs a "brain". The clean build ships with no built-in account — pick one of the three routes below:

### Route A: WorkBuddy cloud configuration (recommended — one key unlocks all 37 cloud models)

1. Register / log in to the WorkBuddy cloud service and get your own **service address + public key** (starts with `wbpk_`)
2. Open the chat window, click the **⚙** button in the top-right corner, paste them in and save — you can chat right away
3. Cloud models route through `auto` automatically; you can also right-click the fish → Settings → **🧠 Brain** and pick your own (GLM-5.3 / DeepSeek / Kimi / MiniMax etc., free tiers included) — switching takes effect instantly

### Route B: Custom model (your own API key, no WorkBuddy needed)

1. Right-click the fish → ⚙️ Settings → **🧠 Brain** → **✏️ Configure custom model** at the bottom
2. Fill in four fields:
   - **Name**: anything you like (optional)
   - **Base URL**: an OpenAI-compatible endpoint, usually ending in `/v1` — e.g. `https://api.deepseek.com/v1`, `https://open.bigmodel.cn/api/paas/v4`
   - **API key**: the key from that platform's console
   - **Model ID**: e.g. `deepseek-chat`, `glm-4.7`
3. Saving takes effect immediately; chat and tool calls all go through your key. The key is stored only in local `~/.workbuddy/dafeiyu-brain.json`
4. Zero-key option: install [Ollama](https://ollama.com) locally and `ollama pull qwen3`, then set base URL to `http://127.0.0.1:11434/v1`, leave the key empty, and use `qwen3` as the model ID

### Route C: Drawing / video (Creation Studio keys — independent from chat keys)

1. Register at the [Zhipu open platform](https://open.bigmodel.cn) (free) and copy your key from the API Keys page
2. Tell the fish: `configure drawing platform, Zhipu, key is YOUR_KEY` — that single key unlocks both drawing (cogview-3-flash) and video (cogvideox-flash) **on their free tiers**
3. To switch platforms: `use Tongyi Wanxiang for drawing, key is sk-xxx` (Tongyi / SiliconFlow / Volcengine Ark / custom endpoints supported, see the feature list above)
4. Configuration is stored in `~/.workbuddy/dafeiyu-art.json`; to move to another computer, just copy the brain / art JSON files over

> The three routes don't conflict: use only A, or combine B + C (chat with your own DeepSeek key while drawing/video run on Zhipu's free tier).

## 📦 Installation

1. Download **`DafeiyuPet-Clean-Setup-1.1.14.exe`** (~132 MB) from [Releases · v1.1.14](https://github.com/tang7799/dafeiyu-pet/releases/tag/v1.1.14)
   - Direct link: [releases/download/v1.1.14/DafeiyuPet-Clean-Setup-1.1.14.exe](https://github.com/tang7799/dafeiyu-pet/releases/download/v1.1.14/DafeiyuPet-Clean-Setup-1.1.14.exe)
   - Mirror: [AtomGit jettyjoy/dafeiyu-pet](https://atomgit.com/jettyjoy/dafeiyu-pet)
2. Run the NSIS installer (choose the install directory; auto-start on boot is enabled by default and can be turned off in the pet's settings)
3. Launch it and right-click the fish that appears on your desktop — follow "Quick start" above, and set up AI via one of the three routes in "API key setup"

> **Clean vs bundled build**: the clean build ships without any cloud account configuration — set up AI via one of the three routes above (the custom-model route doesn't even need a WorkBuddy key). The bundled build contains the developer's own configuration and is not distributed.
> Requirements: Windows 10 / 11 x64. Installer sha256: `5ba54b528c27f48da75b16952abca93360fde6e92e1f9a5c6376c194ac860191`

## 🛠 Local development

```bash
cd desktop/electron
npm install          # Electron 45 + electron-builder 24
npm start            # run the pet directly
npm run dist         # build the bundled installer
npm run dist:clean   # build the clean installer (leak scan + source restore)
```

End-to-end verification scripts (CDP assertions; pass a packaged directory to test the built artifact):

```bash
node build/_verify_menu.js       # menu positioning / window expansion (16 checks)
node build/_verify_v114.js       # feeding / pomodoro / mood / weather (27 checks)
node build/_verify_v115.js       # hover mode (11 checks)
node build/_verify_surf.js       # autonomous surfing (25 checks)
node build/_verify_surf_unit.js  # surfing unit tests (19 checks)
node build/_verify_code.js       # coding loop: run_cmd / run_code / edit_file (20 checks)
node build/_verify_art.js        # Creation Studio drawing / video channels (18 checks)
node build/_verify_providers.js  # drawing platform registry (34 checks, local mock)
node build/_verify_brain.js      # brain switching (14 checks, incl. real cloud call)
node build/_verify_brainui.js    # brain menu rework + custom model (18 checks, local mock SSE)
node build/verify-clean.js       # clean-build leak audit
```

### Repository layout

```
desktop/electron/
├── main.js        # main process: windows, IPC, task dispatch, system idle time
├── pet.html       # pet renderer: state machine, physics, menus, animation scheduling
├── chat.html      # chat renderer: streaming conversation, tool loop, surfing prompt
├── preload.js     # contextBridge bridge
├── pc.js          # registry of 34 computer-control tools + scheduled-task engine
├── surf.js        # autonomous surfing: memory files, risk-control counters, round state
├── bili.js        # Bilibili: QR login, videos / comments / rankings
├── video.js       # video summaries (subtitles + frames)
├── browser.js     # DOM-level browser automation
├── office.js / pdf.js / ocr_win.ps1  # local content processing
├── assets/anims/  # 37 official-style webm animation clips
└── build/         # packaging scripts + full verification suite
```

## 📜 Changelog

See [CHANGELOG.md](CHANGELOG.md) (complete history from v1.0.0 to v1.1.14). Chinese docs mirror: [AtomGit jettyjoy/dafeiyu-pet](https://atomgit.com/jettyjoy/dafeiyu-pet).

## ⚠️ Notes & credits

- The character and animation assets come from the open-source project **dsh-pet** (PC2005-cloud/dsh-pet, character by 上善无形 / ZipZipPipe), licensed under **CC BY-NC-SA 4.0** (non-commercial), see [assets/CREDITS.md](desktop/electron/assets/CREDITS.md)
- This project is a fan-made study clone and is not affiliated with DeepSeek
- Autonomous surfing continuously consumes tokens from whatever LLM service you configure — toggle it off when you don't need it
- Please follow the Bilibili community rules: the comments-disabled-by-default, human-approved-per-comment design must not be bypassed

## License

Copyright © 2026 Dudu Studio. All Rights Reserved.
