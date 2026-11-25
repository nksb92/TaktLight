import { expect, Page, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

interface LayoutIssue {
  kind:
    | "viewport_overflow_x"
    | "element_out_of_viewport"
    | "out_of_parent_box"
    | "sibling_overlap"
    | "control_text_overflow"
    | "bar_vertical_misalignment";
  view: string;
  viewport: string;
  selector: string;
  detail: string;
}

const VIEWPORTS = [
  { name: "1280x720", width: 1280, height: 720 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 },
] as const;

const SCREENSHOT_DIR = path.resolve(
  process.cwd(),
  "test-results",
  "ui-layout-audit",
);

async function auditCurrentViewLayout(
  page: Page,
  viewName: string,
  viewportName: string,
): Promise<LayoutIssue[]> {
  return page.evaluate(
    ({ view, vp }) => {
      const issues: Array<{
        kind:
          | "viewport_overflow_x"
          | "element_out_of_viewport"
          | "out_of_parent_box"
          | "sibling_overlap"
          | "control_text_overflow"
          | "bar_vertical_misalignment";
        view: string;
        viewport: string;
        selector: string;
        detail: string;
      }> = [];

      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const describeEl = (el: Element): string => {
        const tag = el.tagName.toLowerCase();
        const testId = el.getAttribute("data-testid");
        const aria = el.getAttribute("aria-label");
        const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 32);
        if (testId) return `${tag}[data-testid="${testId}"]`;
        if (aria) return `${tag}[aria-label="${aria}"]`;
        if (text) return `${tag}("${text}")`;
        return tag;
      };

      const isVisible = (el: Element): boolean => {
        if (el.closest(".sr-only, [aria-hidden='true']")) {
          return false;
        }
        let cur: Element | null = el;
        while (cur && cur !== document.body) {
          const st = window.getComputedStyle(cur);
          if (
            st.display === "none" ||
            st.visibility === "hidden" ||
            Number(st.opacity) === 0 ||
            st.clip === "rect(0px, 0px, 0px, 0px)"
          ) {
            return false;
          }
          cur = cur.parentElement;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1;
      };

      const isInsideScrollableAncestor = (el: Element): boolean => {
        let cur = el.parentElement;
        while (cur && cur !== document.body) {
          const st = window.getComputedStyle(cur);
          if (
            st.overflowX === "auto" ||
            st.overflowX === "scroll" ||
            st.overflowY === "auto" ||
            st.overflowY === "scroll"
          ) {
            return true;
          }
          cur = cur.parentElement;
        }
        return false;
      };

      // 1. Page-level horizontal overflow
      if (document.documentElement.scrollWidth > vw + 2) {
        issues.push({
          kind: "viewport_overflow_x",
          view,
          viewport: vp,
          selector: "documentElement",
          detail: `scrollWidth=${document.documentElement.scrollWidth}px > innerWidth=${vw}px`,
        });
      }

      // 2. Interactive controls out of viewport or out of non-scrollable parent box
      const controls = Array.from(
        document.querySelectorAll("button, input, select, textarea, [role='tab']"),
      ).filter(isVisible);

      for (const el of controls) {
        const rect = el.getBoundingClientRect();
        const inScroll = isInsideScrollableAncestor(el);

        if (!inScroll) {
          if (rect.left < -2 || rect.right > vw + 2) {
            issues.push({
              kind: "element_out_of_viewport",
              view,
              viewport: vp,
              selector: describeEl(el),
              detail: `rect=[${Math.round(rect.left)}..${Math.round(rect.right)}] outside viewport [0..${vw}]`,
            });
          }
          if (rect.top < -2 || rect.bottom > vh + 2) {
            // Only flag vertical overflow on fixed/header/footer or studio locked-height layouts
            const bodyOverflowHidden =
              window.getComputedStyle(document.body).overflowY === "hidden" ||
              !!el.closest("header, nav, [role='dialog']");
            if (bodyOverflowHidden) {
              issues.push({
                kind: "element_out_of_viewport",
                view,
                viewport: vp,
                selector: describeEl(el),
                detail: `rectY=[${Math.round(rect.top)}..${Math.round(rect.bottom)}] outside viewport [0..${vh}]`,
              });
            }
          }
        }

        // Check parent container horizontal bounds (non-scrollable parents only)
        const parent = el.parentElement;
        if (parent && isVisible(parent)) {
          const pStyle = window.getComputedStyle(parent);
          const pScrollable =
            pStyle.overflowX === "auto" || pStyle.overflowX === "scroll";
          if (!pScrollable && pStyle.display !== "contents") {
            const pRect = parent.getBoundingClientRect();
            if (
              pRect.width > 10 &&
              (rect.right > pRect.right + 4 || rect.left < pRect.left - 4)
            ) {
              issues.push({
                kind: "out_of_parent_box",
                view,
                viewport: vp,
                selector: `${describeEl(el)} in ${describeEl(parent)}`,
                detail: `childX=[${Math.round(rect.left)}..${Math.round(rect.right)}] exceeds parentX=[${Math.round(pRect.left)}..${Math.round(pRect.right)}]`,
              });
            }
          }
        }

        // Check button text overflow (when not intentionally truncated)
        if (el.tagName === "BUTTON") {
          const st = window.getComputedStyle(el);
          const allowsTruncate =
            st.textOverflow === "ellipsis" ||
            el.className.includes("truncate") ||
            !!el.querySelector(".truncate");
          if (!allowsTruncate && el.scrollWidth > el.clientWidth + 4) {
            issues.push({
              kind: "control_text_overflow",
              view,
              viewport: vp,
              selector: describeEl(el),
              detail: `scrollWidth=${el.scrollWidth}px > clientWidth=${el.clientWidth}px`,
            });
          }
        }
      }

      // 3. Sibling interactive control overlap detection
      const checkedParents = new Set<Element>();
      for (const el of controls) {
        const parent = el.parentElement;
        if (!parent || checkedParents.has(parent)) continue;
        checkedParents.add(parent);
        const directControls = Array.from(parent.children).filter(
          (c) =>
            (c.tagName === "BUTTON" ||
              c.tagName === "INPUT" ||
              c.tagName === "SELECT" ||
              c.getAttribute("role") === "tab") &&
            isVisible(c),
        );
        if (directControls.length < 2) continue;

        const rects = directControls.map((c) => ({
          el: c,
          r: c.getBoundingClientRect(),
        }));
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i].r;
            const b = rects[j].r;
            const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (overlapX > 2 && overlapY > 2) {
              issues.push({
                kind: "sibling_overlap",
                view,
                viewport: vp,
                selector: `${describeEl(rects[i].el)} <-> ${describeEl(rects[j].el)}`,
                detail: `overlap=${Math.round(overlapX)}x${Math.round(overlapY)}px`,
              });
            }
          }
        }
      }

      // 4. Header & Bottom Nav vertical alignment check
      const bars = Array.from(document.querySelectorAll("header, nav")).filter(
        isVisible,
      );
      for (const bar of bars) {
        const bRect = bar.getBoundingClientRect();
        const barButtons = Array.from(bar.querySelectorAll("button")).filter(
          isVisible,
        );
        for (const btn of barButtons) {
          const r = btn.getBoundingClientRect();
          if (r.top < bRect.top - 2 || r.bottom > bRect.bottom + 2) {
            issues.push({
              kind: "bar_vertical_misalignment",
              view,
              viewport: vp,
              selector: `${describeEl(btn)} in ${describeEl(bar)}`,
              detail: `btnY=[${Math.round(r.top)}..${Math.round(r.bottom)}] outside barY=[${Math.round(bRect.top)}..${Math.round(bRect.bottom)}]`,
            });
          }
        }
      }

      return issues;
    },
    { view: viewName, vp: viewportName },
  );
}

test.describe("UI Out-of-Box & Alignment Audit", () => {
  test.beforeAll(() => {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  for (const vp of VIEWPORTS) {
    test(`layout & alignment audit at ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/");
      await expect(page.getByText("TAKTLIGHT")).toBeVisible();

      const allIssues: LayoutIssue[] = [];

      const views: Array<{
        name: string;
        navigate: () => Promise<void>;
      }> = [
        {
          name: "studio",
          navigate: async () => {
            await page.getByRole("button", { name: /Studio \/ 2D Grid/i }).click();
            await page.waitForTimeout(150);
          },
        },
        {
          name: "studio-timeline",
          navigate: async () => {
            const tlTile = page.getByTestId("scene-play-zone-sc_tl_cyber_intro");
            if (await tlTile.isVisible()) {
              await tlTile.click();
              await page.waitForTimeout(150);
            }
          },
        },
        {
          name: "studio-timeline-expanded",
          navigate: async () => {
            const expandBtn = page.getByTestId("timeline-expand-toggle");
            if (await expandBtn.isVisible()) {
              await expandBtn.click();
              await page.waitForTimeout(150);
            }
          },
        },
        {
          name: "studio-fx-submenu",
          navigate: async () => {
            const expandBtn = page.getByTestId("timeline-expand-toggle");
            if (await expandBtn.isVisible()) {
              await expandBtn.click();
              await page.waitForTimeout(100);
            }
            const firstScene = page.locator("[data-testid^='scene-tile-']").first();
            if (await firstScene.isVisible()) {
              await firstScene.click();
            }
            const fxTile = page.getByTestId("fx-picker-tile-curve_fx");
            if (await fxTile.isVisible()) {
              await fxTile.click();
              await page.waitForTimeout(150);
            }
          },
        },
        {
          name: "patch",
          navigate: async () => {
            await page.getByRole("button", { name: /^Patch$/i }).click();
            await page.waitForTimeout(150);
          },
        },
        {
          name: "fixtures",
          navigate: async () => {
            await page.getByRole("button", { name: /^Fixtures$/i }).click();
            await page.waitForTimeout(150);
          },
        },
        {
          name: "monitor",
          navigate: async () => {
            await page.getByRole("button", { name: /^Monitor$/i }).click();
            await page.waitForTimeout(150);
          },
        },
      ];

      for (const v of views) {
        await v.navigate();
        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, `${vp.name}_${v.name}.png`),
          fullPage: false,
        });
        const found = await auditCurrentViewLayout(page, v.name, vp.name);
        allIssues.push(...found);
      }

      // Write JSON report for AI/human inspection
      fs.writeFileSync(
        path.join(SCREENSHOT_DIR, `report_${vp.name}.json`),
        JSON.stringify(allIssues, null, 2),
      );

      expect(
        allIssues,
        `Found ${allIssues.length} layout/alignment issue(s) at ${vp.name}:\n` +
          allIssues
            .slice(0, 15)
            .map(
              (i) =>
                `  [${i.kind}] (${i.view}) ${i.selector}: ${i.detail}`,
            )
            .join("\n"),
      ).toEqual([]);
    });
  }
});
