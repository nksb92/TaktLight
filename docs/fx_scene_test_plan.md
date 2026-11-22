# TaktLight FX Scene Creation & Plausibility Test Plan

## 1. Objective
Verify that all 6 procedural FX scene types (`color_fx`, `color_mappings`, `chaser_fx`, `value_fx`, `curve_fx`, `mappings`) can be created, have their parameters adapted, and produce physically and mathematically plausible DMX512 and 2D preview (`cell_preview_rgbd`) outputs across both the TypeScript simulation mixer and the Rust 44 Hz engine.

---

## 2. FX Scene Test Matrix (All 6 Types)

Test fixture baseline: 1x `RLCV3 8-Segment RGBW Tube` (`34ch Pixel Mode`, U1.001, 8 cells, `Master Dimmer` Ch 1, `Strobe` Ch 2, 8x RGBW Ch 3..34).
For color-only FX (`color_fx`, `color_mappings`), pair with a static `master_dimmer = 1.0` / `dimmer = 1.0` so pixels are lit; for dimmer-only FX (`chaser_fx`, `value_fx`, `curve_fx`, `mappings`), pair with a static color (`#FFFFFF` or `#FF0000`) so intensity modulation is observable on RGBW channels.

| ID | FX Scene Type | Element Kind & Trait | Parameters Adapted | Plausibility Assertions |
| :--- | :--- | :--- | :--- | :--- |
| **FX-01** | `color_fx` | `curve_1d`, `trait: "color"`, `fx_kind_tag: "color_fx"` | `inline_colors`, `grayscale` (`false -> true`), `angle_deg` (`0 -> 180`), `color_width` (`1.0 -> 2.0`), `gradient` (`1.0 -> 0.0`), `rate_cycles` | 1. Distinct non-zero RGB/RGBW across cells at `t = 0`.<br>2. Output evolves over time (`t = 0` vs `t = 0.5s`).<br>3. `grayscale = true` equalizes R/G/B (or drives pure W in `replace` mode) with zero chroma.<br>4. `angle_deg = 180` reverses temporal travel direction relative to `angle_deg = 0`.<br>5. Increasing `color_width` reduces cell-to-cell color spread. |
| **FX-02** | `color_mappings` | `spatial_shader_2d`, `trait: "color"` | `shader` (`linear_sweep`, `radial_wave`, `pinwheel`, `plasma`), `transform` (`none`, `mirror_x`, `invert`), `spatial_freq`, `center_x`/`center_y`, `grayscale`, `gradient` | 1. Cells inside gizmo box receive valid non-zero colors; moving `center_x`/`center_y` away from fixture darkens out-of-bounds cells (`0`).<br>2. `mirror_x` flips horizontal cell color distribution.<br>3. `grayscale = true` removes chroma.<br>4. All 4 shaders produce valid `[0..255]` DMX and evolve over time. |
| **FX-03** | `chaser_fx` | `step_chase`, `trait: "dimmer"` | `pixels_on` (`1 -> 3`), `one_way` (`true -> false`), `fade` (`0 -> 0.8`), `order` (`linear -> reverse`), `rate_cycles` | 1. `pixels_on = 1, fade = 0`: strictly fewer lit cells than `pixels_on = 3`.<br>2. Active lit pixel index advances over time.<br>3. `one_way = false` bounces back on second half of cycle (`phase = 0.25` matches `phase = 0.75`).<br>4. `fade > 0` introduces intermediate partial-brightness neighbor cells.<br>5. `order = "reverse"` mirrors lit cell indices. |
| **FX-04** | `value_fx` | `curve_1d`, `trait: "dimmer"`, `fx_kind_tag: "value_fx"` | `value_stops` (`[1, 0.5, 0]` -> `[0.2, 1.0]`), `gradient` (`1.0 -> 0.0`), `phase_deg`, `phase_spread_deg` (`360 -> 0`), `order` | 1. With `phase_spread_deg = 360`, cells span high-to-low DMX values.<br>2. With `phase_spread_deg = 0`, all 8 cells output identical DMX values at any `t`.<br>3. `gradient = 0` snaps outputs strictly to quantized stop levels.<br>4. Raising minimum `value_stops` raises minimum cell DMX proportionally. |
| **FX-05** | `curve_fx` | `curve_1d`, `trait: "dimmer"` / `"red"` | `waveform` (`sine`, `square`, `pulse`, `saw`, `triangle`), `duty` (`0.25 -> 0.75`), `amplitude`/`offset` (range min/max), `phase_spread_deg`, `trait` (`dimmer -> red`) | 1. `square` produces binary high/low DMX (no mid-values when `phase_spread_deg = 0`).<br>2. `pulse` with `duty = 0.25` is dark at `phase = 0.5`, lit when `duty = 0.75`.<br>3. Reducing amplitude/raising offset bounds DMX within `[min, max]`.<br>4. `phase_spread_deg = 0` synchronizes all cells; `360` spreads wave across tube.<br>5. Switching `trait` to `red` (TS mixer) modulates only Red channels. |
| **FX-06** | `mappings` | `spatial_shader_2d`, `trait: "dimmer"` | `shader` (`linear_sweep`, `radial_wave`, `pinwheel`, `plasma`), `value_stops`, `gradient` (`1.0 -> 0.0`), `transform` (`mirror_x`), `center_x`/`center_y`, `spatial_freq` | 1. Cells inside gizmo box receive spatially varying dimmer DMX.<br>2. Moving `center_x` outside fixture bounds zeroes dimmer output.<br>3. `transform = "mirror_x"` reverses spatial dimmer gradient across cells.<br>4. Changing `value_stops` to `[0.5, 0.5]` clamps all in-bounds cells to ~50% intensity.<br>5. Output evolves over time across all 4 shaders. |

---

## 3. Automated Implementation Layers

1. **Rust Core Engine (`crates/taktlight-engine/src/engine/evaluator.rs`):**
   - Compiles full `ShowState -> RenderPlan` and runs `Engine::evaluate_frame` for all 6 FX types (`FX-01` through `FX-06`), verifying parameter mutations, temporal evolution, spatial bounds, and `cell_preview_rgbd` plausibility.
2. **TypeScript Simulation Mixer (`src/lib/__tests__/fxScenesPlausibility.test.ts`):**
   - Evaluates all 6 FX types through `evaluateSimulationLayersToDmx` with parameter adaptation and plausibility assertions.
3. **Frontend UI Integration (`src/components/__tests__/fxSceneCreation.test.tsx`):**
   - Renders `<App />`, patches an RLCV3 tube, creates each of the 6 FX scenes via `fx-picker-tile-*`, edits UI controls (`Grayscale`, `Color Width`, `Color FX Angle`, `FX Shader Kind`, `Mapping Transform`, `Nb pixels on`, `One Way Only`, `Chaser Fading`, `Add Value Stop`, `Curve Phasing`, `FX Waveform`, `Curve Duty Pct`, `FX Target Channel`, `Gradient`, `FX Rate Cycles`), triggers the scene, and asserts store state + live DMX output plausibility.

---

## 4. Other Application Areas Requiring Tests

| Area / File | Current State | Required Tests |
| :--- | :--- | :--- |
| **Rust vs. TS FX Parity** (`crates/taktlight-engine/src/fx/scene.rs` vs. `src/lib/mixerLogic.ts`) | No cross-engine parity tests; `scene.rs` currently maps non-`color`/non-`master_dimmer` scalar traits (`red`, `green`, `blue`, `white`) to `dimmer` only and does not handle `master_dimmer` on `StepChase`/`SpatialShader2D`. | Golden parity suite comparing `Engine::evaluate_frame` and `evaluateSimulationLayersToDmx` outputs per FX type + XML round-trip tests for all new FX attributes (`fx_kind_tag`, `value_stops`, `inline_colors`, `grayscale`, `color_width`, `gradient`, `angle_deg`, `transform`, `pixels_on`, `one_way`). |
| **`PalettesAndControls.tsx`** (2,365 lines) | Only basic palette creation and RED fader toggle covered. | HS color wheel drag/input, RGBW slider sync, multi-fixture selection dimmer/color editing, hardware vs. software strobe controls, custom fixture control channel faders. |
| **`FixtureGrid2D.tsx`** (1,620 lines) | Basic `GridPos` input and snap toggle covered. | 2D shader gizmo drag/resize/rotate math, multi-fixture marquee selection, cell-level click/pattern selection, negative coordinate rendering & hit-testing, fixture rotation/scale handles. |
| **`PatchView.tsx`** (1,388 lines) | Dual-universe split & rollover covered. | Universe Art-Net/sACN protocol switching (broadcast/unicast/multicast), address collision rejection UI, bulk fixture patching, unpatch + undo, per-fixture calibration (`gamma`, `white_mode`, `min/max_dimmer_dmx`). |
| **`FixtureBuilder.tsx`** (945 lines) | Basic draft save, raw JSON invalid schema, control channel delete covered. | Multi-mode add/delete/edit, matrix `pixelCountX`/`Y` layout generation, RGB/RGBW/RGBAW channel generation, 16-bit fine channel offsets, editing & overwriting existing user fixtures. |
| **`TimelineRightInspector.tsx`** (785 lines) | Basic clip start/dur/fade numeric inputs covered. | Tempo map point add/edit/delete, audio offset & transient sensitivity updates, time-stretch source duration preservation, multi-track target group overrides. |
| **`TopStatusBar.tsx` & `StudioWorkspace.tsx`** | Basic GM, blackout, TX toggle covered. | Network adapter switching (`auto`/`offline`/specific NIC), project Save/Open/New dirty-state transitions, key-binding assignment & live keyboard trigger conflict handling. |
| **Playwright / Tauri E2E** (`e2e/taktlight.spec.ts`, `e2e/tauri.smoke.spec.ts`) | 0 animated FX creation E2E tests. | Real-browser / WebView2 CDP E2E creating each FX type, adjusting controls, and asserting live Rust DMX via `window.__TAKTLIGHT_TEST__.getDmxSlice(...)`. |
