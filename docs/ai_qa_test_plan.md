# TaktLight AI QA Test Plan (Lower-Tier Model Execution Guide)

This document is an executable, step-by-step verification script designed for a fast / lower-tier AI model to test **TaktLight** features against the real Tauri desktop application (Rust 44 Hz engine + React UI + Art-Net/sACN UDP output). It covers both **Happy Path (TC-01 to TC-10)** and **Negative / Boundary / Stress Edge Cases (TC-11 to TC-16)**.

---

## 1. Strict Rules for the Executing AI

1. **Do NOT modify application source code** during a QA run. Your job is strictly to execute tests, collect evidence, and report PASS or FAIL.
2. **Do NOT guess selectors or canvas coordinates.** Use only the exact `data-testid`, `aria-label`, button text, or `window.__TAKTLIGHT_TEST__` calls listed in each test case.
3. **Verify real Tauri mode first.** Every desktop test requires `window.__TAKTLIGHT_TEST__.getStatus().isTauri === true`. If `isTauri` is `false`, STOP and report `ENV_BLOCKED` (you are attached to plain Vite, not the Tauri desktop app).
4. **Never skip cleanup.** Run the `Cleanup` block at the end of every test case (even after a failure) so state does not leak into the next test.
5. **Fail immediately with concrete evidence.** Whenever an assertion does not match:
   - Capture a screenshot (`test-results/qa_<TC-ID>.png`).
   - Record the JSON output of `window.__TAKTLIGHT_TEST__.getStatus()`.
   - Record any browser console errors or uncaught page errors.
   - Mark the test case `FAIL` and proceed to Cleanup before moving to the next test case.

---

## 2. Environment Setup & Preflight (Step 0)

Working directory for all commands:
`f:\Programme\age_scripts\videos\2026-11-17_taktlight-dmx-controller\TaktLight`

### Step 0.1 — Automated Baseline Checks
Run these commands in order and record PASS/FAIL before opening the app:
```powershell
cargo test
npm test -- --run
npm run test:e2e
```

### Step 0.2 — Launch TaktLight Desktop App with WebView2 CDP
Start the desktop app in a background terminal (use `dev:debug:prebuilt` if `target/debug/taktlight-app.exe` is already up to date, otherwise `dev:debug`):
```powershell
npm run dev:debug:prebuilt
```
Wait until stdout prints:
`TAKTLIGHT_CDP_READY http://127.0.0.1:9222`

### Step 0.3 — Run Automated Tauri CDP Smoke Suite
```powershell
npm run test:e2e:tauri
```
If all smoke tests pass, proceed to TC-01 through TC-16 by attaching Playwright or a CDP browser agent to `http://127.0.0.1:9222`.

---

## 3. Inspection Helper Reference (`window.__TAKTLIGHT_TEST__`)

Every dev session installs `window.__TAKTLIGHT_TEST__`. Evaluate these read-only calls inside the WebView2 page to check ground truth:

| Call | Returns |
| :--- | :--- |
| `window.__TAKTLIGHT_TEST__.getStatus()` | Mode (`tauri`/`simulation`), tab, blackout, grandMaster, BPM, counts, telemetry |
| `window.__TAKTLIGHT_TEST__.getDmxSlice(1, 1, 10)` | Array of `{ ch, val }` for Universe 1 channels 1 to 10 (1-indexed) |
| `window.__TAKTLIGHT_TEST__.getNonZeroDmx(1)` | Only non-zero `{ ch, val }` entries in Universe 1 |
| `window.__TAKTLIGHT_TEST__.getPatch()` | Patched fixtures with `id`, `universe`, `address`, `grid_pos` |
| `window.__TAKTLIGHT_TEST__.getScenes()` | Scene list with `id`, `name`, `bank`, `block_refs` |
| `window.__TAKTLIGHT_TEST__.getFxBlocks()` | FX blocks with `id`, `name`, `elementKinds` |
| `window.__TAKTLIGHT_TEST__.getTimelines()` | Timelines with `trackCount` and `clipCount` |
| `window.__TAKTLIGHT_TEST__.getCellPreviews()` | Compiled cells with live `[r, g, b, d]` preview values |
| `window.__TAKTLIGHT_TEST__.getCanvasGeometry()` | Exact viewport `{ clientX, clientY }` of fixtures and shader gizmo handles |

---

## 4A. Happy-Path Test Cases (Execute in Exact Order)

### TC-01: Tauri IPC & 44 Hz Telemetry Health
- **Precondition:** App launched via `npm run dev:debug` / `dev:debug:prebuilt`, connected to CDP `http://127.0.0.1:9222`.
- **Steps:**
  1. Evaluate `const s1 = window.__TAKTLIGHT_TEST__.getStatus()`.
  2. Wait 500 ms.
  3. Evaluate `const s2 = window.__TAKTLIGHT_TEST__.getStatus()`.
  4. Verify header text `"TAKTLIGHT"` is visible.
- **Pass Criteria:**
  - `s1.isTauri === true` and `s1.connectedMode === "tauri"`.
  - `s2.telemetry.tSec > s1.telemetry.tSec` (engine clock is advancing).
  - `s2.telemetry.droppedFrames - s1.telemetry.droppedFrames === 0` (zero new dropped frames during the steady-state window).
  - `s2.telemetry.p99JitterUs < 5000` (P99 jitter under 5 ms).
  - Zero console errors and zero page errors.
- **Cleanup:** None.

---

### TC-02: DMX Monitor Park, Display Formats & Clear Park
- **Precondition:** TC-01 passed.
- **Steps:**
  1. Click bottom nav button `"Monitor"`.
  2. Click `data-testid="universe-tab-1"`.
  3. Click `data-testid="dmx-cell-1"`.
  4. Confirm `data-testid="park-inspector"` is visible and shows `U1.001`.
  5. Inside `park-inspector`, click quick preset button `"192"`.
  6. Wait 100 ms and evaluate `window.__TAKTLIGHT_TEST__.getDmxSlice(1, 1, 1)`.
  7. Click display format button `"HEX"`, confirm cell `data-testid="dmx-cell-1"` contains `"C0"`.
  8. Click display format button `"PCT"`, confirm cell `data-testid="dmx-cell-1"` contains `"75%"`.
  9. Click display format button `"DEC"`, confirm cell `data-testid="dmx-cell-1"` contains `"192"`.
  10. Confirm `data-testid="topbar-park-override-badge"` is visible and contains `"PARK OVERRIDE: 1 CH"`.
  11. Click button matching `"Clear Parked"`.
  12. Wait 100 ms and verify `data-testid="topbar-park-override-badge"` is hidden and `getDmxSlice(1, 1, 1)[0].val === 0`.
- **Pass Criteria:**
  - After step 5: channel 1 value is `192`.
  - HEX shows `C0`, PCT shows `75%`, DEC shows `192`.
  - After Clear Parked: channel 1 value is `0` and `data-testid="topbar-park-override-badge"` is hidden.
- **Cleanup:** Ensure display format is `"DEC"` and no channels remain parked.

---

### TC-03: Grand Master Scaling & Blackout Override
- **Precondition:** On Monitor tab, no channels parked.
- **Steps:**
  1. Click bottom nav button `"Patch"`.
  2. If `getStatus().patchCount === 0`, click `"Patch Fixture"` to patch 1 fixture at U1.001.
  3. Click bottom nav button `"Studio / 2D Grid"` and click `data-testid="submode-builder"`.
  4. Click the first scene tile (`[data-testid^="scene-tile-"]`) to select it for editing.
  5. Click `"DIMMER"` tab (`data-testid="trait-tab-dimmer"`), click `data-testid="toggle-scene-controls-dimmer"` if `aria-pressed="false"`, and ensure dimmer is at full (`100%`).
  6. Click `"COLOR"` tab (`data-testid="trait-tab-color"`), set `aria-label="RED Channel Fader value"` to `255` and press `Enter`.
  7. Click the Play trigger button on the first scene (`[data-testid^="trigger-scene-"]`) so `getStatus().activeSceneIds.length > 0`.
  8. Wait 150 ms and record `const baseCells = window.__TAKTLIGHT_TEST__.getCellPreviews()` and `const baseCh1 = window.__TAKTLIGHT_TEST__.getDmxSlice(1, 1, 1)[0].val`.
  9. Click `"BLACKOUT"` button in top status bar.
  10. Wait 100 ms and evaluate `window.__TAKTLIGHT_TEST__.getStatus().blackout`, `data-testid="topbar-blackout-badge"` visibility, `window.__TAKTLIGHT_TEST__.getCellPreviews()`, and `window.__TAKTLIGHT_TEST__.getDmxSlice(1, 1, 34)` (note: non-intensity fixture control channels such as `ch 2` Shutter Open `= 11` intentionally stay intact during blackout; intensity/dimmer `ch 1` and RGBW channels `ch 3..34` must all be `0`).
  11. Click `"BLACKOUT"` button again to release blackout.
  12. Set `aria-label="Grand Master value"` to `50` and press `Enter`.
  13. Wait 100 ms and evaluate `window.__TAKTLIGHT_TEST__.getStatus().grandMaster`.
- **Pass Criteria:**
  - Before blackout: `baseCh1 > 0` and at least one cell in `baseCells` has `d > 0`.
  - While blackout is active: `status.blackout === true`, `data-testid="topbar-blackout-badge"` is visible, `getDmxSlice(1, 1, 1)[0].val === 0`, all RGBW channels (`ch 3..34`) are `0`, and every cell in `getCellPreviews()` has `d === 0`.
  - After releasing blackout: output returns (`getCellPreviews().some((c) => c.d > 0)`).
  - Grand Master updates to `0.5` (`Math.abs(status.grandMaster - 0.5) < 0.02`).
- **Cleanup:** Set `aria-label="Grand Master value"` back to `100` (press `Enter`). Ensure `BLACKOUT` is off. Click `aria-label="Release All Scenes"`.

---

### TC-04: Fixture Patching, Undo & Redo
- **Precondition:** App running.
- **Steps:**
  1. Click bottom nav button `"Patch"`.
  2. Record `const count0 = window.__TAKTLIGHT_TEST__.getStatus().patchCount`.
  3. Set `aria-label="Name Prefix"` to `"QA Tube"`.
  4. Set `aria-label="Fixture Count"` to `2`.
  5. Click `"Patch Fixture"`.
  6. Wait 150 ms and evaluate `const count1 = window.__TAKTLIGHT_TEST__.getStatus().patchCount`.
  7. Click `aria-label="Undo"`.
  8. Wait 150 ms and evaluate `const countUndo = window.__TAKTLIGHT_TEST__.getStatus().patchCount`.
  9. Click `aria-label="Redo"`.
  10. Wait 150 ms and evaluate `const countRedo = window.__TAKTLIGHT_TEST__.getStatus().patchCount`.
- **Pass Criteria:**
  - `count1 === count0 + 2`.
  - `countUndo === count0`.
  - `countRedo === count0 + 2`.
  - `getPatch()` contains fixtures with no overlapping DMX address ranges.
- **Cleanup:** Click `aria-label="Undo"` once so the 2 QA fixtures are removed (keep 1 fixture patched for TC-05 through TC-08). Reset `aria-label="Fixture Count"` back to `1`.

---

### TC-05: 2D Fixture Grid — Negative Coordinates, Snap Toggle & Canvas Drag
- **Precondition:** At least 1 fixture is patched.
- **Steps:**
  1. Click bottom nav button `"Studio / 2D Grid"`.
  2. Click `data-testid="submode-builder"`.
  3. Confirm `data-testid="fixture-grid-canvas"` is visible.
  4. Toggle `data-testid="toggle-2d-snap-grid"` ON and verify `aria-pressed="true"`.
  5. Fill `aria-label="Grid X"` with `"-0.25"` and blur.
  6. Wait 100 ms and verify `Number(gridX) === -0.25` and `getPatch()[0].grid_pos.x === -0.25`.
  7. Fill `aria-label="Grid X"` with `"0.35"` and `aria-label="Grid Y"` with `"0.40"`, then blur.
  8. Evaluate `const g0 = window.__TAKTLIGHT_TEST__.getCanvasGeometry()`.
  9. Perform a real mouse drag on fixture 0 from `(g0.fixtures[0].clientX, g0.fixtures[0].clientY)` to `(g0.fixtures[0].clientX + 80, g0.fixtures[0].clientY + 40)` over 8 steps, then mouse up.
  10. Wait 150 ms and evaluate `const g1 = window.__TAKTLIGHT_TEST__.getCanvasGeometry()`.
- **Pass Criteria:**
  - Negative X (`-0.25`) is accepted without clamping to `0`.
  - After canvas drag: `g1.fixtures[0].gridX > g0.fixtures[0].gridX` and `g1.fixtures[0].gridY > g0.fixtures[0].gridY`.
  - Because snap-to-grid is enabled, `gridX` and `gridY` are multiples of `0.05` (within `0.001`).
- **Cleanup:** Toggle `data-testid="toggle-2d-snap-grid"` OFF.

---

### TC-06: Scene Rename & Color Toggle Persistence
- **Precondition:** On Studio / 2D Grid (`submode-builder`).
- **Steps:**
  1. Locate first `[data-testid^="scene-tile-"]` and click it.
  2. Double-click the scene name (`span.font-sans` inside that tile).
  3. Wait for `[data-testid^="rename-scene-input-"]`, fill `"QA Amber"`, and press `Enter`.
  4. Verify the tile displays `"QA Amber"` and `getScenes()` contains `"QA Amber"`.
  5. Click `"COLOR"` tab (`data-testid="trait-tab-color"`).
  6. Set `aria-label="RED Channel Fader value"` to `128` and press `Enter`.
  7. Wait for `data-testid="toggle-scene-controls-color"` to have `aria-pressed="true"`.
  8. Click `data-testid="toggle-scene-controls-color"` to deactivate and wait for `aria-pressed="false"`.
  9. Click `data-testid="toggle-scene-controls-color"` to reactivate and wait for `aria-pressed="true"`.
  10. Read `aria-label="RED Channel Fader value"`.
- **Pass Criteria:**
  - Scene name updates to `"QA Amber"` in both DOM and Rust state (`getScenes()`).
  - Color toggle transitions cleanly `true -> false -> true`.
  - After toggling color OFF then ON, RED channel value remains `128`.
- **Cleanup:** None required.

---

### TC-07: 2D Spatial Shader Gizmo & Closing FX Removes Effect
- **Precondition:** At least 1 multi-cell fixture patched, Studio / 2D Grid (`submode-builder`) open, first scene selected.
- **Steps:**
  1. In the FX Rack (`data-testid="daslight-fx-rack"`), if `data-testid="fx-picker-tile-color_mappings"` is not visible, click `data-testid="toggle-fx-picker-btn"`.
  2. Click `data-testid="fx-picker-tile-color_mappings"` to add a 2D spatial shader effect to the active scene.
  3. Click `data-testid="toggle-2d-shader-gizmo"` so `aria-pressed="true"`.
  4. Evaluate `const g0 = window.__TAKTLIGHT_TEST__.getCanvasGeometry()`.
  5. Verify `g0.shaderGizmo !== null` and `g0.shaderGizmo.active === true`.
  6. Drag the gizmo center handle from `(g0.shaderGizmo.centerClientX, g0.shaderGizmo.centerClientY)` by `(+60, +40)` pixels over 6 steps and release.
  7. Wait 150 ms and evaluate `const g1 = window.__TAKTLIGHT_TEST__.getCanvasGeometry()`.
  8. Click `data-testid="toggle-fx-picker-btn"` (`aria-label="Remove FX"`) to close and remove the active FX.
  9. Wait 150 ms and evaluate `window.__TAKTLIGHT_TEST__.getFxBlocks()`.
- **Pass Criteria:**
  - `g1.shaderGizmo.centerNormX !== g0.shaderGizmo.centerNormX` or `g1.shaderGizmo.centerNormY !== g0.shaderGizmo.centerNormY` (gizmo drag reaches backend state).
  - Clicking `data-testid="toggle-fx-picker-btn"` returns to the FX choice matrix (`data-testid="daslight-fx-picker-grid"` visible) and removes the `spatial_shader_2d` element from the scene's block.
- **Cleanup:** Toggle `data-testid="toggle-2d-shader-gizmo"` OFF.

---

### TC-08: Timeline Drag-and-Drop, Pause Holds Playhead & Keyboard Shortcuts
- **Precondition:** Studio / 2D Grid open.
- **Steps:**
  1. Click `data-testid="submode-timeline"`.
  2. Confirm `data-testid="daslight-timeline-dock"` is visible.
  3. If `window.__TAKTLIGHT_TEST__.getStatus().timelineCount === 0`, click button matching `"New Timeline"` and wait until `timelineCount >= 1`.
  4. Confirm `data-testid="timeline-new-track-dropzone"` is visible and count existing clips: `const c0 = page.locator("[data-testid^='timeline-clip-']").count()`.
  5. Drag the first `[data-testid^="scene-tile-"]` onto `data-testid="timeline-new-track-dropzone"` (real mouse down, 10 move steps, mouse up).
  6. Confirm no text was selected (`window.getSelection().toString() === ""`) and clip count is `c0 + 1`.
  7. Fill `aria-label="Timeline Playhead Sec"` with `"2.5"` and blur.
  8. Press `Space` (play), wait 200 ms, press `Space` (pause).
  9. Read `aria-label="Timeline Playhead Sec"` value (`pPaused`).
  10. Press `Home` and read `aria-label="Timeline Playhead Sec"` value (`pHome`).
  11. Press `Control+d` (duplicate selected clip) and verify clip count increased by 1.
  12. Press `Delete` and verify clip count returned to previous count.
- **Pass Criteria:**
  - Dragging a scene onto `timeline-new-track-dropzone` creates a new track + clip with zero text selection.
  - `pPaused >= 2.5` (pause holds position; does NOT reset to `0`).
  - `pHome === 0` (`Home` returns to origin).
  - `Control+d` duplicates and `Delete` deletes the selected clip.
- **Cleanup:** Ensure timeline is paused (`status.timelinePlaying === false`).

---

### TC-09: Fixture Builder — Add Mode & OFL Validation
- **Precondition:** App running.
- **Steps:**
  1. Click bottom nav button `"Fixtures"`.
  2. Confirm `data-testid="add-mode-btn"` is visible.
  3. Click `data-testid="add-mode-btn"`.
  4. Verify a new mode entry appears without console errors.
- **Pass Criteria:**
  - `data-testid="add-mode-btn"` is visible and clickable.
  - Adding a mode updates the UI cleanly with zero console or page errors.
- **Cleanup:** Return to `"Monitor"` tab.

---

### TC-10: Real Art-Net UDP Output Verification (`UDP 6454`)
- **Precondition:** At least one active IPv4 network interface exists (`window.__TAKTLIGHT_TEST__.getStatus().activeInterface !== null`). If `activeInterface === null` (offline/no NIC), mark TC-10 as `SKIP (OFFLINE_ENV)`.
- **Steps:**
  1. Click bottom nav button `"Monitor"`.
  2. Click `data-testid="dmx-cell-1"` and park channel 1 to `"255"`.
  3. Click `data-testid="toggle-network-output-btn"` so `aria-pressed="true"` (status pill leaves `"TX OFF"`).
  4. In a terminal, run the UDP sniffer for 2 seconds:
     ```powershell
     npm run test:dmx-sniff -- --duration 2000
     ```
  5. Inspect the JSON output printed by the sniffer.
- **Pass Criteria:**
  - `artnetDmxPackets > 0`.
  - `latestArtNet["0:0:0"].nonZero` contains `{ "ch": 1, "val": 255 }`.
- **Cleanup:**
  1. Click `data-testid="toggle-network-output-btn"` to turn network TX OFF (`aria-pressed="false"`).
  2. Click `"Clear Parked"` in DMX Monitor.

---

## 4B. Negative, Boundary & Edge-Case Test Cases

### TC-11: DMX Universe Boundary Split-Rollover & Auto-Resolve
- **Precondition:** App running on `"Patch"` tab.
- **Steps:**
  1. Record `const count0 = getStatus().patchCount`.
  2. Ensure `data-testid="toggle-rollover-split"` has `aria-checked="true"` (click it if `"false"`).
  3. Set `aria-label="Name Prefix"` to `"SplitTube"`, `aria-label="Fixture Count"` to `1`, `aria-label="Start Universe"` to `1`, `aria-label="Start Address"` to `505`.
  4. Click `"Patch Fixture"`.
  5. Wait 150 ms and verify `getStatus().patchCount === count0 + 1`.
  6. Click `data-testid="toggle-rollover-split"` to turn rollover split OFF (`aria-checked="false"`), which reveals the split-fixture resolution banner.
  7. Confirm `data-testid="resolve-split-fixtures-button"` is visible and click it, then wait 150 ms.
  8. Evaluate `getPatch()` and verify every fixture fits cleanly within `[1..512]` (i.e., `address + channel_count - 1 <= 512`).
- **Pass Criteria:**
  - Patching near channel 512 splits cleanly without crashing.
  - Toggling rollover split OFF reveals `data-testid="resolve-split-fixtures-button"`.
  - After resolving split fixtures, every fixture satisfies `address + channel_count - 1 <= 512` and zero collisions exist.
- **Cleanup:** Click `data-testid="toggle-rollover-split"` back ON (`aria-checked="true"`). Click `aria-label="Undo"` until `patchCount === count0`. Reset `aria-label="Start Address"` to `1`.

---

### TC-12: Out-of-Range Numeric Inputs Clamping (BPM & DMX Park)
- **Precondition:** App running.
- **Steps:**
  1. Click `"Studio / 2D Grid"`.
  2. Set `aria-label="Live BPM"` to `"999"` and blur; wait 100 ms and read `getStatus().liveBpm`.
  3. Set `aria-label="Live BPM"` to `"5"` and blur; wait 100 ms and read `getStatus().liveBpm`.
  4. Click `"Monitor"`, click `data-testid="dmx-cell-2"`, set the Park Override numeric value inside `park-inspector` to `"999"` and press `Enter`.
  5. Wait 100 ms and read `getDmxSlice(1, 2, 1)[0].val`.
- **Pass Criteria:**
  - `liveBpm` is clamped within valid engine bounds (`>= 20` and `<= 300`) and never `NaN`.
  - Parked DMX value is clamped to `<= 255` and never overflows or crashes.
  - Zero console or page errors.
- **Cleanup:** Set `aria-label="Live BPM"` back to `120`. Click `"Clear Parked"`.

---

### TC-13: Malformed OFL JSON Handling in Fixture Builder
- **Precondition:** App running.
- **Steps:**
  1. Click `"Fixtures"`.
  2. Locate `aria-label="Raw OFL JSON Editor"` (if collapsed/tabbed, switch to raw JSON view if needed).
  3. Fill `aria-label="Raw OFL JSON Editor"` with `{"name": "", "invalid": true}`.
  4. Wait 200 ms and verify the page remains responsive and displays a validation error message (does NOT crash or throw uncaught page errors).
- **Pass Criteria:**
  - App handles invalid OFL JSON gracefully with visible validation feedback.
  - Zero uncaught `pageerror` exceptions.
- **Cleanup:** Click `"Monitor"` tab.

---

### TC-14: Rapid Async IPC Race Test (Color Edit + Immediate Toggle Spam)
- **Precondition:** At least 1 fixture patched, on `"Studio / 2D Grid"` (`submode-builder`).
- **Steps:**
  1. Click the first scene tile (`[data-testid^="scene-tile-"]`).
  2. Click `data-testid="trait-tab-color"`.
  3. Fill `aria-label="RED Channel Fader value"` with `"200"`, press `Enter`, and **with zero artificial wait**, immediately click `data-testid="toggle-scene-controls-color"` 3 times in rapid succession (Off -> On -> Off).
  4. Wait 300 ms for all queued IPC calls to settle.
  5. Verify `data-testid="toggle-scene-controls-color"` has `aria-pressed="false"`.
  6. Click `data-testid="toggle-scene-controls-color"` once more, wait 200 ms, and verify `aria-pressed="true"` and `Number(RED) === 200`.
- **Pass Criteria:**
  - Final state matches deterministic serialized order (`false` after 3 toggles, `true` with `RED=200` after 4th toggle).
  - Zero console or page errors.
- **Cleanup:** None.

---

### TC-15: Delete Referenced Group & Undo Integrity Under Active Scene
- **Precondition:** At least 1 fixture patched, on `"Studio / 2D Grid"` (`submode-builder`).
- **Steps:**
  1. Fill `aria-label="Quick Selection Group Name"` with `"QA Temp Group"` and click `data-testid="create-group-from-fixtures-btn"`.
  2. Wait 150 ms and confirm `"QA Temp Group"` appears in `data-testid="daslight-groups-bar"`.
  3. Trigger the first scene (`[data-testid^="trigger-scene-"]`).
  4. Right-click `"QA Temp Group"` in `data-testid="daslight-groups-bar"` and click `aria-label="Delete group QA Temp Group"`.
  5. Wait 150 ms and confirm the app stays responsive with zero console/page errors.
  6. Click `aria-label="Undo"` and confirm `"QA Temp Group"` is restored.
- **Pass Criteria:**
  - Deleting a group while a scene is active does not crash the Rust engine or UI.
  - Undo restores the deleted group cleanly.
- **Cleanup:** Delete `"QA Temp Group"` again (optional) and click `aria-label="Release All Scenes"`.

---

### TC-16: Network Adapter Switch & TX Toggle Stress
- **Precondition:** App running.
- **Steps:**
  1. Record `const s1 = getStatus()`.
  2. Toggle `aria-label="Network Output Adapter"` to `"offline"` (`Offline Loopback`), wait 150 ms, verify `getStatus().isOffline === true`.
  3. Toggle `data-testid="toggle-network-output-btn"` ON then OFF twice (100 ms apart).
  4. Switch `aria-label="Network Output Adapter"` back to `"auto"` (`Auto Interface`), wait 250 ms.
  5. Record `const s2 = getStatus()`.
- **Pass Criteria:**
  - `s2.telemetry.tSec > s1.telemetry.tSec` (engine thread did not deadlock).
  - `s2.outputEnabled === false`.
  - Zero console or page errors.
- **Cleanup:** Ensure `Network Output Adapter` is `"auto"` and `toggle-network-output-btn` is OFF (`aria-pressed="false"`).

---

## 4C. Timeline Deep-Test Suite (TC-T01 to TC-T08)

### TC-T01: No Redundant Per-Timeline Scene Palette & Live DMX During Timeline Playback/Scrubbing
- **Precondition:** At least 1 fixture is patched at U1.001, and the first scene has non-zero Dimmer (100%) and Color (`RED=255`). Ensure all live scenes are released (`aria-label="Release All Scenes"`).
- **Steps:**
  1. Click `"Studio / 2D Grid"` and click `data-testid="submode-timeline"`.
  2. If `getStatus().timelineCount === 0`, click `"+ New Timeline"` and wait until `timelineCount >= 1`.
  3. Confirm `data-testid="timeline-scene-palette"` does **NOT** exist (`count === 0`) — scenes are dragged only from the upper Scene Banks (`[data-testid^="scene-tile-"]`).
  4. Drag the first `[data-testid^="scene-tile-"]` onto `data-testid="timeline-new-track-dropzone"` near the left edge (`~10%` width) so a clip is created on Track 1 starting near `t = 0..2s` (duration `4s`).
  5. Inspect `getTimelines()[0].tracks` to get the clip's exact `[start_sec, start_sec + duration_sec]`.
  6. Set `aria-label="Timeline Playhead Sec"` to `start_sec + 0.5` (inside the clip) and press `Space` (play) for 200 ms, then press `Space` (pause).
  7. Evaluate `window.__TAKTLIGHT_TEST__.getDmxSlice(1, 1, 1)[0].val` and `window.__TAKTLIGHT_TEST__.getCellPreviews()` while playhead is inside the clip.
  8. Set `aria-label="Timeline Playhead Sec"` to `Math.min(15.5, start_sec + duration_sec + 1.5)` (outside the clip), press `Space` for 150 ms, then `Space` (pause), and evaluate `getCellPreviews()`.
- **Pass Criteria:**
  - `data-testid="timeline-scene-palette"` count is `0`.
  - Inside clip bounds: `ch1 > 0` and at least one cell in `getCellPreviews()` has `d > 0` and `r > 0`.
  - Outside clip bounds: every cell in `getCellPreviews()` has `d === 0`.
- **Cleanup:** Ensure timeline is paused (`timelinePlaying === false`).

---

### TC-T02: Same-Track Non-Overlapping Clips (Drop & Horizontal Drag)
- **Precondition:** On Studio Timeline dock with Track 1 containing 1 clip (`c0` around `start=0..2s, dur=4s`).
- **Steps:**
  1. Record Track 1's `id` (`trkId`) and first clip's `[start0, dur0]`.
  2. Drag a scene tile (`[data-testid^="scene-tile-"]`) directly onto the middle of clip 0 inside `data-testid="track-lane-<trkId>"` (deliberately attempting to drop on top of clip 0).
  3. Wait 150 ms and inspect `getTimelines()[0].tracks` — verify that NO two clips on the same track overlap (`a.start_sec < b.start_sec + b.duration_sec - 0.01 && b.start_sec < a.start_sec + a.duration_sec - 0.01` is `false` for all pairs on every track).
  4. If both clips are on `trkId`, drag `data-testid="clip-body-<trkId>-1"` horizontally straight over `clip-body-<trkId>-0` (10 steps, mouse up).
  5. Wait 150 ms and verify again that zero pairs of clips on `trkId` overlap.
- **Pass Criteria:**
  - Dropping a scene directly on an existing clip never produces overlapping clips on the same track.
  - Dragging an existing clip horizontally into a neighbor clamps cleanly at the neighbor's boundary (zero overlap).
- **Cleanup:** None required.

---

### TC-T03: Drag Existing Clip Vertically to Another Track AND Below Last Track to Auto-Create Track (Live Visual Switch)
- **Precondition:** On Studio Timeline dock with at least 1 track containing a clip.
- **Steps:**
  1. Record `const trackCount0 = getTimelines()[0].trackCount`.
  2. Locate the first existing clip body (`[data-testid^="clip-body-"]`) and `data-testid="timeline-new-track-dropzone"`.
  3. Press mouse down on that `clip-body-*` and move vertically down onto the center of `data-testid="timeline-new-track-dropzone"` (10 steps) **without releasing yet**.
  4. Verify BEFORE releasing (`mouse.up()`) that `data-testid="timeline-clip-drag-preview"` is immediately visible inside `data-testid="timeline-new-track-dropzone"` (instant visual track switch).
  5. Release mouse (`mouse.up()`), wait 200 ms, and inspect `getTimelines()[0]`.
  6. Verify `trackCount === trackCount0 + 1` and the newly created last track contains the moved clip (`clips.length === 1`).
  7. Now press mouse down on that moved clip and move vertically back UP onto Track 1's lane (`[data-testid^="track-lane-"]` first track) at an open horizontal position (`75%` across lane width), **verify `data-testid="timeline-clip-drag-preview"` appears inside Track 1's lane BEFORE releasing**, then release (`mouse.up()`).
  8. Wait 200 ms and verify the clip moved back onto Track 1 without overlapping any existing clip.
- **Pass Criteria:**
  - Crossing a track border immediately renders `timeline-clip-drag-preview` inside the target lane / new-track dropzone BEFORE mouse release.
  - Releasing on `timeline-new-track-dropzone` creates a new track (`trackCount === trackCount0 + 1`) and moves the clip into it.
  - Dragging the clip back onto Track 1 moves it cleanly without overlap.
- **Cleanup:** None required.

---

### TC-T04: Clip Trimming (Start/End Non-Overlap Clamp) & Fade Handles
- **Precondition:** On Studio Timeline dock with at least 1 clip selected (`[data-testid^="timeline-clip-"]`).
- **Steps:**
  1. Click a clip (`[data-testid^="clip-body-"]`) so `data-testid="selected-clip-inspector"` is visible, and record its `start_sec`, `duration_sec`, `fade_in_sec`, `fade_out_sec`.
  2. Drag its `clip-trim-end-*` handle 60 px to the left (shorten), release, wait 150 ms, and verify `duration_sec` decreased (and remains `>= 0.1`, zero overlap).
  3. Drag its `clip-trim-start-*` handle 40 px to the right, release, wait 150 ms, and verify `start_sec` increased while `start_sec + duration_sec` stayed constant (within `0.15s`).
  4. Drag its `clip-fade-in-*` handle 30 px to the right, release, wait 150 ms, and verify `fade_in_sec > 0`.
  5. Drag its `clip-fade-out-*` handle 30 px to the left, release, wait 150 ms, and verify `fade_out_sec > 0`.
- **Pass Criteria:**
  - End trim updates `duration_sec` cleanly.
  - Start trim shifts `start_sec` and preserves clip end time.
  - Both fade handles update `fade_in_sec > 0` and `fade_out_sec > 0` with zero overlap and zero console errors.
- **Cleanup:** None required.

---

### TC-T05: Beats vs. Seconds Units, BPM Scaling, Ruler Click-to-Seek & Zoom
- **Precondition:** On Studio Timeline dock with an active timeline and at least 1 clip selected.
- **Steps:**
  1. Click `data-testid="timeline-unit-seconds"` and read `aria-label="Selected Clip Duration Sec"` (`durSec`).
  2. Click `data-testid="timeline-unit-beats"` and read `aria-label="Selected Clip Duration Sec"` (`durBeats`).
  3. Verify `Math.abs(durBeats - (durSec * liveBpm / 60)) < 0.25`.
  4. Click `data-testid="timeline-ruler"` at `50%` of its width and verify `Number(Timeline Playhead Sec)` jumps near `duration_sec * 0.5` (within `1.0s`).
  5. Click `data-testid="timeline-zoom-in"` twice, verify `data-testid="timeline-zoom-reset"` text is no longer `"1.0×"`.
  6. Click `data-testid="timeline-zoom-reset"`, verify text returns to `"1.0×"`.
- **Pass Criteria:**
  - Switching Seconds ↔ Beats converts displayed clip durations accurately using BPM.
  - Clicking `timeline-ruler` seeks playhead.
  - Zoom in and reset work with zero errors.
- **Cleanup:** None required.

---

### TC-T06: Time-Stretch Toggle, Inspector Nudge/Trim & Split at Playhead
- **Precondition:** On Studio Timeline dock with a clip of duration `>= 2s` selected.
- **Steps:**
  1. Ensure `data-testid="selected-clip-inspector"` is visible.
  2. Toggle `data-testid="clip-time-stretch-toggle"` ON (`aria-pressed="true"` or checked), wait 150 ms, and verify `time_stretch === true` in `getTimelines()[0].tracks`.
  3. Click `data-testid="nudge-clip-right-btn"` then `data-testid="nudge-clip-left-btn"` and verify `start_sec` shifts right then back without overlapping neighbors.
  4. Place playhead at the exact midpoint of the selected clip (`start_sec + duration_sec / 2`), click `data-testid="timeline-split-clip-btn"`, wait 150 ms.
  5. Verify clip count on that track increased by 1 and the two halves meet cleanly (`left.start_sec + left.duration_sec === right.start_sec` within `0.02s`) with zero overlap.
- **Pass Criteria:**
  - `clip-time-stretch-toggle` persists `time_stretch: true` to the Rust backend.
  - Nudge buttons shift clip safely without overlap.
  - Split divides clip into two contiguous non-overlapping halves.
- **Cleanup:** None required.

---

### TC-T07: Generic Track Typing, Right-Click Track Context Menu & Track Delete
- **Precondition:** On Studio Timeline dock with at least 1 empty or populated track.
- **Steps:**
  1. Right-click a track header (`[data-testid^="track-header-"]`).
  2. Verify `[data-testid^="track-context-menu-"]` opens and shows track type options (`Music`, `Effect`, `Untyped`).
  3. Close the menu (or switch an empty track's type) and verify `track_type` updates in `getTimelines()[0].tracks`.
  4. Verify `data-testid="timeline-add-music-btn"` is visible and clickable without errors (do not block on native OS file dialog; verify button presence and `aria-label="Add Music File"` hidden `<input type="file">`).
- **Pass Criteria:**
  - Right-click track context menu opens cleanly and updates track type on empty tracks.
  - Zero console or page errors.
- **Cleanup:** Close any open context menu by clicking the timeline header.

---

### TC-T08: Timeline Undo/Redo (`Ctrl+Z` / `Ctrl+Y`) & Standalone `Timeline` Tab Parity
- **Precondition:** On Studio Timeline dock with at least 1 clip.
- **Steps:**
  1. Record `const clipsBefore = getTimelines()[0].clipCount`.
  2. Select a clip and press `Delete`; wait 150 ms and verify `clipCount === clipsBefore - 1`.
  3. Press `Control+z`; wait 150 ms and verify `clipCount === clipsBefore`.
  4. Press `Control+y`; wait 150 ms and verify `clipCount === clipsBefore - 1`.
  5. Press `Control+z` to restore.
  6. Click bottom nav button `"Timeline"` and verify `data-testid="daslight-timeline-dock"` is visible, `data-testid="timeline-scene-palette"` is absent, and the same timeline + clips are displayed.
- **Pass Criteria:**
  - `Delete` -> `Ctrl+Z` -> `Ctrl+Y` cleanly undoes and redoes timeline clip changes in Rust state.
  - Standalone `"Timeline"` nav tab shows the exact same timeline without redundant scene palette.
- **Cleanup:** Return to `"Studio / 2D Grid"` (`submode-builder`).

---

## 5. Mandatory Report Output Format

After completing all test cases, output ONLY this structured report:

```markdown
# TaktLight QA Run Report

- **Date:** YYYY-MM-DD HH:MM
- **Mode:** Tauri Desktop (WebView2 CDP)
- **Baseline:** cargo test = PASS/FAIL | vitest = PASS/FAIL | playwright vite = PASS/FAIL | playwright tauri = PASS/FAIL

## Results Summary

| ID | Feature | Result | Key Evidence |
| :--- | :--- | :---: | :--- |
| TC-01 | Tauri IPC & 44 Hz Telemetry | PASS/FAIL | `isTauri=true, deltaDrops=0, p99Us=...` |
| TC-02 | DMX Monitor Park & Formats | PASS/FAIL | `ch1=192 -> C0 -> 75% -> 0, badge hidden` |
| TC-03 | Grand Master & Blackout | PASS/FAIL | `baseCh1>0, blackout(ch1=0,rgbw=0), GM=0.5` |
| TC-04 | Patch & Undo/Redo | PASS/FAIL | `patchCount N -> N+2 -> N -> N+2` |
| TC-05 | 2D Grid Drag & Negative Coords | PASS/FAIL | `x=-0.25, snapped drag ok` |
| TC-06 | Scene Rename & Color Toggle | PASS/FAIL | `name="QA Amber", red=128` |
| TC-07 | 2D Shader Gizmo & FX Close | PASS/FAIL | `gizmo delta ok, close stops FX` |
| TC-08 | Timeline DnD, Pause & Shortcuts | PASS/FAIL | `paused>=2.5, home=0` |
| TC-09 | Fixture Builder Add Mode | PASS/FAIL | `add-mode-btn ok` |
| TC-10 | Real Art-Net UDP 6454 | PASS/FAIL/SKIP | `artnetDmxPackets=N, ch1=255` |
| TC-11 | DMX Boundary Rollover & Resolve | PASS/FAIL | `no split/collision >512` |
| TC-12 | Out-of-Range Numeric Clamping | PASS/FAIL | `bpm clamped, park<=255` |
| TC-13 | Malformed OFL JSON Handling | PASS/FAIL | `validation feedback, 0 pageErrors` |
| TC-14 | Rapid Color + Toggle IPC Race | PASS/FAIL | `final pressed=true, red=200` |
| TC-15 | Delete Group & Undo Under Scene | PASS/FAIL | `delete + undo ok, 0 errors` |
| TC-16 | Adapter Switch & TX Stress | PASS/FAIL | `engine alive, tx off, 0 errors` |
| TC-T01 | Timeline Palette Removed & Live DMX | PASS/FAIL | `palette=0, inClip>0, outClip=0` |
| TC-T02 | Timeline Non-Overlapping Clips | PASS/FAIL | `drop & drag 0 overlaps` |
| TC-T03 | Existing Clip Drag Cross-Track & New Track | PASS/FAIL | `new track created, moved back ok` |
| TC-T04 | Timeline Trim Clamping & Fades | PASS/FAIL | `trim & fadeIn/Out>0, 0 overlaps` |
| TC-T05 | Timeline Beats/Sec, Ruler Seek & Zoom | PASS/FAIL | `beats/sec match, ruler seek & zoom ok` |
| TC-T06 | Time-Stretch, Nudge & Split | PASS/FAIL | `time_stretch=true, split contiguous` |
| TC-T07 | Track Context Menu & Music Button | PASS/FAIL | `context menu & track_type ok` |
| TC-T08 | Timeline Undo/Redo & Tab Parity | PASS/FAIL | `del->undo->redo ok, tab parity ok` |

## Failures (if any)

### [TC-XX] Short Failure Title
- **Step Failed:** Step N
- **Expected:** ...
- **Actual:** ...
- **Console / Page Errors:** ...
- **Bridge Snapshot:** `<JSON from getStatus()>`
- **Screenshot:** `test-results/qa_TC-XX.png`
```
