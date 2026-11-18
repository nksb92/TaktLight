# TaktLight

**TaktLight** (*Takt* = musical beat and deterministic clock cycle) is a 100% offline-capable, Ethernet-native DMX512 lighting control and show design application built with **Tauri v2 (Rust + React/TypeScript)**.

Designed as a streamlined, modern studio show designer inspired by the **Daslight 5** workflow, TaktLight strips out legacy USB-DMX hardware drivers and heavy 3D stage visualizers to focus on what matters for Ethernet lighting rigs: a deterministic **44 Hz Rust real-time engine**, **Art-Net v4** and **sACN (ANSI E1.31)** output, native **Open Fixture Library (OFL) `.json`** support, a **2D spatial fixture grid**, a normalized **float Trait-Space Mixer**, procedural **1D/2D FX blocks**, and audio-synced **Timelines** with offline transient detection.

---

## Core Features & Scope

* **100% Offline-First & Ethernet Output Engine (Rust):**
  * Runs completely offline with zero cloud dependencies and graceful loopback fallback when no network adapter is connected.
  * **Art-Net v4 (`UDP 6454`):** Unicast and Broadcast `ArtDmx` (`0x5000`), multi-universe frame synchronization via `ArtSync` (`0x5200`), and automatic node discovery via `ArtPoll` / `ArtPollReply`.
  * **sACN / ANSI E1.31 (`UDP 5568`):** Multicast (`239.255.x.x`) and Unicast streaming with configurable universe priorities.
  * **DMX Monitor, Channel Park & Jitter Histogram:** Real-time 512-channel byte inspector per universe, channel parking/override for benchtop debugging, and live microsecond frame-time telemetry (`22.72 ms ± 0.04 ms`).
* **Native Open Fixture Library (OFL) `.json` & In-App Fixture Builder:**
  * Uses the open-source **Open Fixture Library (OFL) JSON schema** directly as its native fixture format, allowing offline use of 1,500+ community fixtures and authoring of custom fixture `.json` files in the same format.
  * Supports `Intensity`, `ColorIntensity` (`Red`, `Green`, `Blue`, `White`), `ShutterStrobe`, and `WheelSlot` capabilities.
  * **Multi-Cell / Pixel Bar Support:** Single patched fixtures (`matrix.pixelCount` + `templateChannels`, such as 8-segment RLCV3 RGBW LED tubes or pixel bars) expand into independently controllable cells on the 2D grid while sharing master dimmer and strobe channels.
* **Interactive 2D Fixture Grid & Referenceable Palettes:**
  * Spatial 2D canvas with live calculated color and dimmer brightness feedback on every cell.
  * 1D selection ordering (`Left to Right`, `Symmetrical Center Out`, `Mirror`, `Odd/Even`) and 2D $(X, Y)$ bounding-box spatial mapping.
  * **Referenceable Palettes:** Scenes and FX blocks reference named `<ColorPalette>` and `<DimmerPalette>` presets so updating a palette updates every scene in the show automatically.
* **Normalized Float Trait-Space Mixer (`f32`) & Gamma Calibration:**
  * All active scenes and FX blocks blend in normalized `0.0..1.0` trait space (`HTP` for dimmer, `LTP` crossfade for base traits, and `Relative +/-` modulation for layered oscillators) before quantizing to DMX bytes or nearest Color Wheel slots.
  * **Per-Fixture Gamma Curve ($\gamma = 2.2$) & Deadzone Compensation:** Eliminates low-end dimming jumps on budget 8-bit LED fixtures.
* **Procedural 1D & 2D FX Engine (Phase 1):**
  * **Static & Fanning:** Linear and symmetrical gradients across fixture groups.
  * **Step Chases:** Multi-step sequences with configurable hold and fade durations.
  * **1D Curve Oscillators:** `Sine`, `Triangle`, `Saw`, `Square`, and `Pulse` generators with phase spread (`0° to 360°`).
  * **2D Spatial Matrix Shaders:** `Linear Sweep`, `Radial Wave`, `Plasma`, and `Pinwheel` effects sampled directly at each cell's $(X, Y)$ canvas position.
  * **Dual Timing Modes:** Driven by either absolute time (`Hz` / `Seconds`) or musical tempo (`BPM` / `Beats`).
* **Multi-Track Timelines & Offline Transient Detection (Phase 2 Expansion):**
  * DAW-style multi-track Timeline synchronized to `.wav`, `.mp3`, and `.flac` audio playback with visual waveforms and draggable `FxBlock` clips.
  * **Offline Spectral-Flux Transient Detection (`rustfft`):** Automatically extracts kick drum (`40–140 Hz`) and snare (`1.5–8 kHz`) onset markers in `<150 ms` offline so FX blocks snap directly to musical hits.
* **Moving-Light Expansion & Stage Calibration (Phase 3 Future Roadmap):**
  * Deferred from v1 to keep initial development focused on LED/pixel/color fixtures; when added in Phase 3, includes 16-bit `Pan/Tilt` traits, XY Pad, Lissajous motion curves, and **Per-Fixture Physical Stage Calibration (`<StageBounds>` invert/swap/min-max bounding box)**.
* **Strict Test-Driven Development (TDD) Architecture:**
  * Every feature slice is developed test-first (`Red -> Green -> Refactor`).
  * Pure Rust core engine (`taktlight-engine`) with deterministic time injection `evaluate_frame(t_sec)` and trait-mocked `PacketSink` allows 100% unit test coverage (`cargo test` + `vitest`) without launching a GUI window or opening physical sockets.

---

## Architecture Documentation

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the complete system architecture, data schemas (OFL `.json` and `.takt.xml`), the 4-stage 44 Hz Rust pipeline, and the phased TDD implementation plan.

---

## Tech Stack

* **Backend / Real-Time Core:** Rust (`Tauri v2`, `tokio`, `socket2`, `spin_sleep`, `parking_lot`, `serde_json`, `quick-xml`, `symphonia`, `rustfft`, `cpal`)
* **Frontend / Studio UI:** React, TypeScript, Zustand, Tailwind CSS, HTML5 2D Canvas
* **Design System:** Another German Engineer (AGE) Design System V1.0 (`VOID #0A0F18`, `PITCH #0D1117`, `SLATE_DARK #111827`, `SLATE #1A2535`, `STEEL #4A5A6A`, `MIST #E8EEF6`, `FOG #8898A8`, `EMBER #FF5500`, `COBALT #2255AA`, `PLUM #8833AA`, `PINE #1E6B35`, `SIGNAL #CC0000`; `DM Sans` + `Fira Code`)
