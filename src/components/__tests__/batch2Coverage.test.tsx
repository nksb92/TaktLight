import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FixtureBuilder } from "../FixtureBuilder";
import { PatchView } from "../PatchView";
import { useTaktStore } from "../../store/useTaktStore";
import { buildOflFixtureJson, createDefaultBuilderDraft } from "../../lib/oflBuilder";

async function resetStore() {
  useTaktStore.setState({
    showState: {
      ...useTaktStore.getState().showState,
      read_only_newer_version: false,
      patch: [],
      network_outputs: {
        ...useTaktStore.getState().showState.network_outputs,
        universes: [
          {
            id: 1,
            review_output: false,
            protocol: {
              protocol: "art_net",
              mode: { mode: "broadcast" },
              net: 0,
              subnet: 0,
              uni: 0,
            },
          },
          {
            id: 2,
            review_output: true,
            protocol: {
              protocol: "art_net",
              mode: { mode: "broadcast" },
              net: 0,
              subnet: 0,
              uni: 1,
            },
          },
        ],
      },
    },
    selectedFixtureId: null,
    selectedFixtureInstanceId: null,
    focusedPatchUniverse: 1,
    rolloverEnabled: false,
    crossProtocolWarning: false,
  });
  await useTaktStore.getState().loadFixtures();
}

describe("Batch 2 Coverage — FixtureBuilder", () => {
  beforeEach(async () => {
    await resetStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("covers builder metadata, matrix dimensions, 16-bit fine, strobe, multi-mode edits, and segments", async () => {
    const firstId = useTaktStore.getState().fixtureSummaries[0]?.id ?? null;
    if (firstId) {
      await useTaktStore.getState().selectFixture(firstId);
    }

    const { unmount } = render(<FixtureBuilder />);
    await waitFor(() => {
      expect(screen.getByText(/VALID OFL SCHEMA/i)).toBeInTheDocument();
    });

    // Click New Builder Draft to start fresh, then add 2 modes
    fireEvent.click(screen.getByRole("button", { name: /New Builder Draft/i }));
    fireEvent.click(screen.getByRole("button", { name: /Add Mode/i }));
    fireEvent.click(screen.getByRole("button", { name: /Add Mode/i }));

    // Edit metadata
    const defaultDraft = createDefaultBuilderDraft();
    fireEvent.change(screen.getByDisplayValue(defaultDraft.name), {
      target: { value: "Quad Bar Pro" },
    });
    fireEvent.change(screen.getByDisplayValue(defaultDraft.shortName), {
      target: { value: "QuadPro" },
    });
    fireEvent.change(screen.getByDisplayValue(defaultDraft.category), {
      target: { value: "LED Tube" },
    });

    // Matrix X/Y/Z and Order (tests 1D, 2D, 3D pixel key generation in handleSetModeSegments)
    const numInputs = screen.getAllByRole("spinbutton");
    // X, Y, Z are the first three spinbuttons
    fireEvent.change(numInputs[0], { target: { value: "4" } });
    fireEvent.change(numInputs[1], { target: { value: "2" } });
    fireEvent.change(numInputs[2], { target: { value: "2" } });
    fireEvent.change(screen.getByDisplayValue("perPixel"), {
      target: { value: "perChannel" },
    });

    // Mode segment selector on 3D matrix (4x2x2 = 16px -> 4 seg)
    const segSelect = screen.getByTestId("mode-segment-count-select");
    fireEvent.change(segSelect, { target: { value: "4" } });

    // Switch back to 2D (Z=1) and set segments
    fireEvent.change(numInputs[2], { target: { value: "1" } });
    fireEvent.change(screen.getByTestId("mode-segment-count-select"), {
      target: { value: "2" },
    });

    // Switch to 1D (Y=1, Z=1) and set segments
    fireEvent.change(numInputs[1], { target: { value: "1" } });
    fireEvent.change(screen.getByTestId("mode-segment-count-select"), {
      target: { value: "2" },
    });

    // Toggle 16-bit fine, hardware strobe, random strobe, master dimmer
    fireEvent.click(screen.getByLabelText(/16 Bit Fine/i));
    fireEvent.click(screen.getByLabelText(/Random Strobe/i));
    fireEvent.click(screen.getByLabelText(/Hardware Strobe/i));
    fireEvent.click(screen.getByLabelText(/Hardware Strobe/i));
    fireEvent.click(screen.getByLabelText(/Master Dimmer/i));
    fireEvent.click(screen.getByLabelText(/Master Dimmer/i));

    // Toggle mode name, mode channel toggles, matrix toggle, and delete mode
    fireEvent.change(screen.getByLabelText("Selected Mode Name"), {
      target: { value: "Custom Seg Mode" },
    });
    const dimmerToggle = screen.getByTestId("mode-ch-toggle-Master Dimmer");
    fireEvent.click(dimmerToggle);
    fireEvent.click(dimmerToggle);

    const matrixToggle = screen.getByTestId("mode-ch-toggle-matrix");
    fireEvent.click(matrixToggle);
    fireEvent.click(matrixToggle);

    // Toggle Multi Cell off and back on
    fireEvent.click(screen.getByLabelText(/Multi Cell/i));
    fireEvent.click(screen.getByLabelText(/Multi Cell/i));

    // Delete mode
    fireEvent.click(screen.getByTestId("delete-selected-mode-btn"));

    // Select a fixture from the library list
    const firstSummary = useTaktStore.getState().fixtureSummaries[0];
    if (firstSummary) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(firstSummary.name, "i") }));
    }

    unmount();
  });

  it("covers Color Wheel slots, custom control channels, raw JSON errors, export, and import", async () => {
    const createUrlSpy = vi.fn(() => "blob:mock-ofl");
    const revokeUrlSpy = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      value: createUrlSpy,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeUrlSpy,
      configurable: true,
      writable: true,
    });
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    render(<FixtureBuilder />);
    await waitFor(() => {
      expect(screen.getByText(/VALID OFL SCHEMA/i)).toBeInTheDocument();
    });

    // Switch to Color Wheel
    fireEvent.click(screen.getByRole("button", { name: /Color Wheel/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add Wheel Slot/i })).toBeInTheDocument();
    });

    // Add a wheel slot, edit type/name/color, delete a slot
    fireEvent.click(screen.getByRole("button", { name: /Add Wheel Slot/i }));
    const wheelSelects = screen.getAllByDisplayValue("Open").filter((el) => el.tagName === "SELECT");
    if (wheelSelects.length > 0) {
      fireEvent.change(wheelSelects[0], { target: { value: "Color" } });
    }
    const addedSlotInput = screen.getByDisplayValue(/^Slot \d+$/);
    fireEvent.change(addedSlotInput, { target: { value: "Deep Blue" } });
    const colorInputs = document.querySelectorAll<HTMLInputElement>('input[type="color"]');
    if (colorInputs.length > 0) {
      fireEvent.change(colorInputs[0], { target: { value: "#1122aa" } });
    }
    fireEvent.click(screen.getByRole("button", { name: /Delete wheel slot 1/i }));

    // Add a custom control / macro channel, edit name + default, delete
    fireEvent.click(screen.getByRole("button", { name: /Add Control Channel/i }));
    const macroInput = screen.getByDisplayValue("Macro 1");
    fireEvent.change(macroInput, { target: { value: "Fan Speed" } });
    const defInput = screen.getByDisplayValue("0");
    fireEvent.change(defInput, { target: { value: "128" } });
    await waitFor(() => {
      expect(screen.getByText(/Unmapped/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /Delete control channel Fan Speed/i }));

    // Export JSON
    fireEvent.click(screen.getByRole("button", { name: /Export JSON/i }));
    expect(createUrlSpy).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeUrlSpy).toHaveBeenCalled();

    // Save valid user fixture, then select it from library (covers user editingSource)
    fireEvent.click(screen.getByRole("button", { name: /Save to User Library/i }));
    await waitFor(() => {
      expect(screen.getByText(/Saved /i)).toBeInTheDocument();
    });

    // Switch to Raw JSON editor and trigger invalid JSON syntax errors
    fireEvent.click(screen.getByRole("button", { name: /Raw JSON Editor/i }));
    const textarea = screen.getByLabelText("Raw OFL JSON Editor");
    fireEvent.change(textarea, { target: { value: "{ invalid json" } });

    fireEvent.click(screen.getByRole("button", { name: /Add Mode/i }));
    expect(
      screen.getByText(/Cannot add mode: fix JSON syntax first/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Save to User Library/i }));
    await waitFor(() => {
      expect(screen.getByText(/Save rejected/i)).toBeInTheDocument();
    });

    // Import valid & invalid OFL JSON files
    const fileInput = screen.getByLabelText("Import OFL JSON File");
    const validOfl = buildOflFixtureJson(createDefaultBuilderDraft());
    const validFile = new File([validOfl], "imported_bar.json", {
      type: "application/json",
    });
    Object.defineProperty(validFile, "text", {
      value: async () => validOfl,
    });
    fireEvent.change(fileInput, { target: { files: [validFile] } });
    await waitFor(() => {
      expect(screen.getByText(/Imported .* into local library/i)).toBeInTheDocument();
    });

    const badFile = new File(["{ bad"], "broken.json", {
      type: "application/json",
    });
    Object.defineProperty(badFile, "text", {
      value: async () => "{ bad",
    });
    fireEvent.change(fileInput, { target: { files: [badFile] } });
    await waitFor(() => {
      expect(
        screen.getByText(/Imported file failed OFL schema validation/i),
      ).toBeInTheDocument();
    });
  });
});

describe("Batch 2 Coverage — PatchView", () => {
  beforeEach(async () => {
    await resetStore();
    const summaries = useTaktStore.getState().fixtureSummaries;
    const prof = summaries[0];
    if (prof) {
      await useTaktStore.getState().patchFixtures(
        prof.id,
        prof.modes[0].name,
        "Bar",
        1,
        1,
        1,
      );
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("covers universe navigation, shortcuts, protocol popover, review output, split warning, and read-only banner", async () => {
    // Patch a split fixture straddling U1 -> U2 and enable read_only_newer_version
    const prof = useTaktStore.getState().fixtureSummaries[0]!;
    await useTaktStore.getState().setRolloverEnabled(true);
    await useTaktStore.getState().patchFixtures(
      prof.id,
      prof.modes[0].name,
      "SplitFx",
      1,
      1,
      510,
    );
    await useTaktStore.getState().setRolloverEnabled(false);
    useTaktStore.setState((s) => ({
      showState: { ...s.showState, read_only_newer_version: true },
    }));

    render(<PatchView />);

    // Read-only banner & cross-protocol split warning
    expect(screen.getByText(/Opened in read only mode/i)).toBeInTheDocument();
    expect(screen.getByText(/CROSS PROTOCOL SPLIT/i)).toBeInTheDocument();

    // Mark Universe 2 reviewed
    const reviewBtn = screen.getByText(/Review output/i);
    fireEvent.click(reviewBtn);

    // Universe protocol popover: Art-Net Net/Sub/Uni -> sACN -> Art-Net -> Done
    fireEvent.click(screen.getByTestId("universe-protocol-btn-1"));
    const protoPopover = screen.getByTestId("universe-protocol-popover-1");
    expect(protoPopover).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Universe 1 ArtNet Net"), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByLabelText("Universe 1 ArtNet Subnet"), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByLabelText("Universe 1 ArtNet Uni"), {
      target: { value: "4" },
    });

    // Switch to sACN
    fireEvent.change(screen.getByLabelText("Universe 1 Protocol"), {
      target: { value: "sacn" },
    });
    fireEvent.change(screen.getByLabelText("Universe 1 sACN Universe"), {
      target: { value: "7" },
    });
    fireEvent.change(screen.getByLabelText("Universe 1 sACN Priority"), {
      target: { value: "120" },
    });

    // Switch back to Art-Net and close popover
    fireEvent.change(screen.getByLabelText("Universe 1 Protocol"), {
      target: { value: "art_net" },
    });
    fireEvent.click(within(protoPopover).getByText("Done"));

    // Resolve split fixtures
    fireEvent.click(screen.getByTestId("resolve-split-fixtures-button"));

    // Navigate universes (Next -> U3 preview, Prev -> U1) & keyboard shortcuts
    const findBtn = (pattern: RegExp) =>
      Array.from(document.querySelectorAll("button")).find(
        (b) =>
          pattern.test((b.textContent ?? "").trim()) ||
          pattern.test(b.getAttribute("aria-label") ?? ""),
      )!;
    fireEvent.click(findBtn(/^Next$/i));
    fireEvent.click(findBtn(/^Next$/i));
    expect(screen.getAllByText(/Preview next/i).length).toBeGreaterThan(0);
    fireEvent.click(findBtn(/^Prev$/i));

    // Keyboard shortcuts: PageDown, PageUp, R, Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y
    fireEvent.keyDown(window, { key: "PageDown" });
    fireEvent.keyDown(window, { key: "PageUp" });
    fireEvent.keyDown(window, { key: "r" });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
  });

  it("covers pointer drag move, click-to-move, ghost preview, context menu, calibration, and XML export/import", async () => {
    const createUrlSpy = vi.fn(() => "blob:mock-xml");
    const revokeUrlSpy = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      value: createUrlSpy,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeUrlSpy,
      configurable: true,
      writable: true,
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(<PatchView />);

    const fx = useTaktStore.getState().showState.patch[0]!;

    // Click empty cell to set start address
    fireEvent.click(screen.getByTestId("patch-u1-ch100"));

    // Click-to-move via Move button -> hover cell -> Escape cancel
    fireEvent.click(screen.getByLabelText(`Move ${fx.name}`));
    fireEvent.mouseEnter(screen.getByTestId("patch-u1-ch120"));
    expect(screen.getByText(/Cancel Move/i)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });

    // Click-to-move again -> click target cell
    fireEvent.click(screen.getByLabelText(`Move ${fx.name}`));
    fireEvent.mouseEnter(screen.getByTestId("patch-u1-ch200"));
    fireEvent.click(screen.getByTestId("patch-u1-ch200"));
    await waitFor(() => {
      expect(useTaktStore.getState().showState.patch[0]?.address).toBe(200);
    });

    // Pointer drag move on cell with mocked elementFromPoint
    const targetCell = screen.getByTestId("patch-u1-ch250");
    const origElemFromPoint = document.elementFromPoint;
    document.elementFromPoint = vi.fn(() => targetCell);
    try {
      const ownedCell = screen.getByTestId("patch-u1-ch200");
      fireEvent(
        ownedCell,
        new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
      );
      fireEvent(
        window,
        new MouseEvent("pointermove", { bubbles: true, clientX: 50, clientY: 50 }),
      );
      fireEvent(
        window,
        new MouseEvent("pointerup", { bubbles: true, clientX: 50, clientY: 50 }),
      );
    } finally {
      document.elementFromPoint = origElemFromPoint;
    }
    await waitFor(() => {
      expect(useTaktStore.getState().showState.patch[0]?.address).toBe(250);
    });

    // Context menu on fixture block -> Move Fixture -> Cancel Move
    const patchBlock = screen.getByTestId(`patch-block-${fx.id}`);
    fireEvent.contextMenu(patchBlock, { clientX: 40, clientY: 40 });
    const ctxMenu = screen.getByTestId("patch-fixture-context-menu");
    expect(ctxMenu).toBeInTheDocument();
    fireEvent.click(within(ctxMenu).getByText("Move Fixture"));
    fireEvent.click(screen.getByText("Cancel Move"));

    // Context menu on grid cell -> dismiss via window click
    const movedCell = screen.getByTestId("patch-u1-ch250");
    fireEvent.contextMenu(movedCell, { clientX: 40, clientY: 40 });
    expect(screen.getByTestId("patch-fixture-context-menu")).toBeInTheDocument();
    fireEvent.click(window);

    // Calibration fields
    fireEvent.change(screen.getByLabelText("Gamma"), { target: { value: "2.6" } });
    fireEvent.change(screen.getByLabelText("Min Dimmer DMX"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Max Dimmer DMX"), { target: { value: "240" } });
    fireEvent.change(screen.getByLabelText("White Mode"), { target: { value: "add" } });
    fireEvent.change(screen.getByLabelText("White Gain"), { target: { value: "1.2" } });

    // Export XML
    const exportBtn = Array.from(document.querySelectorAll("button")).find(
      (b) =>
        /Export \.takt\.xml/i.test(b.textContent ?? "") ||
        /Export \.takt\.xml/i.test(b.getAttribute("aria-label") ?? ""),
    )!;
    fireEvent.click(exportBtn);
    await waitFor(() => {
      expect(screen.getByTestId("show-xml-preview")).toBeInTheDocument();
    });
    expect(createUrlSpy).toHaveBeenCalled();
    expect(revokeUrlSpy).toHaveBeenCalled();

    // Import valid XML
    const exported = screen.getByTestId("show-xml-preview").textContent ?? "";
    const xmlInput = screen.getByLabelText("Import Show XML File");
    const validXmlFile = new File([exported], "show.takt.xml", {
      type: "application/xml",
    });
    Object.defineProperty(validXmlFile, "text", {
      value: async () => exported,
    });
    fireEvent.change(xmlInput, { target: { files: [validXmlFile] } });
    await waitFor(() => {
      expect(useTaktStore.getState().patchToast).toMatch(/Imported/i);
    });

    // Import malformed XML -> xmlError banner via parsererror check
    const badXmlFile = new File(["<TaktLightShow><broken"], "bad.takt.xml", {
      type: "application/xml",
    });
    Object.defineProperty(badXmlFile, "text", {
      value: async () => "<TaktLightShow><broken",
    });
    fireEvent.change(xmlInput, { target: { files: [badXmlFile] } });
    await waitFor(() => {
      expect(screen.getByText(/Invalid XML syntax|Missing <TaktLightShow>/i)).toBeInTheDocument();
    });

    // Context menu Unpatch
    const curFx = useTaktStore.getState().showState.patch[0];
    if (curFx) {
      fireEvent.contextMenu(screen.getByTestId(`patch-block-${curFx.id}`), {
        clientX: 20,
        clientY: 20,
      });
      fireEvent.click(within(screen.getByTestId("patch-fixture-context-menu")).getByText("Unpatch"));
    }
  });
});
