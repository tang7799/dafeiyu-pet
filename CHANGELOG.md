# Changelog

All notable changes to this project are documented here. Versioning follows SemVer (major.minor.patch).
Developer: **Dudu Studio**

## [1.1.14] - 2026-11-14

### Added (selectable chat brain + custom model, WorkBuddy-style picker)

Previously the fish's model was hard-wired to the first entry of the cloud list (`auto` routing), leaving the owner no say — project work could swing between brilliant and clumsy. The brain menu is now fully reworked, and you can plug in your own model.

- Right-click the fish → ⚙️ Settings → **🧠 Brain**, reworked in the style of the WorkBuddy model selector:
  - **Quick presets** up front: Auto (auto-pick) / Fast / Balanced / Max
  - **All models** scrollable list: every one of the 37 cloud models, each row = name + right-side multiplier (`0.69x` style); zero-cost models automatically get a green "limited-time free" tag; the current pick has a ✓; hover a row for a one-line description
  - Uses the existing cloud quota — **no extra API key registration required**
- **✏️ Configure custom model** (bottom of the menu): connect any OpenAI-compatible endpoint — fill in name (optional) / base URL / API key / model ID and it saves and takes effect immediately. DeepSeek, Zhipu, Tongyi, SiliconFlow, Volcengine Ark, and self-hosted relays all work; **the clean build can chat through this route even with no cloud configuration**
  - Requests are relayed by the main process (immune to browser CORS), with streaming replies, a "🤔 thinking…" placeholder, and mid-stream stop via the send button — the same experience as cloud models
  - Tool calling (drawing / coding / computer control / surfing) keeps working; the key is stored locally in `~/.workbuddy/dafeiyu-brain.json` and never uploaded
  - Zero-key local models work too: for Ollama, set the base URL to `http://127.0.0.1:11434/v1` and leave the key empty
- Thinking models (GLM-5.3 / DeepSeek thinking mode) now show "🤔 thinking…" before the answer arrives, instead of a long blank wait
- If the chosen model is retired from the cloud, the brain falls back to `auto` automatically instead of endlessly requesting a nonexistent model
- The model list is fetched by the chat window from the cloud and cached (`~/.workbuddy/dafeiyu-brain-models.json`) — upgrades don't wipe your configuration

### Fixed

- Clicking "🧠 Brain", "Back to settings", or the theme / murmur / computer-control / command-confirmation rows in the Settings submenu collapsed the whole menu instantly: the submenu rebuilds itself via innerHTML, detaching the very node that was clicked, so the event bubbled up to the window-level closer which misjudged it as "clicked outside the menu". The submenu click handler now tags such events and the closer skips them — menus stay open

### Verification

- `build/_verify_brainui.js` (18 checks): custom-config validation / persistence, menu grouping and tags, dialog pre-fill, a local mock SSE server exercising the custom channel end to end (model / Authorization / system prompt checked item by item, streaming reply delivered intact), menu-click regressions
- `build/_verify_brain.js` (14 checks): cloud brain switching, live chat-window follow-up, **a real GLM-5.3 call returning a reply**, switching back to auto
- Regressions: menus 16/16, chat image attachments 8/8, coding loop 20/20, Creation Studio 18/18; both the normal and clean packaged installers re-verified

## [1.1.13] - 2026-11-14

### Added (drawing/video can now use any platform)
- **Platform registry**: the hard-wired "Zhipu + SiliconFlow" pair became a generic platform table with built-ins **Zhipu / SiliconFlow / Tongyi Wanxiang (Alibaba Bailian) / Volcengine Ark (Jimeng)**; Chinese names and aliases are recognized directly (Tongyi, Wanxiang, Alibaba, Bailian, dashscope, Jimeng, Volcengine, Doubao, seedream…)
- **Connect a platform in one sentence**: say "use Tongyi Wanxiang for drawing, key is sk-xxx" → the fish calls `art_config {"provider":"Tongyi Wanxiang","key":"sk-xxx"}` and it's saved, no baseUrl needed; afterwards `draw_image {"prompt":"...","provider":"Tongyi Wanxiang"}` uses it directly
- **Fully custom endpoints**: `art_config {"provider":"name","key":"...","baseUrl":"https://xxx/v1","model":"model-name"}` creates a platform on the spot — any OpenAI-compatible image service works (self-hosted SD WebUI relays, hosted Flux, Tongyi-compatible mode). A bare domain or root path is auto-completed to `/images/generations` or `/v1/images/generations`
- **Both protocols supported**: OpenAI-compatible synchronous APIs plus Alibaba Bailian async tasks (submit → poll `task_status` → download result); Tongyi Wanxiang text-to-image / text-to-video / image-to-video all use the latter
- **Video platforms are swappable too**: `make_video` / `animate_image` accept `{"provider":"Tongyi Wanxiang"}`; the default remains Zhipu (free). Platforms without video capability say so explicitly
- A named platform **fails loudly instead of silently switching**: if you name one, only that one is used — missing/invalid keys surface the real error; unnamed requests fall back through configured channels in order
- New `art_config` operations: `{"delProvider":"name"}` deletes a custom platform and `{"provider":"name","key":""}` deletes a key (passing only a provider no longer accidentally deletes the key); responses list each platform's `ready` status plus registration links
- Old configurations migrate automatically: `imageApi`/`videoApi` become `providers.custom`, so existing custom endpoints keep working after upgrade

### Fixed
- `draw_image` / `make_video` errors now display platform Chinese names (no more internal ids like zhipu/siliconflow)

## [1.1.12] - 2026-11-14

### Added (the fish can really write code now)
- **`run_cmd` executes commands**: install dependencies, run scripts and tests, use git — returns real `exitCode` / `stdout` / `stderr` so errors can be fixed from the source; supports `cwd` for the project directory and `timeout` (120s default, 10-minute cap)
- **`run_code` runs a quick snippet**: no files needed — throw a temporary python / node / powershell block and get the output back (verify logic, test regexes, check whether a library is installed); language is auto-detected when `lang` is omitted
- **`edit_file` makes precise edits**: replaces exactly the given original text and touches nothing else (no more rewriting whole large files); supports `all:true` global replace, line-number based edits/deletions, CRLF preservation, and garble-free Chinese
  - Refuses to blindly replace text that occurs multiple times and reports the line numbers; when the original isn't found, shows the most similar line for diagnosis
- **The coding loop is closed**: `write_file` → `run_cmd` → read `stderr` → `edit_file` → run again, until exit code 0

### Security
- **Native confirmation dialog before every command**: nothing runs until you click "Allow", and the dialog shows the full command and working directory; only checking "don't ask again" skips it
- **Dangerous commands are hard-blocked**: formatting drives, `diskpart`, editing boot entries, shutdown/reboot, deleting shadow copies, wiping disks, registry deletion, recursively deleting root directories, creating system accounts, killing critical system processes — all refused outright, rephrasing doesn't help
- **New "💻 Command confirmation" setting**: right-click the fish → Settings to switch between "ask every time" and "run without asking" (default: ask every time) — handy for restoring an accidentally checked "don't ask again"

## [1.1.11] - 2026-11-13

### Added (image attachments in chat)
- **Send pictures to the fish**: a 📎 button in the input box, plus **Ctrl+V paste** and **drag-and-drop** into the chat window; multiple images at once; attachments show as a thumbnail strip and can be removed individually
  - Images travel with the message as multimodal content (the fish can actually "see" them) together with the local path (`[image asset: ...]`) — say "make a video from this picture" and she calls `animate_image`, or "set it as wallpaper" for `set_wallpaper`
  - Pathless pasted/dropped images are saved into the gallery upload folder automatically (new `save_image` tool) so the model can retrieve them anytime

### Fixed
- **Auto-retry on Zhipu video rate limits**: when the free video channel reports 429/1305 "traffic too high" during peak hours, it now backs off and retries 3 times (20s/40s/60s) before failing with a friendly message, instead of aborting on the first failure

## [1.1.10] - 2026-11-13

### Fixed (Creation Studio troubleshooting)
- **Pollinations free fallback channel removed entirely**: drawing now goes through Zhipu / SiliconFlow / custom endpoints only — no more hidden last-resort downgrade
- **Errors are no longer swallowed**: previously multi-channel attempts showed only the last channel's error (e.g. Pollinations 402 rate limit), masking the real causes like "key not configured" or "invalid key 401"; now **every channel's real failure reason is aggregated into one message** (e.g. "siliconflow: Token is invalid; zhipu: token expired or verification failed") for instant diagnosis
- With no usable channel at all, the fish guides you to register (with the Zhipu signup link) instead of failing silently

## [1.1.9] - 2026-11-13

### Changed (Creation Studio overhaul)
- **Dual-platform drawing**: `draw_image` now supports **Zhipu cogview-3-flash** (permanently free) and **SiliconFlow Kolors** (free tier), both domestic and directly reachable, with Pollinations demoted to last-resort fallback; channels are picked automatically by configuration (domestic platforms with keys first), with automatic degradation so there's always a picture
- **Real text-to-video**: `make_video` upgraded from "slideshow screen-recording" to **Zhipu cogvideox-flash genuine AI text-to-video** (free, 5–10 seconds, one sentence → a finished clip); submit task → auto-poll → download MP4 into the gallery
- **Image-to-video rechannelled**: `animate_image` switched from fal.ai (needed an overseas key) to **Zhipu image-to-video** (free; local images are auto-converted to base64 for upload)
- **`art_config` goes platform-based**: new `providers` concept — `{"provider":"zhipu","key":"..."}` stores a key (empty deletes), `{"imageProvider":"zhipu|siliconflow|free|custom"}` / `{"videoProvider":"zhipu|none"}` switch channels anytime; keys are always masked in responses, and registration links for unconfigured platforms are attached so the fish can guide you
- Compatible with 1.1.8's legacy `imageApi`/`videoApi` configuration (auto-migrated into the custom channel)

## [1.1.8] - 2026-11-11

### Added
- **The fish's Art Studio** (inspired by community dsh-image-studio / TeaEggPet): the fish can draw and make videos herself
  - **Drawing `draw_image`**: say "draw a blue whale swimming under the stars" in chat and get a picture — free channel by default (zero configuration), or connect your own OpenAI-compatible image endpoint in `art_config` for higher quality without watermarks (auto-fallback to the free channel on failure); the fish plays her celebration animation, the artwork shows right in chat, and you can critique or request a redraw
  - **Video `make_video`**: stitches several drawn (or any local) pictures into a small video with transitions / subtitles / watermark, recorded with Chromium's built-in MediaRecorder (MP4/WebM, zero dependencies)
  - **Image-to-video `animate_image`**: one picture becomes a 5-second real video (fal.ai queue protocol, supports Kling etc., needs a key in `art_config`, auto-polls for the result)
  - **Set wallpaper `set_wallpaper`**: one click turns the fish's artwork into your desktop wallpaper
  - **Gallery `list_art` + menu entry**: all drawings/videos are stored in `~/.workbuddy/dafeiyu-art`; the right-click menu gains "🎨 Art gallery" to open it; `art_config` keys are always masked
- **Click-accuracy overhaul (big computer-control upgrade)**:
  - **`click_text`**: say "click Settings / click Edit" and the fish OCR-locates that text on screen and clicks its center — no coordinates, no misses even after windows moved; small text is auto-tiled and upscaled 2x for recognition
  - **Window-relative clicks**: `mouse_click` supports `title` + in-window offset or `fx/fy` ratio positioning — focuses the window first, then converts coordinates, so dragged windows don't cause misses
  - **Screenshot coordinate auto-conversion**: mouse tools accept `space:"shot"` — coordinates measured on a screenshot are proportionally converted to screen coordinates (previously this was off by 100–200px)
  - **Better window matching**: when a title doesn't match, matching falls back to process name plus common Chinese app aliases (Notepad→记事本 etc., mixed-language titles included)
- **Chat-triggered actions**: command the fish right in the AI chat window — "eat ice cream", "dance", "play violin" and 26 commands total; the model calls the `pet_act` tool and the desktop pet performs the matching animation in real time
  - 6 food actions reuse the feeding pipeline (dropping food → eating → spinning); 20 performance actions (dance / violin / somersault / backflip and more)
  - She wakes from edge-resting/sleep and returns to position automatically before acting; mood +8 afterwards; unknown actions are safely refused
- **Self-taught actions (`pet_teach`)**: when the fish doesn't know a move you ask for, the model "choreographs" on the spot — wrapping the closest existing clip as a new action (new name + lines + effect expression); she remembers it permanently (stored locally) and uses it directly next time; `pet_act` supports Chinese colloquial aliases and fuzzy matching, plus a fix for act parameters getting lost
- **Keyboard-aware companionship** (BongoCat-inspired): after detecting 8 minutes of continuous owner activity, the fish starts "working" too (coding animation), occasionally cheering you on, and stops when you leave (toggle in Settings)
- **CPU-status fish** (RunCat-inspired): the main process samples CPU every 10 seconds; at ≥85% twice in a row the fish jolts awake / fans herself and complains; the menu shows live usage (reacting can be disabled)
- **Water reminders** (dsh-fat-fish-inspired): every 45 minutes she nags you to drink water; double-click her head to log a glass; the menu shows today's count
- **Time-of-day greetings + holiday easter eggs**: good morning / lunch / late-night bedtime nudges / happy Friday — once per line per day; New Year, Spring Festival, Lantern Festival, Mid-Autumn, Christmas and more have dedicated lines
- **Rapid-click annoyance** (dsh-pet-dafeiyu-inspired): click the fish 3 times within 1.6 seconds and she gets angry, mood -3
- **Daily usage meter** (XT-nya fork inspired): today's conversation count and input/output token usage at the bottom of the chat window (shown when the channel reports usage)

### Improved
- **OCR accuracy**: screenshot compression tightened (full-screen JPEG q88, partial shots lossless PNG), recognition upscaled 200% beforehand, prompt now insists "always use ocr_screen for reading text" — no more wild guesses
- **Hit testing**: mouse response area tightened from a rectangle + 22px tolerance to per-pixel alpha sampling — the pointer cursor / grab / right-click affordances appear only when the mouse is truly over the fish's body
## [1.1.7] - 2026-11-10

### Added
- **Autonomous surfing**: the pet can now patrol Bilibili on its own on a schedule (toggle in Settings, 30-minute default interval; the fish can self-adjust between 10–180 minutes via `surf_interval`)
  - Long-term memory: three plain-text memory files under `~/.workbuddy/dafeiyu-memory/` (video memory / comment memory / surf log) for cross-task deduplication — no re-watching, no re-commenting
  - Self-adjusting pace: patrols more frequently when content is fun, stretches the interval when bored; automatically rests between 23:00–07:00 with the interval pushed to ≥60 minutes; hard cap of 24 rounds per day (enforced in code, not left to the model)
  - Comment permission: commenting is disabled during surf rounds by default and must be explicitly authorized by the owner; once enabled, risk controls still apply — 1 comment per video, ≤3 per day, ≥15 minutes apart, plus a confirmation dialog for every comment
  - Pet integration: a new `EVENT:` protocol makes the fish glance around / hum while watching videos / perk up to think / curtsy before writing a comment / stretch when the round ends
- Right-click menu gains "🐟 Let the fish surf" (start a round now); Settings submenu gains "🌊 Autonomous surfing" toggle
- New chat tools: `memory_search` / `memory_write` / `comment_perm` / `surf_interval`; `schedule_add` supports a new `surf` task type

### Fixed
- 20-minute watchdog for surf rounds: a stuck round automatically releases its state so risk-control status never lingers
- Surfing entry points are blocked with a hint when computer control is disabled

## [1.1.6] - 2026-11-09

### Added
- Feeding animation completion: grew from 4 to 6 eating animations (rice / Token / snacks / ice cream / tangyuan / hotpot); clicking "Feed" picks one at random with matching food icon and lines

### Fixed
- The chat window no longer displays the model's content-safety self-check marker (`<ds_safety>…</ds_safety>` leaking into bubbles): paired tags are stripped, half-delivered streaming tags are cut off, and local history / conversation context both use the sanitized text

## [1.1.5] - 2026-11-09

### Added
- **Hover mode**: when enabled, dragging the fish with the left button places her anywhere on screen without triggering a fall; disabling restores gravity (Settings submenu toggle, off by default)
- "👀 Look at the screen" and "🖱️ Mouse-circle demo" moved from the Settings submenu to the main menu

## [1.1.4] - 2026-11-09

### Added
- **Feeding** 🍚: click the menu item and food drops from the top of the window → eating → happy spin, mood +15
- **Pomodoro** 🍅: reads system idle time every minute — reminds you to rest after 25 minutes of continuous activity, and grumbles about slacking when you idle 5–45 minutes (optional)
- **Mood system** ❤️: mood decays 6 per hour; interaction +2 (60s throttled) / feeding +15 / chatting +8; below 18 the fish switches to cold, distant lines
- **Weather briefing** ☁️: first meeting between 06:00–10:00 each day reports the weather plus umbrella advice (five weather categories, deduplicated across days)

### Fixed
- Settings submenu rows missing their state values (menu is refreshed after the rows are built)

## [1.1.3] - 2026-11-09

### Added
- **Menu window-expansion mode**: right-click menus / submenus / rename / about dialogs no longer cover the fish — right-clicking temporarily enlarges the window, the menu floats above the fish (vertically separated), and the whole window is clamped inside the screen (fixes overflow on left/right edges)

### Fixed
- Windows `resizable:false` windows could only grow via `setSize`, never shrink: the main process temporarily toggles resizable and restores it
- All menus now use measured `offsetWidth/offsetHeight` positioning instead of hard-coded values

## [1.1.2] - 2026-11-09

### Fixed
- The "Exit" item in the right-click menu was cut in half (hard-coded window height → positioning by actual menu height, covering menu / rename / about)

## [1.1.1] - 2026-11-07

### Improved
- Idle edge-resting: no longer lies on the bottom edge (candidate edges are top/left/right only), and the whole move is hidden (fade out in place for 0.2s → teleport into place → fade in); rotation and mirroring now use dedicated CSS properties to avoid transform stacking errors

## [1.1.0] - 2026-11-07

### Added
- Unified copyright notice: `Copyright © 2026 Dudu Studio. All Rights Reserved.` covering exe properties, the NSIS wizard, the pet's About dialog, the chat window footer and the log header

### Fixed
- NSIS installer crashed instantly on "Install" (nsDialogs.dll compatibility on this machine): the custom wizard page was removed entirely; auto-start on boot is now written to HKCU Run by default (toggleable in the pet menu)
- "View weather" rendered raw HTML → now renders proper Chinese weather
- Hop animation scales with body size, launch-hitbox after resizing, asymmetric left/right roam range, accidental launches on single/right click, and a batch of physics fixes

### Added
- **Idle edge-resting**: the fish automatically lies down on a screen edge when idle (feature first introduced)

## [1.0.0] - 2026-11-06

First installer release.

### Added
- **The pet**: Electron transparent always-on-top frameless window with an official-style chibi whale-girl (37 webm clips), state-machine driven (idle breathing / sleep / thinking / working / done / error / drag / hop) with random idle micro-actions
- **Physics interaction**: drag & throw (gravity + bounce + fling), resize, 4 color themes, rename, murmur bubbles, right-click menu with 25 on-demand animations
- **AI chat window**: WorkBuddy cloud SDK streaming replies, animated mouth while talking, stop mid-generation, clear conversation
- **Computer control tools**: mouse & keyboard, screenshot + OCR, DOM-level browser automation, file read/write, app launching
- **Bilibili capabilities**: video summaries (subtitles + frames), uploader rankings, reading comments, posting comments (confirmation dialog, human-approved)
- **WorkBuddy integration**: agent state mapped to pet animations in real time (thinking / working / done / error)
- **Installer**: NSIS wizard (x64, choose directory, desktop/start-menu shortcuts), with a clean build (no account configuration) in addition to the bundled one
