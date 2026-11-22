# TaktLight Test Coverage & Quality Report

**Generated:** 2026-11-22  
**Status:** All automated unit, integration, and workspace suites passing (`0` failures, `0` TypeScript errors).

---

## 1. Executive Summary

| Layer | Runner | Suites / Crates | Tests Passing | Status |
| :--- | :--- | :---: | :---: | :---: |
| **TypeScript Typecheck** | `tsc --noEmit` | Full `src/` | 0 errors | PASS |
| **Frontend Unit & UI Integration** | Vitest (`vitest --run`) | 9 files | **60 / 60** | PASS |
| **Rust Core Engine (`taktlight-engine`)** | `cargo test --workspace` | 1 crate | **92 / 92** | PASS |
| **Tauri Backend (`taktlight-app-lib`)** | `cargo test --workspace` | 1 crate | **7 / 7** | PASS |
| **Browser E2E Specs (Playwright)** | `e2e/taktlight.spec.ts` | 1 spec file | 5 scenarios | Ready (`npm run test:e2e`) |
| **Total Automated Unit & Integration Tests** | | **11 targets** | **159 / 159** | **PASS** |

---

## 2. Frontend Test Breakdown (`vitest --run`)

| Test File | Tests | Covered Subsystems & Guarantees |
| :--- | :---: | :--- |
| `src/App.test.tsx` | 17 | Startup landing on Patch, DMX Monitor (512 ch, Park override, Blackout, HEX/DEC, Jitter Histogram), Fixture Builder & OFL JSON validation, Dual-Universe Patching + Rollover + Cross-Protocol Split resolution + `.takt.xml` export, 2D Fixture Grid (`Clr` zero-selection, `GridPos`, `OrderRule`, multi-select grouping, duplicate group rejection), Color Palette Builder modal, Dynamic FX Target Channel selector, Bank instant creation & double-click rename, Scene Duration Beats/Seconds, Timeline Super-Scene drag/drop, WAV decode, NLE trim/split/duplicate/auto-fill kicks, Unsaved-Changes Close modal, `GM` tooltip. |
| `src/store/__tests__/useTaktStore.test.ts` | 11 | Store state transitions, Undo/Redo history, Patch/Group/Scene/Timeline mutations, Bank management, Project dirty tracking. |
| `src/lib/__tests__/mixerLogic.test.ts` | 10 | OKLab multi-stop palette sampling, RGBW extraction, 1D Curve / Step Chase / 2D Spatial Shader evaluation, strict 2D shader gizmo rectangle bounding, scalar channel traits (`red`, `dimmer`, `master_dimmer`), BPM-independent seconds duration, DMX quantization. |
| `src/lib/__tests__/timelineLogic.test.ts` | 9 | Timeline content duration calculation, beat/second conversions, snap-to-beat rounding, tempo map integration, clip overlap/trim helpers. |
| `src/lib/__tests__/oflBuilder.test.ts` | 4 | Built-in RLCV3/RLCV4 OFL profiles, mode expansion, matrix cell generation, offline JSON schema validation. |
| `src/lib/__tests__/frameDecoder.test.ts` | 3 | Binary DMX frame encoding/decoding (512 channels per universe), payload normalization. |
| `src/lib/__tests__/patchLogic.test.ts` | 3 | 1D `OrderRule` (`linear`, `reverse`, `center_out`, `mirror`, `odd_even`, `blocks(k)`), `TargetRef` range expansion, 2D `transformCellUv`. |
| `src/lib/__tests__/testBridge.test.ts` | 2 | Dev/E2E canvas geometry test bridge registration and serialization. |
| `src/lib/__tests__/audioEngine.test.ts` | 1 | Real WAV binary decoding & peak/RMS waveform extraction fallback (`FileReader` / `arrayBuffer`). |

---

## 3. Rust Backend & Engine Breakdown (`cargo test --workspace`)

### `crates/taktlight-engine` (92 tests)
- **DMX Network Protocols:** Art-Net (`ArtDmx` 530B, `ArtSync` 14B, `ArtPoll` / `ArtPollReply`, sequence wrapping, offline node timeout), sACN E1.31 (`638B` data packet, multicast IP mapping, stream termination, universe discovery), NIC adapter & subnet broadcast resolution, UDP / Mock / Offline sinks.
- **Show & Patch Compiler:** Auto-patch batching, collision detection (heads & implicit tails), rollover ON/OFF split behavior, cross-protocol warnings, universe creation, split-fixture per-channel compilation, `.takt.xml` round-trip serialization (multi-stop palettes, duration units, Daslight FX attributes, legacy `v0.9` migration, read-only `v2.0` guard, audio relative-path relinking & SHA-256 verification).
- **FX & Timeline Engine:** Golden-frame deterministic DMX evaluation across time steps, 1D curve / step chase / 2D spatial shader closed-form evaluators (strictly bounded to gizmo rectangle), beat-clock & tempo-map integration, streaming audio transient detector (80 Hz kick / 3 kHz snare), tempo estimator (120 / 128 BPM + grid offset seeding), SHA-256 audio analysis cache.
- **Runtime, Telemetry & Undo:** Grand Master clamping, channel park validation, 44 Hz loop output-enable gate, jitter histogram & ring-buffer statistics, command undo/redo symmetry, gesture coalescing, and autosave trigger thresholds.

### `src-tauri` (`taktlight-app-lib`, 7 tests)
- Runtime control updates without pushing undo or recompiling plan, Tauri command state wiring, splashscreen lifecycle command (`close_splashscreen`), and workspace compilation checks.

---

## 4. Known Gaps & Recommended Next Verification
- **Playwright E2E (`npm run test:e2e`):** 5 real-browser scenarios cover drag-and-drop onto timeline tracks, keyboard transport shortcuts (`Space`, `Home`, `Ctrl+D`, `Delete`), scene double-click rename, and color toggle persistence. Run against a live Vite dev server (`npm run test:e2e`) or Tauri build (`npm run test:e2e:tauri`) before release packaging.
- **Hardware DMX Sniffer (`npm run test:dmx-sniff`):** Available for benchtop Art-Net / sACN packet verification against physical RLCV3/RLCV4 fixtures.
