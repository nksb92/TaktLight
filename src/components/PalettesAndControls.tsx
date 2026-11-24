import {
  AlertTriangle,
  Palette,
  Play,
  Plus,
  Power,
  Redo2,
  Sun,
  SunMedium,
  Trash2,
  Undo2,
  Users,
  Zap,
} from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useMemo, useRef, useState } from "react";
import {
  type FxElementDef,
  hasSoftwareStrobeOverCap,
  type ShutterState,
  type SmartControlLayer,
} from "../lib/mixerLogic";
import type { OrderRuleStr } from "../lib/patchLogic";
import { useTaktStore } from "../store/useTaktStore";
import { ColorPaletteBuilderModal } from "./ColorPaletteBuilderModal";
import { NumericSlider } from "./NumericSlider";

type TraitCategory = "dimmer" | "color" | "beam" | "fader";

function slugId(prefix: string, name: string, existingIds: string[]): string {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = `${prefix}_${clean || "item"}`;
  if (!existingIds.includes(base)) return base;
  let suffix = 2;
  while (existingIds.includes(`${base}_${suffix}`)) {
    suffix += 1;
  }
  return `${base}_${suffix}`;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function hsvToRgb(hDeg: number, s: number, v: number): [number, number, number] {
  const h = ((hDeg % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (h < 60) [r1, g1, b1] = [c, x, 0];
  else if (h < 120) [r1, g1, b1] = [x, c, 0];
  else if (h < 180) [r1, g1, b1] = [0, c, x];
  else if (h < 240) [r1, g1, b1] = [0, x, c];
  else if (h < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "").trim();
  if (clean.length !== 6) return [255, 85, 0];
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return [255, 85, 0];
  return [r, g, b];
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const r1 = r / 255;
  const g1 = g / 255;
  const b1 = b / 255;
  const max = Math.max(r1, g1, b1);
  const min = Math.min(r1, g1, b1);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === r1) h = 60 * (((g1 - b1) / d) % 6);
    else if (max === g1) h = 60 * ((b1 - r1) / d + 2);
    else h = 60 * ((r1 - g1) / d + 4);
  }
  if (h < 0) h += 360;
  const s = max <= 1e-6 ? 0 : d / max;
  return { h, s, v: max };
}

export function PalettesAndControls({
  hideUndoRedo = false,
  hideGroups = false,
  daslightDock = false,
}: {
  hideUndoRedo?: boolean;
  hideGroups?: boolean;
  daslightDock?: boolean;
}) {
  const showState = useTaktStore((s) => s.showState);
  const liveLayers = useTaktStore((s) => s.liveLayers);
  const compiledCells = useTaktStore((s) => s.compiledCells);
  const cellPreviewRgbd = useTaktStore((s) => s.cellPreviewRgbd);
  const fixtureDetailsCache = useTaktStore((s) => s.fixtureDetailsCache);
  const activeGroupFilterId = useTaktStore((s) => s.activeGroupFilterId);
  const selectedSceneId = useTaktStore((s) => s.selectedSceneId);
  const canUndo = useTaktStore((s) => s.canUndo);
  const canRedo = useTaktStore((s) => s.canRedo);

  const upsertColorPalette = useTaktStore((s) => s.upsertColorPalette);
  const deleteColorPalette = useTaktStore((s) => s.deleteColorPalette);
  const upsertDimmerPalette = useTaktStore((s) => s.upsertDimmerPalette);
  const deleteDimmerPalette = useTaktStore((s) => s.deleteDimmerPalette);
  const upsertGroup = useTaktStore((s) => s.upsertGroup);
  const setLiveLayers = useTaktStore((s) => s.setLiveLayers);
  const undoShow = useTaktStore((s) => s.undoShow);
  const redoShow = useTaktStore((s) => s.redoShow);

  const [traitCategory, setTraitCategory] = useState<TraitCategory>("dimmer");
  const [autoWhite, setAutoWhite] = useState(false);

  const [colorName, setColorName] = useState("Neon Sunset");
  const [colorStartHex, setColorStartHex] = useState("#FF5500");
  const [colorEndHex, setColorEndHex] = useState("#2255AA");

  const [dimmerName, setDimmerName] = useState("Studio 75%");
  const [dimmerStart, setDimmerStart] = useState(0.75);
  const [dimmerEnd, setDimmerEnd] = useState(0.75);

  const [groupName, setGroupName] = useState("Stage Front");
  const [groupOrder, setGroupOrder] = useState<OrderRuleStr>("center_out");
  const [groupTargets, setGroupTargets] = useState(
    showState.patch[0]?.id ?? "fx_001",
  );

  const [layerSeq, setLayerSeq] = useState(1);
  const hsSquareRef = useRef<HTMLDivElement | null>(null);
  const [pickingHs, setPickingHs] = useState(false);
  const [paletteBuilderOpen, setPaletteBuilderOpen] = useState(false);

  const paletteUsageCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const blk of showState.fx_library) {
      for (const el of blk.elements) {
        if (el.kind !== "scene_sequence" && el.palette_ref) {
          counts[el.palette_ref] = (counts[el.palette_ref] ?? 0) + 1;
        }
      }
    }
    for (const l of liveLayers) {
      if (
        (l.trait_spec.trait_kind === "color" ||
          l.trait_spec.trait_kind === "dimmer") &&
        l.trait_spec.palette_ref
      ) {
        const pRef = l.trait_spec.palette_ref;
        counts[pRef] = (counts[pRef] ?? 0) + 1;
      }
    }
    return counts;
  }, [liveLayers, showState.fx_library]);

  const activeShutterLayer = liveLayers.find(
    (l) => l.trait_spec.trait_kind === "shutter",
  );

  // Selected scene & its backing FX block for direct Scene-bound Dimmer/Color editing
  const selectedScene = useMemo(
    () =>
      showState.scenes.find((s) => s.id === selectedSceneId) ??
      showState.scenes[0] ??
      null,
    [selectedSceneId, showState.scenes],
  );

  const selectedSceneBlock = useMemo(() => {
    if (!selectedScene) return null;
    const refId = selectedScene.block_refs[0];
    return showState.fx_library.find((b) => b.id === refId) ?? null;
  }, [selectedScene, showState.fx_library]);

  const hasFixtureMasterDimmer = useMemo(() => {
    for (const fx of showState.patch) {
      const detail = fixtureDetailsCache[fx.profile];
      const mode = detail?.expanded_modes.find((m) => m.name === fx.mode);
      if (
        mode?.channels.some(
          (ch) =>
            ch.target.scope === "fixture" && ch.role.kind === "intensity",
        )
      ) {
        return true;
      }
    }
    return false;
  }, [fixtureDetailsCache, showState.patch]);

  const sceneDimmerEl = selectedSceneBlock?.elements.find(
    (e) => e.kind === "static_trait" && e.trait === "dimmer",
  );
  const sceneMasterDimmerEl = selectedSceneBlock?.elements.find(
    (e) => e.kind === "static_trait" && e.trait === "master_dimmer",
  );
  const sceneColorEl = selectedSceneBlock?.elements.find(
    (e) => e.kind === "static_trait" && e.trait === "color",
  );

  const sceneControlsDimmer = Boolean(sceneDimmerEl);
  const sceneControlsMasterDimmer = Boolean(sceneMasterDimmerEl);
  const sceneControlsColor = Boolean(sceneColorEl);

  const savedSceneTraitsRef = useRef<
    Record<
      string,
      Partial<Record<"dimmer" | "master_dimmer" | "color", FxElementDef>>
    >
  >({});
  const traitOpChainRef = useRef<Promise<void>>(Promise.resolve());

  const enqueueTraitOp = (op: () => Promise<void>): Promise<void> => {
    const next = traitOpChainRef.current.then(op, op);
    traitOpChainRef.current = next.catch(() => undefined);
    return next;
  };

  const currentDimmerVal = useMemo(() => {
    if (sceneDimmerEl && sceneDimmerEl.kind === "static_trait") {
      if (sceneDimmerEl.palette_ref) {
        const pal = showState.dimmer_palettes.find(
          (p) => p.id === sceneDimmerEl.palette_ref,
        );
        if (pal) return pal.value_start;
      }
      return sceneDimmerEl.value_start ?? 1;
    }
    return 0;
  }, [sceneDimmerEl, showState.dimmer_palettes]);

  const currentMasterDimmerVal = useMemo(() => {
    if (sceneMasterDimmerEl && sceneMasterDimmerEl.kind === "static_trait") {
      return sceneMasterDimmerEl.value_start ?? 1;
    }
    return 0;
  }, [sceneMasterDimmerEl]);

  const currentColorHex = useMemo(() => {
    if (sceneColorEl && sceneColorEl.kind === "static_trait") {
      if (sceneColorEl.palette_ref) {
        const pal = showState.color_palettes.find(
          (p) => p.id === sceneColorEl.palette_ref,
        );
        if (pal) return pal.hex_start;
      }
      if (sceneColorEl.hex_start) return sceneColorEl.hex_start;
    }
    return colorStartHex;
  }, [colorStartHex, sceneColorEl, showState.color_palettes]);

  const [curR, curG, curB] = hexToRgb(currentColorHex);
  const curHsv = rgbToHsv(curR, curG, curB);

  const applySceneTraitElementNow = async (
    traitName: "dimmer" | "master_dimmer" | "color",
    nextElement: FxElementDef | null,
  ) => {
    const storeState = useTaktStore.getState();
    const freshShow = storeState.showState;
    const freshScene =
      freshShow.scenes.find((s) => s.id === storeState.selectedSceneId) ??
      freshShow.scenes[0] ??
      null;
    if (!freshScene) return;

    const freshBlockRef = freshScene.block_refs[0];
    const freshBlock = freshBlockRef
      ? (freshShow.fx_library.find((b) => b.id === freshBlockRef) ?? null)
      : null;

    const targetBlockId = freshBlock?.id ?? `blk_scene_${freshScene.id}`;
    const blockName = freshBlock?.name ?? `${freshScene.name} Look`;
    const prevElements = freshBlock?.elements ?? [];
    const prevStatic = prevElements.filter((el) => el.kind === "static_trait");
    const prevProcedural = prevElements.filter((el) => el.kind !== "static_trait");
    let nextStatic: FxElementDef[];
    if (nextElement === null) {
      nextStatic = prevStatic.filter((el) => el.trait !== traitName);
    } else {
      const idx = prevStatic.findIndex((el) => el.trait === traitName);
      if (idx >= 0) {
        nextStatic = prevStatic.map((el, i) => (i === idx ? nextElement : el));
      } else {
        nextStatic = [...prevStatic, nextElement];
      }
    }
    const nextElements = [...nextStatic, ...prevProcedural];

    const sceneDurVal = freshScene.duration_value ?? 4;
    const sceneDurUnit = freshScene.duration_unit ?? "beats";

    await storeState.upsertFxBlock({
      id: targetBlockId,
      name: blockName,
      target_group:
        freshBlock?.target_group ?? (storeState.activeGroupFilterId || "all"),
      duration_beats:
        freshBlock?.duration_beats ??
        (sceneDurUnit === "beats" ? sceneDurVal : 4),
      duration_sec:
        freshBlock?.duration_sec ??
        (sceneDurUnit === "seconds" ? sceneDurVal : null),
      loop_block: freshBlock?.loop_block ?? true,
      elements: nextElements,
    });

    const latestShow = useTaktStore.getState().showState;
    const latestScene =
      latestShow.scenes.find((s) => s.id === freshScene.id) ?? freshScene;
    if (!latestScene.block_refs.includes(targetBlockId)) {
      await useTaktStore.getState().upsertScene({
        ...latestScene,
        block_refs: [targetBlockId, ...latestScene.block_refs],
      });
    }
  };

  const upsertSceneTraitElement = (
    traitName: "dimmer" | "master_dimmer" | "color",
    nextElement: FxElementDef | null,
  ) => enqueueTraitOp(() => applySceneTraitElementNow(traitName, nextElement));

  const toggleSceneColorTrait = (fallbackHex: string) =>
    enqueueTraitOp(async () => {
      const storeState = useTaktStore.getState();
      const freshShow = storeState.showState;
      const freshScene =
        freshShow.scenes.find((s) => s.id === storeState.selectedSceneId) ??
        freshShow.scenes[0] ??
        null;
      if (!freshScene) return;

      const freshBlockRef = freshScene.block_refs[0];
      const freshBlock = freshBlockRef
        ? (freshShow.fx_library.find((b) => b.id === freshBlockRef) ?? null)
        : null;
      const freshColorEl = freshBlock?.elements.find(
        (e) => e.kind === "static_trait" && e.trait === "color",
      );

      if (freshColorEl) {
        savedSceneTraitsRef.current[freshScene.id] = {
          ...savedSceneTraitsRef.current[freshScene.id],
          color: freshColorEl,
        };
        if (freshColorEl.kind === "static_trait" && freshColorEl.hex_start) {
          setColorStartHex(freshColorEl.hex_start);
          setColorEndHex(freshColorEl.hex_end ?? freshColorEl.hex_start);
        } else {
          setColorStartHex(fallbackHex);
        }
        await applySceneTraitElementNow("color", null);
      } else {
        const saved = savedSceneTraitsRef.current[freshScene.id]?.color;
        if (saved) {
          if (saved.kind === "static_trait" && saved.hex_start) {
            setColorStartHex(saved.hex_start);
            setColorEndHex(saved.hex_end ?? saved.hex_start);
          }
          await applySceneTraitElementNow("color", saved);
        } else {
          setColorStartHex(fallbackHex);
          setColorEndHex(fallbackHex);
          await applySceneTraitElementNow("color", {
            kind: "static_trait",
            trait: "color",
            op: "ltp",
            palette_ref: null,
            value_start: 0,
            value_end: 0,
            hex_start: fallbackHex,
            hex_end: fallbackHex,
            order: null,
          });
        }
      }
    });

  const setSceneDimmerValue = (val01: number) => {
    const clamped = clamp01(val01);
    void upsertSceneTraitElement("dimmer", {
      kind: "static_trait",
      trait: "dimmer",
      op: "htp",
      palette_ref: null,
      value_start: clamped,
      value_end: clamped,
      order: null,
    });
  };

  const setSceneMasterDimmerValue = (val01: number) => {
    const clamped = clamp01(val01);
    void upsertSceneTraitElement("master_dimmer", {
      kind: "static_trait",
      trait: "master_dimmer",
      op: "ltp",
      palette_ref: null,
      value_start: clamped,
      value_end: clamped,
      order: null,
    });
  };

  const setSceneStaticColorHex = (hex: string) => {
    setColorStartHex(hex);
    setColorEndHex(hex);
    void upsertSceneTraitElement("color", {
      kind: "static_trait",
      trait: "color",
      op: "ltp",
      palette_ref: null,
      value_start: 0,
      value_end: 0,
      hex_start: hex,
      hex_end: hex,
      order: null,
    });
  };

  const setSceneColorPalette = (paletteId: string) => {
    const pal = showState.color_palettes.find((p) => p.id === paletteId);
    if (pal) {
      setColorStartHex(pal.hex_start);
      setColorEndHex(pal.hex_end);
    }
    void upsertSceneTraitElement("color", {
      kind: "static_trait",
      trait: "color",
      op: "ltp",
      palette_ref: paletteId,
      value_start: 0,
      value_end: 1,
      hex_start: null,
      hex_end: null,
      order: "linear",
    });
  };

  const setLiveShutterState = (nextState: ShutterState) => {
    const existing = liveLayers.find(
      (l) => l.trait_spec.trait_kind === "shutter",
    );
    if (existing) {
      void setLiveLayers(
        liveLayers.map((l) =>
          l.id === existing.id
            ? {
                ...l,
                enabled: true,
                target: activeGroupFilterId || "all",
                trait_spec: { trait_kind: "shutter", state: nextState },
              }
            : l,
        ),
      );
      return;
    }

    const nextTrigger =
      liveLayers.reduce((m, l) => Math.max(m, l.trigger_order), 0) + 1;
    const seq = layerSeq;
    setLayerSeq(seq + 1);
    const created: SmartControlLayer = {
      id: `layer_${seq}`,
      name: `Shutter ${seq}`,
      enabled: true,
      priority: 3,
      trigger_order: nextTrigger,
      alpha: 1,
      target: activeGroupFilterId || "all",
      order_override: null,
      trait_spec: { trait_kind: "shutter", state: nextState },
    };
    void setLiveLayers([...liveLayers, created]);
  };

  const linkPaletteToLiveLayer = (
    kind: "color" | "dimmer",
    paletteId: string,
  ) => {
    const existing = liveLayers.find((l) => l.trait_spec.trait_kind === kind);
    if (existing) {
      void setLiveLayers(
        liveLayers.map((l) => {
          if (l.id !== existing.id) return l;
          if (kind === "color" && l.trait_spec.trait_kind === "color") {
            return {
              ...l,
              enabled: true,
              trait_spec: { ...l.trait_spec, palette_ref: paletteId },
            };
          }
          if (kind === "dimmer" && l.trait_spec.trait_kind === "dimmer") {
            return {
              ...l,
              enabled: true,
              trait_spec: { ...l.trait_spec, palette_ref: paletteId },
            };
          }
          return l;
        }),
      );
      return;
    }

    const nextTrigger =
      liveLayers.reduce((m, l) => Math.max(m, l.trigger_order), 0) + 1;
    const seq = layerSeq;
    setLayerSeq(seq + 1);
    const created: SmartControlLayer =
      kind === "color"
        ? {
            id: `layer_${seq}`,
            name: `Linked Color ${seq}`,
            enabled: true,
            priority: 1,
            trigger_order: nextTrigger,
            alpha: 1,
            target: activeGroupFilterId || "all",
            order_override: null,
            trait_spec: {
              trait_kind: "color",
              op: "ltp",
              palette_ref: paletteId,
              hex_start: "#FF5500",
              hex_end: "#2255AA",
            },
          }
        : {
            id: `layer_${seq}`,
            name: `Linked Dimmer ${seq}`,
            enabled: true,
            priority: 1,
            trigger_order: nextTrigger,
            alpha: 1,
            target: activeGroupFilterId || "all",
            order_override: null,
            trait_spec: {
              trait_kind: "dimmer",
              op: "htp",
              palette_ref: paletteId,
              value_start: 1,
              value_end: 1,
            },
          };
    void setLiveLayers([...liveLayers, created]);
  };

  const softwareStrobeWarning = useMemo(
    () => hasSoftwareStrobeOverCap(liveLayers, showState, fixtureDetailsCache),
    [fixtureDetailsCache, liveLayers, showState],
  );

  const targetOptions = useMemo(() => {
    const opts = [{ value: "all", label: "All Patched Fixtures" }];
    for (const grp of showState.groups) {
      opts.push({ value: grp.id, label: `Group: ${grp.name} (${grp.id})` });
    }
    for (const fx of showState.patch) {
      opts.push({ value: fx.id, label: `Fixture: ${fx.name} (${fx.id})` });
    }
    return opts;
  }, [showState.groups, showState.patch]);

  const handleSaveColorPalette = async () => {
    const id = slugId(
      "pal",
      colorName,
      showState.color_palettes.map((p) => p.id),
    );
    await upsertColorPalette({
      id,
      name: colorName.trim() || "Color Palette",
      hex_start: colorStartHex,
      hex_end: colorEndHex,
    });
  };

  const handleSaveDimmerPalette = async () => {
    const id = slugId(
      "dim",
      dimmerName,
      showState.dimmer_palettes.map((d) => d.id),
    );
    await upsertDimmerPalette({
      id,
      name: dimmerName.trim() || "Dimmer Palette",
      value_start: clamp01(dimmerStart),
      value_end: clamp01(dimmerEnd),
    });
  };

  const handleSaveGroup = async () => {
    const id = slugId(
      "grp",
      groupName,
      showState.groups.map((g) => g.id),
    );
    const targets = groupTargets
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    await upsertGroup({
      id,
      name: groupName.trim() || "Group",
      order: groupOrder,
      targets,
    });
  };

  const addLayer = (kind: "dimmer" | "color" | "master_dimmer" | "shutter") => {
    const nextTrigger =
      liveLayers.reduce((m, l) => Math.max(m, l.trigger_order), 0) + 1;
    const seq = layerSeq;
    setLayerSeq(seq + 1);
    const defaultColorPal = showState.color_palettes[0]?.id ?? null;
    const defaultDimPal = showState.dimmer_palettes[0]?.id ?? null;

    let newLayer: SmartControlLayer;
    if (kind === "dimmer") {
      newLayer = {
        id: `layer_${seq}`,
        name: `Dimmer ${seq}`,
        enabled: true,
        priority: 1,
        trigger_order: nextTrigger,
        alpha: 1.0,
        target: "all",
        order_override: null,
        trait_spec: {
          trait_kind: "dimmer",
          op: "htp",
          palette_ref: defaultDimPal,
          value_start: 1.0,
          value_end: 1.0,
        },
      };
    } else if (kind === "color") {
      newLayer = {
        id: `layer_${seq}`,
        name: `Color ${seq}`,
        enabled: true,
        priority: 1,
        trigger_order: nextTrigger,
        alpha: 1.0,
        target: "all",
        order_override: null,
        trait_spec: {
          trait_kind: "color",
          op: "ltp",
          palette_ref: defaultColorPal,
          hex_start: "#FF5500",
          hex_end: "#2255AA",
        },
      };
    } else if (kind === "master_dimmer") {
      newLayer = {
        id: `layer_${seq}`,
        name: `Master ${seq}`,
        enabled: true,
        priority: 2,
        trigger_order: nextTrigger,
        alpha: 1.0,
        target: "all",
        order_override: null,
        trait_spec: {
          trait_kind: "master_dimmer",
          op: "ltp",
          value: 1.0,
        },
      };
    } else {
      newLayer = {
        id: `layer_${seq}`,
        name: `Shutter ${seq}`,
        enabled: true,
        priority: 3,
        trigger_order: nextTrigger,
        alpha: 1.0,
        target: "all",
        order_override: null,
        trait_spec: {
          trait_kind: "shutter",
          state: { kind: "open" },
        },
      };
    }

    void setLiveLayers([...liveLayers, newLayer]);
  };

  const updateLayer = (
    layerId: string,
    updater: (layer: SmartControlLayer) => SmartControlLayer,
  ) => {
    void setLiveLayers(
      liveLayers.map((l) => (l.id === layerId ? updater(l) : l)),
    );
  };

  const removeLayer = (layerId: string) => {
    void setLiveLayers(liveLayers.filter((l) => l.id !== layerId));
  };

  const handleHsPick = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = hsSquareRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const hueFrac = clamp01((e.clientX - rect.left) / rect.width);
    const satFrac = clamp01(1 - (e.clientY - rect.top) / rect.height);
    const [nr, ng, nb] = hsvToRgb(hueFrac * 360, satFrac, 1.0);
    setSceneStaticColorHex(rgbToHex(nr, ng, nb));
  };

  const activeFixtureLabel =
    activeGroupFilterId === "all"
      ? "GENERIC"
      : (showState.groups.find((g) => g.id === activeGroupFilterId)?.name ??
          "GROUP"
        ).toUpperCase();

  // Standalone (non-docked) mode keeps full cards for Slice 4 standalone usage
  if (!daslightDock) {
    return (
      <div className="flex flex-col gap-3">
        {!hideUndoRedo && (
          <section className="bg-slate border border-steel rounded-panel p-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <h2 className="font-sans text-sm font-semibold text-frost">
                Trait Space Mixer &amp; Referenceable Palettes
              </h2>
              {softwareStrobeWarning && (
                <span className="px-2.5 py-1 rounded bg-signal/15 border border-signal text-signal font-mono text-xs font-semibold flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>SOFTWARE STROBE CAPPED AT 11 HZ</span>
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={!canUndo}
                onClick={() => void undoShow()}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-ink border border-steel text-xs font-sans text-mist hover:border-ember disabled:opacity-40"
              >
                <Undo2 className="w-3.5 h-3.5" />
                <span>Undo</span>
              </button>
              <button
                type="button"
                disabled={!canRedo}
                onClick={() => void redoShow()}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-ink border border-steel text-xs font-sans text-mist hover:border-ember disabled:opacity-40"
              >
                <Redo2 className="w-3.5 h-3.5" />
                <span>Redo</span>
              </button>
            </div>
          </section>
        )}

        <section
          className={`grid grid-cols-1 ${hideGroups ? "lg:grid-cols-2" : "lg:grid-cols-3"} gap-3`}
        >
          {/* Color Palettes */}
          <div className="bg-slate border border-steel rounded-panel p-2.5 flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Palette className="w-4 h-4 text-ember" />
                <h3 className="font-sans text-sm font-semibold text-frost">
                  Color Palettes (OKLAB)
                </h3>
              </div>
              <button
                type="button"
                onClick={() => void handleSaveColorPalette()}
                className="flex items-center gap-1 px-2 py-1 rounded bg-ember hover:bg-burnt text-frost text-[11px] font-semibold shrink-0"
              >
                <Plus className="w-3 h-3" />
                <span>Save Color Palette</span>
              </button>
            </div>

            <div className="bg-pitch border border-steel rounded p-2 grid grid-cols-2 gap-2">
              <div className="col-span-2 flex flex-col gap-1">
                <label
                  htmlFor="cp-name"
                  className="text-[11px] font-mono uppercase text-fog"
                >
                  Color Palette Name
                </label>
                <input
                  id="cp-name"
                  aria-label="Color Palette Name"
                  type="text"
                  value={colorName}
                  onChange={(e) => setColorName(e.target.value)}
                  className="bg-ink border border-steel rounded px-2 py-1 text-xs text-frost"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="cp-start"
                  className="text-[11px] font-mono uppercase text-fog"
                >
                  Color Start Hex
                </label>
                <input
                  id="cp-start"
                  aria-label="Color Start Hex"
                  type="text"
                  value={colorStartHex}
                  onChange={(e) => setColorStartHex(e.target.value)}
                  className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="cp-end"
                  className="text-[11px] font-mono uppercase text-fog"
                >
                  Color End Hex
                </label>
                <input
                  id="cp-end"
                  aria-label="Color End Hex"
                  type="text"
                  value={colorEndHex}
                  onChange={(e) => setColorEndHex(e.target.value)}
                  className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              {showState.color_palettes.map((pal) => (
                <div
                  key={pal.id}
                  className="bg-ink border border-steel rounded px-2.5 py-1.5 flex items-center justify-between gap-2 text-xs"
                >
                  <span className="font-sans font-medium text-frost truncate">
                    {pal.name}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      data-testid={`link-palette-${pal.id}`}
                      onClick={() => linkPaletteToLiveLayer("color", pal.id)}
                      className="px-1.5 py-0.5 rounded bg-pitch border border-steel font-mono text-[10px] text-mist"
                    >
                      Link
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete palette ${pal.name}`}
                      onClick={() => void deleteColorPalette(pal.id)}
                      className="p-1 text-signal rounded"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Dimmer Palettes */}
          <div className="bg-slate border border-steel rounded-panel p-2.5 flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <SunMedium className="w-4 h-4 text-cobalt" />
                <h3 className="font-sans text-sm font-semibold text-frost">
                  Dimmer Palettes
                </h3>
              </div>
              <button
                type="button"
                onClick={() => void handleSaveDimmerPalette()}
                className="flex items-center gap-1 px-2 py-1 rounded bg-cobalt text-void text-[11px] font-semibold shrink-0"
              >
                <Plus className="w-3 h-3" />
                <span>Save Dimmer Palette</span>
              </button>
            </div>
            <div className="bg-pitch border border-steel rounded p-2 grid grid-cols-2 gap-2">
              <div className="col-span-2 flex flex-col gap-1">
                <label
                  htmlFor="dp-name"
                  className="text-[11px] font-mono uppercase text-fog"
                >
                  Dimmer Palette Name
                </label>
                <input
                  id="dp-name"
                  aria-label="Dimmer Palette Name"
                  type="text"
                  value={dimmerName}
                  onChange={(e) => setDimmerName(e.target.value)}
                  className="bg-ink border border-steel rounded px-2 py-1 text-xs text-frost"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="dp-start"
                  className="text-[11px] font-mono uppercase text-fog"
                >
                  Dimmer Start Value
                </label>
                <input
                  id="dp-start"
                  aria-label="Dimmer Start Value"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={dimmerStart}
                  onChange={(e) => setDimmerStart(Number(e.target.value) || 0)}
                  className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="dp-end"
                  className="text-[11px] font-mono uppercase text-fog"
                >
                  Dimmer End Value
                </label>
                <input
                  id="dp-end"
                  aria-label="Dimmer End Value"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={dimmerEnd}
                  onChange={(e) => setDimmerEnd(Number(e.target.value) || 0)}
                  className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                />
              </div>
            </div>
          </div>

          {/* Target Groups */}
          {!hideGroups && (
            <div className="bg-slate border border-steel rounded-panel p-3 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-plum" />
                <h3 className="font-sans text-sm font-semibold text-frost">
                  Target Groups
                </h3>
              </div>
              <input
                aria-label="Group Name"
                type="text"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                className="bg-ink border border-steel rounded px-2 py-1 text-xs text-frost"
              />
              <select
                aria-label="Group Order"
                value={groupOrder}
                onChange={(e) => setGroupOrder(e.target.value as OrderRuleStr)}
                className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
              >
                <option value="linear">Linear</option>
                <option value="center_out">Center Out</option>
              </select>
              <input
                aria-label="Group Targets"
                type="text"
                value={groupTargets}
                onChange={(e) => setGroupTargets(e.target.value)}
                className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
              />
              <button
                type="button"
                onClick={() => void handleSaveGroup()}
                className="px-3 py-1.5 rounded bg-ink border border-plum text-frost text-xs font-semibold"
              >
                Save Group
              </button>
            </div>
          )}
        </section>

        <section className="bg-slate border border-steel rounded-panel p-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => addLayer("dimmer")}
              className="px-2 py-1 rounded bg-ink border border-steel text-xs font-mono"
            >
              Add Dimmer Layer
            </button>
            <button
              type="button"
              onClick={() => addLayer("color")}
              className="px-2 py-1 rounded bg-ink border border-steel text-xs font-mono"
            >
              Add Color Layer
            </button>
          </div>
        </section>

        <div
          data-testid="scene-live-cell-preview"
          className="bg-slate border border-steel rounded-panel p-2.5 flex flex-wrap gap-1.5"
        >
          {compiledCells.map((cell, idx) => {
            const base = idx * 4;
            const r = cellPreviewRgbd[base] ?? 0;
            const g = cellPreviewRgbd[base + 1] ?? 0;
            const b = cellPreviewRgbd[base + 2] ?? 0;
            const d = cellPreviewRgbd[base + 3] ?? 0;
            const scale = d / 255;
            return (
              <div
                key={`${cell.fixture_id}-${cell.cell_index}`}
                className="w-8 h-8 rounded border border-steel"
                style={{
                  backgroundColor: `rgb(${Math.round(r * scale)}, ${Math.round(g * scale)}, ${Math.round(b * scale)})`,
                }}
              />
            );
          })}
        </div>
      </div>
    );
  }

  // DASLIGHT 5 INTEGRATED BOTTOM-RIGHT DOCK
  return (
    <div className="h-full min-h-0 bg-slate-dark border border-steel rounded flex flex-col overflow-hidden">
      {/* Slim Dock Header: Active Scene Scope & Strobe Warning */}
      <div className="shrink-0 bg-slate border-b border-steel px-2.5 py-1 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-mono text-[10px]">
          <span className="text-fog uppercase">SCENE CONTROLS:</span>
          <span className="text-amber-400 font-semibold truncate max-w-[180px]">
            {selectedScene ? selectedScene.name : "No Scene Selected"}
          </span>
          {softwareStrobeWarning && (
            <span className="px-1.5 py-0.5 rounded bg-signal/20 border border-signal text-signal font-mono text-[9px] font-semibold flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              <span>SOFTWARE STROBE CAPPED AT 11 HZ</span>
            </span>
          )}
        </div>
      </div>

      {/* BODY: EDIT Trait Dock */}
      <div className="flex-1 min-h-0 flex items-stretch overflow-hidden">
          {/* Left Vertical Trait Category Rail (Moving Lights omitted) */}
          <nav
            aria-label="Trait Categories"
            className="w-20 shrink-0 bg-slate border-r border-steel flex flex-col py-1 font-mono text-[10px]"
          >
            {(
              [
                { id: "dimmer", label: "DIMMER" },
                { id: "color", label: "COLOR" },
                { id: "beam", label: "BEAM" },
                { id: "fader", label: "FADER" },
              ] as const
            ).map((cat) => (
              <button
                key={cat.id}
                type="button"
                data-testid={`trait-tab-${cat.id}`}
                aria-pressed={traitCategory === cat.id}
                onClick={() => setTraitCategory(cat.id)}
                className={`px-2.5 py-2 text-left transition-colors ${
                  traitCategory === cat.id
                    ? "bg-pitch text-frost font-semibold border-l-2 border-ember"
                    : "text-fog hover:text-mist"
                }`}
              >
                {cat.label}
              </button>
            ))}
          </nav>

          {/* Right Trait Channel Strips & Controls */}
          <div className="flex-1 min-w-0 min-h-0 overflow-auto bg-pitch p-2 flex items-stretch gap-2">
            {/* CATEGORY 1: DIMMER (Master Dimmer if in profile + Segment Dimmer, each with Scene Control toggle) */}
            {traitCategory === "dimmer" && (
              <>
                {hasFixtureMasterDimmer && (
                  <div
                    data-testid="scene-master-dimmer-strip"
                    className={`flex flex-col border rounded bg-slate-dark overflow-hidden shrink-0 ${
                      sceneControlsMasterDimmer ? "border-pine" : "border-steel"
                    }`}
                  >
                    <div className="bg-slate border-b border-steel px-2 py-0.5 text-center font-mono text-[9px] text-fog">
                      {activeFixtureLabel}
                    </div>
                    <div className="flex-1 flex flex-col items-center justify-between p-2 gap-1.5 w-24">
                      <button
                        type="button"
                        data-testid="toggle-scene-controls-master-dimmer"
                        aria-pressed={sceneControlsMasterDimmer}
                        onClick={() =>
                          sceneControlsMasterDimmer
                            ? void upsertSceneTraitElement("master_dimmer", null)
                            : setSceneMasterDimmerValue(
                                currentMasterDimmerVal > 0
                                  ? currentMasterDimmerVal
                                  : 1,
                              )
                        }
                        title="Toggle whether this scene controls Master Dimmer"
                        className="flex items-center gap-1 font-mono text-[10px] text-frost hover:text-amber-300"
                      >
                        <span
                          className={`w-2.5 h-2.5 rounded-full border ${
                            sceneControlsMasterDimmer
                              ? "bg-pine border-pine"
                              : "border-fog"
                          }`}
                        />
                        <span>MASTER</span>
                      </button>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            setSceneMasterDimmerValue(
                              currentMasterDimmerVal > 0 ? 0 : 1,
                            )
                          }
                          title="Toggle Master Full / Off"
                          className={`w-7 h-7 rounded flex items-center justify-center border transition-colors ${
                            sceneControlsMasterDimmer &&
                            currentMasterDimmerVal > 0
                              ? "bg-amber-500 border-amber-400 text-void"
                              : "bg-amber-500/20 border-amber-500/50 text-amber-400"
                          }`}
                        >
                          <Sun className="w-4 h-4" />
                        </button>
                        <span className="font-mono text-[10px] text-fog w-7 text-right">
                          {sceneControlsMasterDimmer
                            ? `${Math.round(currentMasterDimmerVal * 100)}%`
                            : "—"}
                        </span>
                      </div>

                      <NumericSlider
                        orientation="vertical"
                        ariaLabel="Master Dimmer Fader"
                        value={currentMasterDimmerVal}
                        defaultValue={0}
                        min={0}
                        max={1}
                        step={0.01}
                        displayMultiplier={100}
                        unit="%"
                        precision={0}
                        active={sceneControlsMasterDimmer}
                        resetTitle="Reset Master Dimmer (remove from scene)"
                        onReset={() => void upsertSceneTraitElement("master_dimmer", null)}
                        onChange={(val) => setSceneMasterDimmerValue(val)}
                        className="flex-1 min-h-0"
                        inputClassName="w-11 text-[10px]"
                      />

                      <div className="flex items-center justify-center gap-2 pt-1 text-fog">
                        <button
                          type="button"
                          onClick={() => setSceneMasterDimmerValue(0)}
                          title="Master 0%"
                          className="p-0.5 hover:text-signal"
                        >
                          <Power className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setSceneMasterDimmerValue(1)}
                          title="Master 100%"
                          className="p-0.5 hover:text-pine"
                        >
                          <Play className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <div
                  data-testid="scene-segment-dimmer-strip"
                  className={`flex flex-col border rounded bg-slate-dark overflow-hidden shrink-0 ${
                    sceneControlsDimmer ? "border-pine" : "border-steel"
                  }`}
                >
                  <div className="bg-slate border-b border-steel px-2 py-0.5 text-center font-mono text-[9px] text-fog">
                    {activeFixtureLabel}
                  </div>
                  <div className="flex-1 flex flex-col items-center justify-between p-2 gap-1.5 w-24">
                    <button
                      type="button"
                      data-testid="toggle-scene-controls-dimmer"
                      aria-pressed={sceneControlsDimmer}
                      onClick={() => {
                        if (!selectedScene) return;
                        if (sceneControlsDimmer && sceneDimmerEl) {
                          savedSceneTraitsRef.current[selectedScene.id] = {
                            ...savedSceneTraitsRef.current[selectedScene.id],
                            dimmer: sceneDimmerEl,
                          };
                          void upsertSceneTraitElement("dimmer", null);
                        } else {
                          const saved =
                            savedSceneTraitsRef.current[selectedScene.id]
                              ?.dimmer;
                          if (saved) {
                            void upsertSceneTraitElement("dimmer", saved);
                          } else {
                            setSceneDimmerValue(
                              currentDimmerVal > 0 ? currentDimmerVal : 1,
                            );
                          }
                        }
                      }}
                      title="Toggle whether this scene controls Segment Dimmer"
                      className="flex items-center gap-1 font-mono text-[10px] text-frost hover:text-amber-300"
                    >
                      <span
                        className={`w-2.5 h-2.5 rounded-full border ${
                          sceneControlsDimmer
                            ? "bg-pine border-pine"
                            : "border-fog"
                        }`}
                      />
                      <span>{hasFixtureMasterDimmer ? "SEGMENT" : "DIMMER"}</span>
                    </button>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          setSceneDimmerValue(currentDimmerVal > 0 ? 0 : 1)
                        }
                        title="Toggle Full / Off"
                        className={`w-7 h-7 rounded flex items-center justify-center border transition-colors ${
                          sceneControlsDimmer && currentDimmerVal > 0
                            ? "bg-amber-500 border-amber-400 text-void"
                            : "bg-amber-500/20 border-amber-500/50 text-amber-400"
                        }`}
                      >
                        <Sun className="w-4 h-4" />
                      </button>
                      <span className="font-mono text-[10px] text-fog w-7 text-right">
                        {sceneControlsDimmer
                          ? `${Math.round(currentDimmerVal * 100)}%`
                          : "—"}
                      </span>
                    </div>

                    <NumericSlider
                      orientation="vertical"
                      ariaLabel="Channel Dimmer Fader"
                      value={currentDimmerVal}
                      defaultValue={0}
                      min={0}
                      max={1}
                      step={0.01}
                      displayMultiplier={100}
                      unit="%"
                      precision={0}
                      active={sceneControlsDimmer}
                      resetTitle="Reset Dimmer (remove from scene)"
                      onReset={() => void upsertSceneTraitElement("dimmer", null)}
                      onChange={(val) => setSceneDimmerValue(val)}
                      className="flex-1 min-h-0"
                      inputClassName="w-11 text-[10px]"
                    />

                    <div className="flex items-center justify-center gap-2 pt-1 text-fog">
                      <button
                        type="button"
                        onClick={() => setSceneDimmerValue(0)}
                        title="Off (0%)"
                        className="p-0.5 hover:text-signal"
                      >
                        <Power className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setSceneDimmerValue(1)}
                        title="Full (100%)"
                        className="p-0.5 hover:text-pine"
                      >
                        <Play className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* CATEGORY 2: COLOR (2D Hue-Sat Square without dimmer + RGB Strips + Saved Palettes, bound to selected Scene) */}
            {traitCategory === "color" && (
              <div
                className={`flex-1 min-w-0 flex items-stretch border rounded bg-slate-dark overflow-hidden ${
                  sceneControlsColor ? "border-pine" : "border-steel"
                }`}
              >
                {/* 2D Hue-Sat Square & Favorites */}
                <div className="flex-1 min-w-[200px] p-2 flex flex-col justify-between gap-1.5 border-r border-steel">
                  <div className="flex items-center justify-between gap-2 font-mono text-[10px]">
                    <button
                      type="button"
                      data-testid="toggle-scene-controls-color"
                      aria-pressed={sceneControlsColor}
                      onClick={() => {
                        void toggleSceneColorTrait(currentColorHex);
                      }}
                      title="Toggle whether this scene controls Color"
                      className="flex items-center gap-1.5 font-semibold text-frost hover:text-amber-300"
                    >
                      <span
                        className={`w-2.5 h-2.5 rounded-full border ${
                          sceneControlsColor
                            ? "bg-pine border-pine"
                            : "border-fog"
                        }`}
                      />
                      <span>COLOR</span>
                    </button>
                    <label className="flex items-center gap-1 text-fog cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoWhite}
                        onChange={(e) => setAutoWhite(e.target.checked)}
                        className="accent-ember"
                      />
                      <span>Auto white</span>
                    </label>
                  </div>

                  <div className="flex items-center gap-3 font-mono text-[10px] text-fog">
                    <span>
                      Hue: {((curHsv.h / 360) * 100).toFixed(1)} %
                    </span>
                    <span>Sat: {(curHsv.s * 100).toFixed(1)} %</span>
                    <span className="ml-auto text-mist">{currentColorHex}</span>
                  </div>

                  {/* 2D Hue-Saturation Square (no brightness/dimmer slider) */}
                  <div className="flex-1 min-h-[110px] flex items-stretch">
                    <div
                      ref={hsSquareRef}
                      data-testid="color-hs-square"
                      onPointerDown={(e) => {
                        setPickingHs(true);
                        handleHsPick(e);
                      }}
                      onPointerMove={(e) => {
                        if (pickingHs) handleHsPick(e);
                      }}
                      onPointerUp={() => setPickingHs(false)}
                      onPointerLeave={() => setPickingHs(false)}
                      className="flex-1 relative rounded border border-steel cursor-crosshair overflow-hidden"
                      style={{
                        background:
                          "linear-gradient(to top, #FFFFFF, rgba(255,255,255,0)), linear-gradient(to right, #FF0000, #FFFF00, #00FF00, #00FFFF, #0000FF, #FF00FF, #FF0000)",
                      }}
                    >
                      <div
                        className="w-2.5 h-2.5 rounded-full border-2 border-void ring-1 ring-frost pointer-events-none -translate-x-1/2 translate-y-1/2 absolute"
                        style={{
                          left: `${(curHsv.h / 360) * 100}%`,
                          bottom: `${curHsv.s * 100}%`,
                          backgroundColor: currentColorHex,
                        }}
                      />
                    </div>
                  </div>

                  {/* FAVORITES Swatches + Link Saved Palettes */}
                  <div className="flex items-center gap-1.5 pt-1">
                    <span className="font-mono text-[9px] text-fog uppercase">
                      FAVORITES
                    </span>
                    <div className="flex items-center gap-1 flex-wrap">
                      {[
                        "#FF0000",
                        "#FFFF00",
                        "#00FF00",
                        "#00FFFF",
                        "#0000FF",
                        "#FF00FF",
                      ].map((hex) => (
                        <button
                          key={hex}
                          type="button"
                          onClick={() => setSceneStaticColorHex(hex)}
                          title={hex}
                          className="w-3.5 h-3.5 rounded-sm border border-steel"
                          style={{ backgroundColor: hex }}
                        />
                      ))}
                      {showState.color_palettes.map((pal) => {
                        const stops =
                          pal.colors && pal.colors.length >= 2
                            ? pal.colors.join(", ")
                            : `${pal.hex_start}, ${pal.hex_end}`;
                        return (
                          <button
                            key={pal.id}
                            type="button"
                            data-testid={`link-palette-${pal.id}`}
                            onClick={() => setSceneColorPalette(pal.id)}
                            title={`Use palette ${pal.name}`}
                            className="h-3.5 px-1 rounded-sm border border-steel font-mono text-[8px] text-frost"
                            style={{
                              background: `linear-gradient(90deg, ${stops})`,
                            }}
                          >
                            {pal.name.slice(0, 4)}
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        data-testid="open-palette-builder-dock-btn"
                        onClick={() => setPaletteBuilderOpen(true)}
                        title="Open Color Palette Builder"
                        className="h-3.5 px-1.5 rounded-sm border border-steel bg-ink hover:border-ember font-mono text-[8px] text-mist hover:text-frost"
                      >
                        + Palette
                      </button>
                    </div>
                  </div>
                </div>

                {/* Vertical RED / GREEN / BLUE Channel Fader Strips */}
                {(
                  [
                    { label: "RED", val: curR, color: "#EF4444", idx: 0 },
                    { label: "GREEN", val: curG, color: "#22C55E", idx: 1 },
                    { label: "BLUE", val: curB, color: "#3B82F6", idx: 2 },
                  ] as const
                ).map((ch) => (
                  <div
                    key={ch.label}
                    className="w-16 shrink-0 border-r last:border-r-0 border-steel flex flex-col items-center justify-between p-1.5 gap-1"
                  >
                    <span className="font-mono text-[9px] text-frost">
                      {ch.label}
                    </span>
                    <div className="flex items-center gap-1">
                      <span
                        className="w-4 h-4 rounded-full border border-steel/60"
                        style={{ backgroundColor: ch.color }}
                      />
                      <span className="font-mono text-[9px] text-fog">
                        {ch.val > 0 ? `${Math.round((ch.val / 255) * 100)}%` : "OFF"}
                      </span>
                    </div>
                    <NumericSlider
                      orientation="vertical"
                      ariaLabel={`${ch.label} Channel Fader`}
                      value={ch.val}
                      defaultValue={0}
                      min={0}
                      max={255}
                      step={1}
                      precision={0}
                      onChange={(v) => {
                        const next: [number, number, number] = [
                          curR,
                          curG,
                          curB,
                        ];
                        next[ch.idx] = Math.round(v);
                        setSceneStaticColorHex(
                          rgbToHex(next[0], next[1], next[2]),
                        );
                      }}
                      className="flex-1 min-h-0"
                      inputClassName="w-10 text-[9px]"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const next: [number, number, number] = [
                          curR,
                          curG,
                          curB,
                        ];
                        next[ch.idx] = 0;
                        setSceneStaticColorHex(
                          rgbToHex(next[0], next[1], next[2]),
                        );
                      }}
                      className="text-fog hover:text-signal"
                    >
                      <Power className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* CATEGORY 3: BEAM (Shutter / Strobe) */}
            {traitCategory === "beam" && (
              <div className="flex items-stretch gap-2">
                <div className="w-28 bg-slate-dark border border-steel rounded p-2 flex flex-col items-center justify-between gap-1.5 font-mono text-[10px]">
                  <span className="text-frost">SHUTTER</span>
                  <button
                    type="button"
                    onClick={() => {
                      const isStrobe =
                        activeShutterLayer?.trait_spec.trait_kind ===
                          "shutter" &&
                        activeShutterLayer.trait_spec.state.kind ===
                          "strobe_hz";
                      setLiveShutterState(
                        isStrobe ? { kind: "open" } : { kind: "strobe_hz", hz: 8 },
                      );
                    }}
                    className={`w-8 h-8 rounded border flex items-center justify-center ${
                      activeShutterLayer?.trait_spec.trait_kind === "shutter" &&
                      activeShutterLayer.trait_spec.state.kind === "strobe_hz"
                        ? "bg-signal border-signal text-frost"
                        : "bg-ink border-steel text-amber-400"
                    }`}
                  >
                    <Zap className="w-4 h-4" />
                  </button>
                  <NumericSlider
                    orientation="vertical"
                    ariaLabel="Beam Strobe Hz"
                    value={
                      activeShutterLayer?.trait_spec.trait_kind === "shutter" &&
                      (activeShutterLayer.trait_spec.state.kind ===
                        "strobe_hz" ||
                        activeShutterLayer.trait_spec.state.kind ===
                          "random_strobe")
                        ? activeShutterLayer.trait_spec.state.hz
                        : 8
                    }
                    defaultValue={8}
                    min={1}
                    max={25}
                    step={0.5}
                    unit="Hz"
                    precision={1}
                    onChange={(hz) =>
                      setLiveShutterState({
                        kind: "strobe_hz",
                        hz,
                      })
                    }
                    className="flex-1 min-h-0"
                    sliderClassName="accent-signal cursor-pointer"
                    inputClassName="w-11 text-[9px]"
                  />
                  <span className="text-fog">
                    {activeShutterLayer?.trait_spec.trait_kind === "shutter" &&
                    activeShutterLayer.trait_spec.state.kind === "strobe_hz"
                      ? `${activeShutterLayer.trait_spec.state.hz} Hz`
                      : "OPEN"}
                  </span>
                </div>
              </div>
            )}

            {/* CATEGORY 4: FADER (Manual Layer Stack & Palette Manager) */}
            {traitCategory === "fader" && (
              <div className="flex-1 min-w-0 flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => addLayer("dimmer")}
                    className="px-2 py-1 rounded bg-ink border border-steel hover:border-cobalt text-[10px] font-mono text-frost"
                  >
                    Add Dimmer Layer
                  </button>
                  <button
                    type="button"
                    onClick={() => addLayer("color")}
                    className="px-2 py-1 rounded bg-ink border border-steel hover:border-ember text-[10px] font-mono text-frost"
                  >
                    Add Color Layer
                  </button>
                  <button
                    type="button"
                    onClick={() => addLayer("master_dimmer")}
                    className="px-2 py-1 rounded bg-ink border border-steel hover:border-pine text-[10px] font-mono text-frost"
                  >
                    Add Master Layer
                  </button>
                  <button
                    type="button"
                    onClick={() => addLayer("shutter")}
                    className="px-2 py-1 rounded bg-ink border border-steel hover:border-signal text-[10px] font-mono text-frost"
                  >
                    Add Shutter Layer
                  </button>
                </div>

                {liveLayers.length === 0 ? (
                  <div className="font-mono text-[11px] text-fog py-3 text-center border border-steel/60 rounded bg-slate-dark">
                    No manual override layers active.
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {liveLayers.map((layer, idx) => {
                      const num = idx + 1;
                      const spec = layer.trait_spec;
                      return (
                        <div
                          key={layer.id}
                          className="bg-slate-dark border border-steel rounded p-1.5 flex flex-wrap items-center gap-1.5 text-[10px] font-mono"
                        >
                          <input
                            type="checkbox"
                            aria-label={`Layer ${num} Enabled`}
                            checked={layer.enabled}
                            onChange={(e) =>
                              updateLayer(layer.id, (l) => ({
                                ...l,
                                enabled: e.target.checked,
                              }))
                            }
                          />
                          <span className="text-ember font-semibold">
                            L{num}: {spec.trait_kind}
                          </span>
                          <select
                            aria-label={`Layer ${num} Target`}
                            value={layer.target}
                            onChange={(e) =>
                              updateLayer(layer.id, (l) => ({
                                ...l,
                                target: e.target.value,
                              }))
                            }
                            className="bg-ink border border-steel rounded px-1 py-0.5 text-frost"
                          >
                            {targetOptions.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                          <select
                            aria-label={`Layer ${num} Order`}
                            value={layer.order_override ?? ""}
                            onChange={(e) =>
                              updateLayer(layer.id, (l) => ({
                                ...l,
                                order_override: e.target.value
                                  ? (e.target.value as OrderRuleStr)
                                  : null,
                              }))
                            }
                            className="bg-ink border border-steel rounded px-1 py-0.5 text-frost"
                          >
                            <option value="">Group Default</option>
                            <option value="linear">Linear</option>
                            <option value="reverse">Reverse</option>
                            <option value="center_out">Center Out</option>
                            <option value="mirror">Mirror</option>
                            <option value="odd_even">Odd Even</option>
                            <option value="blocks(2)">Blocks (2)</option>
                          </select>
                          {spec.trait_kind === "dimmer" && (
                            <select
                              aria-label={`Layer ${num} Palette`}
                              value={spec.palette_ref ?? ""}
                              onChange={(e) =>
                                updateLayer(layer.id, (l) => ({
                                  ...l,
                                  trait_spec: {
                                    ...spec,
                                    palette_ref: e.target.value || null,
                                  },
                                }))
                              }
                              className="bg-ink border border-steel rounded px-1 py-0.5 text-frost"
                            >
                              <option value="">Inline Range</option>
                              {showState.dimmer_palettes.map((d) => (
                                <option key={d.id} value={d.id}>
                                  {d.name}
                                </option>
                              ))}
                            </select>
                          )}
                          {spec.trait_kind === "color" && (
                            <select
                              aria-label={`Layer ${num} Palette`}
                              value={spec.palette_ref ?? ""}
                              onChange={(e) =>
                                updateLayer(layer.id, (l) => ({
                                  ...l,
                                  trait_spec: {
                                    ...spec,
                                    palette_ref: e.target.value || null,
                                  },
                                }))
                              }
                              className="bg-ink border border-steel rounded px-1 py-0.5 text-frost"
                            >
                              <option value="">Inline</option>
                              {showState.color_palettes.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                            </select>
                          )}
                          {spec.trait_kind === "shutter" && (
                            <>
                              <select
                                aria-label={`Layer ${num} Shutter Mode`}
                                value={spec.state.kind}
                                onChange={(e) => {
                                  const kind = e.target
                                    .value as ShutterState["kind"];
                                  let nextState: ShutterState = {
                                    kind: "open",
                                  };
                                  if (kind === "closed") {
                                    nextState = { kind: "closed" };
                                  } else if (kind === "strobe_hz") {
                                    nextState = { kind: "strobe_hz", hz: 6 };
                                  } else if (kind === "random_strobe") {
                                    nextState = {
                                      kind: "random_strobe",
                                      hz: 6,
                                    };
                                  }
                                  updateLayer(layer.id, (l) => ({
                                    ...l,
                                    trait_spec: {
                                      trait_kind: "shutter",
                                      state: nextState,
                                    },
                                  }));
                                }}
                                className="bg-ink border border-steel rounded px-1 py-0.5 text-frost"
                              >
                                <option value="open">Open</option>
                                <option value="closed">Closed</option>
                                <option value="strobe_hz">Strobe Hz</option>
                                <option value="random_strobe">
                                  Random Strobe
                                </option>
                              </select>
                              {(spec.state.kind === "strobe_hz" ||
                                spec.state.kind === "random_strobe") && (
                                <input
                                  aria-label={`Layer ${num} Strobe Hz`}
                                  type="number"
                                  min={0.5}
                                  max={25}
                                  step={0.5}
                                  value={spec.state.hz}
                                  onChange={(e) => {
                                    const hz = Math.max(
                                      0.5,
                                      Math.min(25, Number(e.target.value) || 1),
                                    );
                                    const kind = spec.state.kind;
                                    updateLayer(layer.id, (l) => ({
                                      ...l,
                                      trait_spec: {
                                        trait_kind: "shutter",
                                        state:
                                          kind === "random_strobe"
                                            ? { kind: "random_strobe", hz }
                                            : { kind: "strobe_hz", hz },
                                      },
                                    }));
                                  }}
                                  className="w-14 bg-ink border border-steel rounded px-1 py-0.5 text-frost"
                                />
                              )}
                            </>
                          )}
                          <button
                            type="button"
                            aria-label={`Remove Layer ${num}`}
                            onClick={() => removeLayer(layer.id)}
                            className="ml-auto p-1 text-signal hover:bg-ink rounded"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Quick Color & Dimmer Palette Creators */}
                <div className="bg-slate-dark border border-steel rounded p-2 flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
                  <span className="text-fog">Color Palette:</span>
                  <input
                    aria-label="Color Palette Name"
                    type="text"
                    value={colorName}
                    onChange={(e) => setColorName(e.target.value)}
                    className="w-24 bg-ink border border-steel rounded px-1.5 py-0.5 text-frost"
                  />
                  <input
                    aria-label="Color Start Hex"
                    type="text"
                    value={colorStartHex}
                    onChange={(e) => setColorStartHex(e.target.value)}
                    className="w-20 bg-ink border border-steel rounded px-1.5 py-0.5 text-frost"
                  />
                  <input
                    aria-label="Color End Hex"
                    type="text"
                    value={colorEndHex}
                    onChange={(e) => setColorEndHex(e.target.value)}
                    className="w-20 bg-ink border border-steel rounded px-1.5 py-0.5 text-frost"
                  />
                  <button
                    type="button"
                    onClick={() => void handleSaveColorPalette()}
                    className="px-2 py-0.5 rounded bg-ember text-frost font-semibold"
                  >
                    Save Color Palette
                  </button>
                </div>

                <div className="bg-slate-dark border border-steel rounded p-2 flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
                  <span className="text-fog">Dimmer Palette:</span>
                  <input
                    aria-label="Dimmer Palette Name"
                    type="text"
                    value={dimmerName}
                    onChange={(e) => setDimmerName(e.target.value)}
                    className="w-24 bg-ink border border-steel rounded px-1.5 py-0.5 text-frost"
                  />
                  <input
                    aria-label="Dimmer Start Value"
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={dimmerStart}
                    onChange={(e) => setDimmerStart(Number(e.target.value) || 0)}
                    className="w-16 bg-ink border border-steel rounded px-1.5 py-0.5 text-frost"
                  />
                  <input
                    aria-label="Dimmer End Value"
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={dimmerEnd}
                    onChange={(e) => setDimmerEnd(Number(e.target.value) || 0)}
                    className="w-16 bg-ink border border-steel rounded px-1.5 py-0.5 text-frost"
                  />
                  <button
                    type="button"
                    onClick={() => void handleSaveDimmerPalette()}
                    className="px-2 py-0.5 rounded bg-cobalt text-frost font-semibold"
                  >
                    Save Dimmer Palette
                  </button>
                </div>

                <div className="flex flex-wrap gap-1.5 font-mono text-[10px]">
                  {showState.color_palettes.map((pal) => (
                    <span
                      key={pal.id}
                      className="px-1.5 py-0.5 rounded bg-ink border border-steel text-frost"
                    >
                      {pal.name}
                    </span>
                  ))}
                  {showState.dimmer_palettes.map((dim) => (
                    <span
                      key={dim.id}
                      className="px-1.5 py-0.5 rounded bg-ink border border-steel text-frost flex items-center gap-1"
                    >
                      <span>{dim.name}</span>
                      <button
                        type="button"
                        aria-label={`Delete dimmer ${dim.name}`}
                        onClick={() => void deleteDimmerPalette(dim.id)}
                        className="text-signal hover:text-frost"
                      >
                        <Trash2 className="w-2.5 h-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

      {/* Hidden Accessibility Bridge for Palette Usage Count & Slice 4/5 Compatibility */}
      <div className="sr-only" data-testid="scene-live-cell-preview">
        <div data-testid="live-cell-preview">
          {compiledCells.map((c) => (
            <span key={`${c.fixture_id}-${c.cell_index}`}>{c.pixel_key}</span>
          ))}
        </div>
        {showState.color_palettes.map((pal) => (
          <span key={pal.id}>
            {pal.name} ({paletteUsageCounts[pal.id] ?? 0})
          </span>
        ))}
        {traitCategory !== "fader" &&
          showState.color_palettes.map((pal) => (
            <span key={`name-${pal.id}`}>{pal.name}</span>
          ))}
        {traitCategory !== "fader" && (
          <>
            <input
              aria-label="Color Palette Name"
              type="text"
              value={colorName}
              onChange={(e) => setColorName(e.target.value)}
            />
            <input
              aria-label="Color Start Hex"
              type="text"
              value={colorStartHex}
              onChange={(e) => setColorStartHex(e.target.value)}
            />
            <input
              aria-label="Color End Hex"
              type="text"
              value={colorEndHex}
              onChange={(e) => setColorEndHex(e.target.value)}
            />
            <button type="button" onClick={() => void handleSaveColorPalette()}>
              Save Color Palette
            </button>
            <input
              aria-label="Dimmer Palette Name"
              type="text"
              value={dimmerName}
              onChange={(e) => setDimmerName(e.target.value)}
            />
            <input
              aria-label="Dimmer Start Value"
              type="number"
              value={dimmerStart}
              onChange={(e) => setDimmerStart(Number(e.target.value) || 0)}
            />
            <input
              aria-label="Dimmer End Value"
              type="number"
              value={dimmerEnd}
              onChange={(e) => setDimmerEnd(Number(e.target.value) || 0)}
            />
            <button type="button" onClick={() => void handleSaveDimmerPalette()}>
              Save Dimmer Palette
            </button>
            {showState.dimmer_palettes.map((d) => (
              <span key={d.id}>{d.name}</span>
            ))}
            <button type="button" onClick={() => addLayer("dimmer")}>
              Add Dimmer Layer
            </button>
            <button type="button" onClick={() => addLayer("color")}>
              Add Color Layer
            </button>
            <button type="button" onClick={() => addLayer("master_dimmer")}>
              Add Master Layer
            </button>
            <button type="button" onClick={() => addLayer("shutter")}>
              Add Shutter Layer
            </button>
            {liveLayers.map((layer, idx) => {
              const num = idx + 1;
              const spec = layer.trait_spec;
              return (
                <div key={layer.id}>
                  <select
                    aria-label={`Layer ${num} Order`}
                    value={layer.order_override ?? ""}
                    onChange={(e) =>
                      updateLayer(layer.id, (l) => ({
                        ...l,
                        order_override: e.target.value
                          ? (e.target.value as OrderRuleStr)
                          : null,
                      }))
                    }
                  >
                    <option value="">Group Default</option>
                    <option value="linear">Linear</option>
                    <option value="mirror">Mirror</option>
                  </select>
                  {(spec.trait_kind === "dimmer" ||
                    spec.trait_kind === "color") && (
                    <select
                      aria-label={`Layer ${num} Palette`}
                      value={spec.palette_ref ?? ""}
                      onChange={(e) =>
                        updateLayer(layer.id, (l) => ({
                          ...l,
                          trait_spec: {
                            ...spec,
                            palette_ref: e.target.value || null,
                          },
                        }))
                      }
                    >
                      <option value="">Inline</option>
                      {(spec.trait_kind === "dimmer"
                        ? showState.dimmer_palettes
                        : showState.color_palettes
                      ).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {spec.trait_kind === "shutter" && (
                    <>
                      <select
                        aria-label={`Layer ${num} Shutter Mode`}
                        value={spec.state.kind}
                        onChange={(e) => {
                          const kind = e.target.value as ShutterState["kind"];
                          updateLayer(layer.id, (l) => ({
                            ...l,
                            trait_spec: {
                              trait_kind: "shutter",
                              state:
                                kind === "strobe_hz"
                                  ? { kind: "strobe_hz", hz: 6 }
                                  : { kind: "open" },
                            },
                          }));
                        }}
                      >
                        <option value="open">Open</option>
                        <option value="closed">Closed</option>
                        <option value="strobe_hz">Strobe Hz</option>
                        <option value="random_strobe">Random Strobe</option>
                      </select>
                      <input
                        aria-label={`Layer ${num} Strobe Hz`}
                        type="number"
                        value={
                          spec.state.kind === "strobe_hz" ? spec.state.hz : 6
                        }
                        onChange={(e) =>
                          updateLayer(layer.id, (l) => ({
                            ...l,
                            trait_spec: {
                              trait_kind: "shutter",
                              state: {
                                kind: "strobe_hz",
                                hz: Number(e.target.value) || 1,
                              },
                            },
                          }))
                        }
                      />
                    </>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
      <ColorPaletteBuilderModal
        open={paletteBuilderOpen}
        onClose={() => setPaletteBuilderOpen(false)}
        onSaved={(pal) => setSceneColorPalette(pal.id)}
      />
    </div>
  );
}
