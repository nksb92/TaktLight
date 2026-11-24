# TaktLight Test Coverage & Quality Report

**Generated:** 2026-11-24  
**Status:** All automated unit, integration, browser E2E, and layout audit suites passing (`0` failures, `0` TypeScript errors).

---

## 1. Executive Summary

| Layer | Runner | Suites / Crates | Tests Passing | Coverage | Status |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **TypeScript Typecheck** | `tsc --noEmit` | Full `src/` | 0 errors | — | PASS |
| **Frontend Unit & UI Integration** | `vitest run --coverage` | 26 files | **144 / 144** | **91.31% lines / 79.42% branches** | PASS |
| **Rust Core Engine (`taktlight-engine`)** | `cargo llvm-cov --workspace` | 1 crate + 2 integration | **108 / 108** | **90.3%+ regions** | PASS |
| **Tauri Backend (`taktlight-app-lib`)** | `cargo llvm-cov --workspace` | 1 crate | **10 / 10** | **65.34% regions** (87.00% workspace) | PASS |
| **Browser E2E & Layout Audit** | `npm run test:e2e` | 2 spec files | **17 / 17** | 14 E2E + 3 viewports × 7 views | PASS |
| **Tauri Desktop CDP E2E** | `npm run test:e2e:tauri` | 1 spec file | 11 scenarios | Ready (requires `npm run dev:debug`) | READY |
| **Total Automated Verified Tests** | | **31 targets** | **279 / 279** | | **PASS** |

---

## 2. Frontend Coverage & Enforced Thresholds (`vitest.config.ts`)

Enforced thresholds:
- `src/components/*.tsx`: `>= 95%` lines/statements, `>= 80%` branches
- `src/lib/*.ts`: `>= 85%` lines, `>= 78%` branches
- Exclusions: `src/vite-env.d.ts`, `src/lib/testBridge.ts`, `src/main.tsx`, `src/test/**`

Key coverage metrics (V8):
- `src/components`: **96.34% lines / 83.09% branches / 90.63% functions**
- `src/lib`: **87.21% lines / 79.98% branches / 98.41% functions**
  - `sceneDrag.ts`: `100.0%` lines / `91.66%` branches
  - `frameDecoder.ts`: `98.09%` lines / `93.33%` branches
  - `timelineLogic.ts`: `96.75%` lines / `80.18%` branches
  - `patchLogic.ts`: `91.23%` lines / `89.90%` branches
  - `oflBuilder.ts`: `87.50%` lines / `79.27%` branches
- `src/store/useTaktStore.ts`: `78.00%` lines / `64.93%` branches

---

## 3. Rust Backend & Engine Coverage (`cargo llvm-cov --workspace`)

Workspace total (excluding `taktlight-bench` and `src-tauri/src/main.rs`): **87.00% regions / 86.84% lines / 74.77% functions**.

Key highlights:
- `crates/taktlight-engine/src/ofl/matrix.rs`: **97.76% regions / 100.00% functions** (1D/2D/3D `pixelKeys`, all `eachPixel*` orders, pixel groups, invalid matrix rejection)
- `crates/taktlight-engine/src/show/undo.rs`: **84.70% regions / 87.95% lines** (apply/undo/redo symmetry and coalescing across all `ShowCommand` variants)
- `crates/taktlight-engine/src/engine/evaluator.rs`: **97.91% regions / 100.00% functions**
- `crates/taktlight-engine/src/protocol/{artnet,sacn,nic}.rs`: **96–99.7% regions**
- `src-tauri/src/lib.rs`: **65.34% regions** (10 `AppState` unit tests covering patch, split resolution, universe config, bank colors, deletions, XML round-trip, audio relinking, scenes, and timelines)

---

## 4. E2E Test Suites

- **Browser E2E (`e2e/taktlight.spec.ts`, 14 tests passing):** Timeline drag-and-drop without text selection, pause/playhead/keyboard shortcuts, scene rename & color toggle persistence, 2D grid negative coords & snap, FixtureBuilder Add Mode & presets, CURVE FX pulse waveform & duty, Alt-drag duplicate & double-click guard, `color_mappings` 2D gizmo, DMX Monitor park/HEX/PCT/DEC/Blackout, DMX boundary 512 rollover split & auto-resolve (`TC-11`), out-of-range BPM clamping & malformed OFL JSON (`TC-12`/`TC-13`), rapid color + 3× toggle spam (`TC-14`), timeline NLE unit toggle/zoom/Undo/Redo, and synthetic WAV music clip upload.
- **UI Layout Audit (`e2e/ui-layout-audit.spec.ts`, 3 viewports × 7 views passing):** `1280x720`, `1440x900`, `1920x1080` across `studio`, `studio-timeline`, `studio-timeline-expanded`, `studio-fx-submenu`, `patch`, `fixtures`, and `monitor` with `0` overflow/overlap/alignment issues.
- **Tauri Desktop CDP E2E (`e2e/tauri.smoke.spec.ts`, 11 tests):** Live IPC + 44 Hz telemetry, DMX park/clear, patch + canvas geometry + undo, TC-06 color toggle regression, blackout, CURVE FX live Rust DMX, XML round-trip, bank drag-reorder, real Art-Net UDP 6454 packet sniffing via `DmxSniffer` (`TC-10`), real canvas fixture & 2D shader gizmo drag (`TC-05`/`TC-07`), and offline/auto adapter switch + TX stress (`TC-16`).
