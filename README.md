# TaktLight

**TaktLight** (*Takt* = musical beat and deterministic clock cycle) is an offline-first, Ethernet-native DMX512 lighting controller and show designer built with **Tauri v2 (Rust + React/TypeScript)**.

Designed as a streamlined studio lighting controller inspired by the **Daslight 5** workflow, TaktLight focuses on Ethernet lighting rigs: a deterministic **44 Hz Rust real-time engine**, **Art-Net v4** and **sACN (ANSI E1.31)** output, native **Open Fixture Library (OFL) `.json`** profiles, a **2D spatial fixture grid**, a normalized **float Trait-Space Mixer**, procedural **1D/2D FX blocks**, **Scene Sequences**, **Live Busking controls**, and audio-synced **Timelines** with offline transient detection.

---

## Core Features

* **Offline-First Ethernet DMX Engine (Rust):**
  * Runs completely offline with zero cloud dependencies, automatic `OfflineSink` fallback when a network adapter drops, and periodic NIC reconnection.
  * **Art-Net v4 (`UDP 6454`):** Unicast and Broadcast `ArtDmx` (`0x5000`), unicast-aware multi-universe frame sync via `ArtSync` (`0x5200`), and continuous multi-port node discovery via `ArtPoll` / `ArtPollReply` (keyed by IP and `BindIndex`).
  * **sACN / ANSI E1.31 (`UDP 5568`):** Multicast (`239.255.x.x`) and Unicast streaming with configurable universe priorities and non-blocking 3-packet `Stream_Terminated` pacing.
  * **DMX Monitor, Channel Park, Locate & Telemetry:** Real-time 512-channel byte inspector per universe (`DEC` / `HEX` / `PCT`) with patched fixture/channel ownership, channel parking/override, one-click fixture Locate/Identify, microsecond frame-time jitter histogram, and live `NET ERR` socket diagnostics.
* **Open Fixture Library (OFL) `.json` & In-App Fixture Builder:**
  * Uses the open-source **Open Fixture Library (OFL) JSON schema** natively with offline JSON Schema validation, visual builder mode, and raw JSON editing.
  * Ships with **RLCV3** (`fixtures/user/rlcv3.json`, a 24-segment RGB LED tube with 1–24 segment modes up to 73ch) as the single built-in **standard fixture profile**, plus local user profiles stored under `%APPDATA%\TaktLight\fixtures\user\`.
  * Supports `Intensity` (8-bit and 16-bit fine), `ColorIntensity` (`Red`, `Green`, `Blue`, `White`, `Warm White`, `Cold White`), `ShutterStrobe`, and `WheelSlot` capabilities, including multi-cell pixel bars (`matrix.pixelCount`, `pixelGroups`, and `templateChannels`).
* **Interactive 2D Fixture Grid & Referenceable Palettes:**
  * Pan/zoom 2D stage canvas with negative-coordinate support, optional grid snapping, auto-fit framing, multi-fixture selection, and live per-cell color/dimmer preview.
  * 1D selection ordering (`Left to Right`, `Symmetrical Center Out`, `Mirror`, `Odd/Even`) and 2D $(X, Y)$ spatial mapping with interactive 2D shader gizmos.
  * **Referenceable Palettes:** Scenes and FX blocks reference named multi-stop `<ColorPalette>` and `<DimmerPalette>` presets so palette edits propagate across the show.
* **Normalized Float Trait-Space Mixer (`f32`) & Gamma Calibration:**
  * Active scenes, sequences, timelines, and live controls blend in normalized `0.0..1.0` trait space (`HTP` for dimmer, `LTP` crossfade for base traits, `Relative +/-` modulation for layered FX) before quantizing to DMX bytes or nearest Color Wheel slots.
  * **Per-Fixture Calibration:** Configurable gamma curve ($\gamma = 2.2$), dimmer min/max deadzone clamping, and RGBW white-channel extraction modes.
* **Procedural 1D & 2D FX Engine:**
  * **Static & Fanning:** Linear and symmetrical gradients across fixture groups.
  * **Step Chases:** Multi-step sequences with configurable hold and fade durations.
  * **1D Curve Oscillators:** `Sine`, `Triangle`, `Saw`, `Square`, and `Pulse` generators with phase spread (`0° to 360°`).
  * **2D Spatial Matrix Shaders:** `Linear Sweep`, `Radial Wave`, `Plasma`, and `Pinwheel` effects sampled at each cell's $(X, Y)$ canvas position.
  * **Dual Timing Modes:** Driven by absolute time (`Hz` / `Seconds`) or musical tempo (`BPM` / `Beats`) with tap tempo.
* **Scenes, Scene Sequences & Live Busking:**
  * Bank-organized scenes with exclusive or stackable bank playback, per-scene fade in/out, and multi-step **Scene Sequences** with hold/crossfade transitions.
  * **Live Busking Group Mixer Strips:** Per-group dimmer, hue shift, saturation, strobe, full/flash, and blackout overrides plus customizable keyboard bindings (`KeyBindings`).
* **Multi-Track Timelines & Offline Transient Detection:**
  * DAW-style multi-track Timeline synchronized to `.wav` (16/24-bit PCM, 32-bit float), `.mp3`, `.flac`, `.ogg`, `.m4a`, `.aac`, and `.opus` audio via Web Audio API playback locked to the Rust engine's `InterpolatedAudioClock`.
  * Drag-and-drop audio and scene/FX clips, automatic track creation, beat/seconds grids, time-stretch resizing, and missing-audio relinking with folder scan and SHA-256 verification.
  * **Offline Spectral-Flux Transient Detection:** Streaming radix-2 FFT dual-band analyzer (`40–140 Hz` kick and `1.5–8 kHz` snare) with autocorrelation BPM estimation and kick auto-fill snapping.
* **Reliability, Autosave & Diagnostics:**
  * Automatic `.autosave` snapshots triggered every 20 edits or 60 seconds with one-click crash recovery on startup.
  * Rolling production log file (`%APPDATA%\TaktLight\logs\taktlight.log`, 2 MiB rotation), Rust panic hook, React `ErrorBoundary`, and global frontend error reporting.
* **Future Roadmap:**
  * Moving-light expansion: 16-bit `Pan/Tilt` traits, XY Pad, Lissajous motion curves, and per-fixture physical stage bounds (`<StageBounds>`).
  * Local API / MCP interface for external scripting and automation.

---

## Architecture Documentation

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for system architecture, OFL `.json` and `.takt.xml` schemas, and the 4-stage 44 Hz Rust pipeline.

---

## Tech Stack

* **Backend / Real-Time Core:** Rust (`Tauri v2`, `tokio`, `socket2`, `spin_sleep`, `parking_lot`, `arc-swap`, `serde_json`, `jsonschema`, `quick-xml`, `sha2`, `if-addrs`, `rfd`)
* **Frontend / Studio UI:** React, TypeScript, Zustand, Tailwind CSS, HTML5 2D Canvas, Web Audio API
* **Design System:** Another German Engineer (AGE) Design System V1.0 (`VOID #0A0F18`, `PITCH #0D1117`, `SLATE_DARK #111827`, `SLATE #1A2535`, `STEEL #4A5A6A`, `MIST #E8EEF6`, `FOG #8898A8`, `EMBER #FF5500`, `COBALT #2255AA`, `PLUM #8833AA`, `PINE #1E6B35`, `SIGNAL #CC0000`; `DM Sans` + `Fira Code`)

---

## Building, Testing & Versioning

### Prerequisites
* **Rust toolchain** (`rustup`, `cargo`)
* **Node.js** (v18+) and `npm`
* **Windows 10/11** with WebView2 Runtime (preinstalled on Windows 11)

### Build Scripts (Windows)
* **Release Build (Standalone EXE + NSIS Installer):** Run `build-release.bat`
  * Automatically stamps the current calendar version (`YYYY.M.D`, e.g. `2026.11.25`) across `Cargo.toml`, `package.json`, `package-lock.json`, and `src-tauri/tauri.conf.json` via `scripts/sync-version.mjs` (pass an explicit version argument such as `build-release.bat 2026.11.25-rc1` to override).
  * Outputs `target\release\taktlight-app.exe` and `target\release\bundle\nsis\TaktLight_<version>_x64-setup.exe`.
* **Debug Build (Standalone Debug EXE):** Run `build-debug.bat`
  * Outputs `target\debug\taktlight-app.exe` with embedded frontend assets, console output, and DevTools enabled.

### Running Tests
* **Rust engine & backend tests:** `cargo test`
* **Frontend typecheck & Vitest suite:** `npx tsc --noEmit` and `npm run test -- --run`

### User Data Directory (Windows)
All runtime user data is stored under `%APPDATA%\TaktLight\`:
* `fixtures\user\` — custom imported and authored OFL `.json` profiles (override path via `TAKTLIGHT_FIXTURES_DIR`)
* `recent_projects.txt` — recently opened `.takt.xml` shows
* `untitled.takt.xml.autosave` — fallback crash-recovery autosave
* `logs\taktlight.log` — rolling application, panic, and UI error log

---

## License

MIT License — see [LICENSE](./LICENSE).
