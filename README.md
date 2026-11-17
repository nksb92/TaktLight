# TaktLight

**TaktLight** (*Takt* = musical beat and deterministic clock cycle) is an Ethernet-native DMX512 lighting control and show design application built with **Tauri v2 (Rust + React/TypeScript)**.

Designed as a streamlined, modern studio show designer inspired by the **Daslight 5** workflow, TaktLight strips out legacy USB-DMX hardware drivers and heavy 3D stage visualizers to focus on what matters for Ethernet lighting rigs: a deterministic **44 Hz Rust real-time engine**, **Art-Net v4** and **sACN (ANSI E1.31)** output, a **2D spatial fixture grid**, a normalized **float Trait-Space Mixer**, procedural **1D/2D FX blocks**, and audio-synced **Super Scene** timelines.

---

## Core Features & Scope

* **Ethernet-Only Output Engine (Rust):**
  * **Art-Net v4 (`UDP 6454`):** Unicast and Broadcast `ArtDmx` (`0x5000`), multi-universe frame synchronization via `ArtSync` (`0x5200`), and automatic node discovery via `ArtPoll` / `ArtPollReply`.
  * **sACN / ANSI E1.31 (`UDP 5568`):** Multicast (`239.255.x.x`) and Unicast streaming with configurable universe priorities.
  * **DMX Monitor & Channel Park:** Real-time 512-channel byte inspector per universe with channel parking/override for benchtop hardware debugging.
* **JSON Fixture Library & In-App Fixture Builder (`.fixture.json`):**
  * Supports 8-bit and 16-bit (`fine`) DMX channels.
  * Semantic trait mapping (`dimmer`, `color_r/g/b/w`, `color_wheel`, `pan`, `tilt`, `shutter`, `gobo_wheel`).
  * Discrete channel capability slots (mechanical Color Wheels, Gobo slots, Shutter/Strobe Hz ranges).
  * **Multi-Cell / Sub-Fixture Support:** Single patched fixtures (such as 8-segment RGBW LED bars or pixel rings) expand into independently controllable cells on the 2D grid while sharing master dimmer and strobe channels.
* **Interactive 2D Fixture Grid & Smart Palettes:**
  * Spatial 2D canvas with live calculated color, dimmer brightness, and Pan/Tilt vector dot feedback on every cell.
  * 1D selection ordering (`Left to Right`, `Symmetrical Center Out`, `Mirror`, `Odd/Even`) and 2D $(X, Y)$ bounding-box spatial mapping.
  * Hardware-abstracted Color Picker, Color Wheel swatches, XY Pan/Tilt pad with linear/mirror fanning, and Shutter controls.
* **Normalized Float Trait-Space Mixer (`f32`):**
  * All active scenes and FX blocks blend in normalized `0.0..1.0` trait space (`HTP` for dimmer, `LTP` crossfade for base traits, and `Relative +/-` modulation for layered oscillators) before quantizing to 8/16-bit DMX bytes or nearest Color Wheel slots.
* **Procedural 1D & 2D FX Engine:**
  * **Static & Fanning:** Linear and symmetrical gradients across fixture groups.
  * **Step Chases:** Multi-step sequences with configurable hold and fade durations.
  * **1D Curve & Pan/Tilt Oscillators:** `Sine`, `Triangle`, `Saw`, `Square`, and 2D `Circle` / `Figure 8` / `Lissajous` motion generators with phase spread (`0° to 360°`).
  * **2D Spatial Matrix Shaders:** `Linear Sweep`, `Radial Wave`, `Plasma`, and `Pinwheel` effects sampled directly at each cell's $(X, Y)$ canvas position.
  * **Dual Timing Modes:** Driven by either absolute time (`Hz` / `Seconds`) or musical tempo (`BPM` / `Beats`).
* **Super Scene Timeline (Phase 2 Expansion):**
  * DAW-style multi-track timeline synchronized to `.wav`, `.mp3`, and `.flac` audio playback with visual waveforms, beat-grid markers, and draggable `FxBlock` clips with fade handles.
* **Tuned XML Project Files (`.takt.xml`):**
  * Human-readable, Git-friendly `<TaktLightShow>` XML schema unifying Phase 1 looping scenes and Phase 2 timecode tracks under the same `<FxBlock>` model.

---

## Architecture Documentation

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the complete system architecture, data schemas (`.fixture.json` and `.takt.xml`), the 4-stage 44 Hz Rust pipeline, and the 6-slice implementation roadmap.

---

## Tech Stack

* **Backend / Real-Time Core:** Rust (`Tauri v2`, `tokio`, `socket2`, `spin_sleep`, `parking_lot`, `serde_json`, `quick-xml`, `symphonia`, `cpal`)
* **Frontend / Studio UI:** React, TypeScript, Zustand, Tailwind CSS, HTML5 2D Canvas
