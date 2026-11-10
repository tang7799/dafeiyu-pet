<div align="center">

<img src="docs/images/logo.png" width="120" alt="Dafeiyu Pet"/>

# Dafeiyu Pet (大肥鱼桌宠)

A chubby blue whale-girl who lives on your Windows desktop and eats rice.

`v1.1.7` · Electron 45 · Windows x64 · Developer **Dudu Studio**

> 🇨🇳 中文文档：[AtomGit mirror](https://atomgit.com/jettyjoy/dafeiyu-pet)

</div>

---

A DeepSeek "Big Fat Fish" (dsh-pet) style desktop pet: a transparent always-on-top window with an official-style chibi whale-girl driven by webm animations. She strolls around, sleeps, slacks off, and lets you drag and toss her around. Hook her up to AI and she can also **chat with you, operate your computer, watch Bilibili videos and summarize them, and even surf the web on her own**.

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

### 💬 AI chat window
- Streaming replies, animated mouth while talking, stop mid-generation, clear conversation, local history persistence
- Dedicated whale-girl persona (soft and cuddly, calls tokens "rice bowls"), natural spoken-style constraints (no Markdown / emojis / role-play brackets)
- Tool calling: the fish can invoke all the "computer control" tools below while chatting

### 🖥 Computer control (34 tools, callable from chat)
- Mouse & keyboard: move / click / scroll / drag / type / key presses
- Screen understanding: screenshots + OCR
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

## 📦 Installation

1. Download **`DafeiyuPet-Clean-Setup-1.1.7.exe`** (~132 MB) from [Releases · v1.1.7](https://github.com/tang7799/dafeiyu-pet/releases/tag/v1.1.7)
   - Direct link: [releases/download/v1.1.7/DafeiyuPet-Clean-Setup-1.1.7.exe](https://github.com/tang7799/dafeiyu-pet/releases/download/v1.1.7/DafeiyuPet-Clean-Setup-1.1.7.exe)
   - Mirror: [AtomGit jettyjoy/dafeiyu-pet](https://atomgit.com/jettyjoy/dafeiyu-pet)
2. Run the NSIS installer (choose the install directory; auto-start on boot is enabled by default and can be turned off in the pet's settings)
3. Launch it and right-click the fish that appears on your desktop

> **Clean vs bundled build**: the clean build ships without any cloud account configuration — before chatting / surfing you need to fill in your own service address and public key via the ⚙ button in the chat window. The bundled build contains the developer's own configuration and is not distributed.
> Requirements: Windows 10 / 11 x64. Installer sha256: `eaeee1e4ca17bdd37a2d5c7898ea2bc40497cdfe8b1b0eb5645eba14fdf41102`

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

See [CHANGELOG.md](CHANGELOG.md) (complete history from v1.0.0 to v1.1.7). Chinese docs mirror: [AtomGit jettyjoy/dafeiyu-pet](https://atomgit.com/jettyjoy/dafeiyu-pet).

## ⚠️ Notes & credits

- The character and animation assets come from the open-source project **dsh-pet** (PC2005-cloud/dsh-pet, character by 上善无形 / ZipZipPipe), licensed under **CC BY-NC-SA 4.0** (non-commercial), see [assets/CREDITS.md](desktop/electron/assets/CREDITS.md)
- This project is a fan-made study clone and is not affiliated with DeepSeek
- Autonomous surfing continuously consumes tokens from whatever LLM service you configure — toggle it off when you don't need it
- Please follow the Bilibili community rules: the comments-disabled-by-default, human-approved-per-comment design must not be bypassed

## License

Copyright © 2026 Dudu Studio. All Rights Reserved.
