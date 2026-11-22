# TaktLight: App Review TODO

Source: [usage_notes.md](usage_notes.md) (review 2026-11-19).
Ordered by priority: bugs first, then UX fixes, then features and larger restructuring.

---

## P0: Bugs (wrong behavior)

- [x] **2D preview shows white for dimmer only fixtures.** With only the dimmer active at 100 %, the 2D grid renders the fixture white. Fix the preview color derivation so a fixture without an active color source renders with its default/neutral color (or dimmer intensity only), not an implied white mix.
  - Check: `FixtureGrid2D.tsx` (fixture color render), `lib/mixerLogic.ts` (preview color resolution).
- [x] **Scene color resets on toggle.** Deactivating and re-activating the color attribute of a scene resets the color to default. Toggle must only flip the enabled flag and keep the stored value.
  - Check: `SceneAndFxManager.tsx` scene attribute toggle, `store/useTaktStore.ts` scene update action.
- [x] **FX keeps running after closing the FX menu via "X".** Closing the FX panel returns to the matrix view, but the effect continues to output. Setting a color via the color picker does not override it, although the scene shows the correct color.
  - **Decided:** closing the FX menu via "X" on an active scene removes that effect from the scene. The effect stops outputting immediately and the scene's static values (e.g. color picker) take over. Should be undoable.
  - Check: FX editor close handler in `SceneAndFxManager.tsx`, preview FX lifecycle in store/engine (`fx/scene.rs`, `engine/runner.rs`).
- [x] **2D shader gizmo has no effect on mappings.** Dragging center/angle/scale does nothing visible. Verify that `commitShaderGizmoUpdate` → `upsertFxBlock` reaches the engine and that the evaluator uses the updated `center_x`, `center_y`, `direction_deg`, `spatial_freq`. Also confirm the gizmo targets the correct block when `activeShaderGizmoBlockId` is unset (current fallback picks the first shader block in the library).
  - Check: `FixtureGrid2D.tsx` L117–143, L534–548; `fx/evaluators.rs`, `show/spatial.rs`.
- [x] **Timeline pause resets playhead.** Pause/stop jumps the playhead back to origin. Pause must hold the current position; a separate "return to start" action (or second stop press) can reset.
  - Check: `TimelineEditor.tsx` transport handlers, store transport state.

## P1: UX fixes on existing features

### Inputs
- [x] **Remove spinner arrows from number inputs where a slider already sets the value.** Keep plain text entry there.
  - **Decided:** arrows stay only on fields without a slider (e.g. 2D grid x/y coordinate fields). Every slider-backed input loses them.
  - Affected: `NumericSlider.tsx` (L130, L233), plus `type="number"` fields in `PatchView.tsx`, `PalettesAndControls.tsx`, `SceneAndFxManager.tsx`, `FixtureGrid2D.tsx`, `FixtureBuilder.tsx`.
- [x] **Theme the remaining spinner arrows.** Arrow color does not match the dark theme. Hide native spinners via CSS and, where needed, use a custom styled stepper in `index.css` / `styles/theme.ts`.

### Scenes
- [x] **Rename scenes via right click menu and via double click on the name.** Scene banks already support rename (`renameSceneBank`), individual scenes do not.

### Fixture Builder
- [x] **Make "add mode" discoverable.** Add a clearly labeled "Add Mode" button in the modes section, plus an empty state hint when a fixture has no modes yet.
  - Check: `FixtureBuilder.tsx`.

### 2D Grid
- [x] **Allow negative coordinates / stop clipping at 0.** Fixtures at x=0 are half cut off. Either center fixtures on their coordinate with padding around the canvas, or allow panning into negative space.
- [x] **Enlarge the layout space.** Bigger canvas or virtual canvas with pan/zoom so larger rigs fit.
- [x] **Fix laggy and glitchy fixture dragging.** Likely cause: store write (and possibly backend call/undo snapshot) per mousemove. Keep drag position in local state / ref, render on `requestAnimationFrame`, commit to store once on mouse up.
  - Check: `FixtureGrid2D.tsx` drag handlers (around L554–720).
- [x] **Optional:** snap to grid toggle for placing fixtures cleanly.

### Timeline
- [x] **Clip selection visibility.** Selection highlight and clips are both orange. Use a contrasting selection style (white/cyan outline, brighter border, or desaturated unselected clips).
- [x] **Laggy track/clip movement.** Same fix pattern as the 2D grid: local drag state, rAF rendering, single commit on drop.
- [x] **Keyboard shortcuts.** At minimum: Space = play/pause, Home = jump to start, Delete = delete selected clip, Ctrl+Z / Ctrl+Y = undo/redo, Ctrl+D = duplicate clip. Ignore shortcuts while a text input has focus.

## P2: Timeline interaction rework (drag and drop)

Currently no drag and drop exists in `TimelineEditor.tsx`; clips are added via the side menu/button.

- [x] **Drag and drop clips from scene/FX library onto the timeline** at the drop position (time + track).
- [x] **Drop below the last track creates a new track automatically.**
- [x] **Remove the "new track" option** once auto track creation works.
- [x] **Remove the "add clip" panel on the right side**; adding clips is drag and drop only.
- [x] **Move clips between tracks via drag and drop** (vertical drag changes track, horizontal drag changes start time).
- [x] **Add music via drag and drop** (drop audio file from OS onto a track) **and via an icon button** in the timeline toolbar.
- [x] **Generic tracks instead of fixed music/effect tracks.** New tracks are created untyped; the system assigns the type from the first clip dropped onto it (audio → music track, scene/FX → effect track). Track type is also switchable via right click menu per track.
  - **Decided:** one type per track, no mixed tracks. Dropping a clip of the wrong type onto a typed track is rejected (or redirected to a new track of the right type). Switching type via right click is only allowed when the track is empty, or requires confirmation that removes incompatible clips.
  - Check: track type model in store and `show/xml.rs` (save format) / `show/compiler.rs`.

## P3: Timeline features

- [x] **Beat based durations.** Clip length and position editable in beats (bars/beats grid) instead of seconds, with tempo from the show BPM. Keep seconds as display option.
- [x] **Time-stretch mode for effect clips (Daslight style).** In this mode, resizing a clip rescales the effect so the full cycle still fits (e.g. a 5 s sine 0°→360° resized to 4 beats still runs 0°→360°). Needs a per clip "stretch vs. loop/trim" flag and evaluator support for a phase scale factor.
  - Check: `engine/evaluator.rs`, `fx/evaluators.rs`, clip model in store.

## P4: Layout decision

- [x] **Decide: merge timeline into the Studio / 2D grid page.** No light preview is visible in timeline mode. Options:
  1. Timeline as a bottom dock inside `StudioWorkspace.tsx` with the 2D grid above (Daslight layout).
  2. Keep a separate timeline page but embed a compact 2D preview.
  - Recommendation: option 1, since live preview while editing clips is the core workflow. Do this before the P2 drag and drop rework, so drag sources (scene/FX library) and the drop target live on the same page.
