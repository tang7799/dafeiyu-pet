# Changelog

All notable changes to this project are documented here. Versioning follows SemVer (major.minor.patch).
Developer: **Dudu Studio**

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
