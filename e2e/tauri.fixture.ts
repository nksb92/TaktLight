import {
  type Browser,
  chromium,
  expect,
  type Page,
  test as base,
} from "@playwright/test";
import type { TaktLightTestBridge } from "../src/lib/testBridge";

export interface TauriTestFixtures {
  tauriPage: Page;
  consoleErrors: string[];
  pageErrors: string[];
}

const CDP_URL = process.env.TAKTLIGHT_CDP_URL ?? "http://127.0.0.1:9222";

async function findTaktLightPage(browser: Browser): Promise<Page> {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      const url = p.url();
      if (url.includes("localhost:5173") || url.includes("127.0.0.1:5173") || url.includes("tauri.localhost")) {
        return p;
      }
    }
  }
  const fallback = browser.contexts()[0]?.pages()[0];
  if (!fallback) {
    throw new Error(
      `No WebView2 page found at ${CDP_URL}. Start TaktLight with 'npm run dev:debug' first.`,
    );
  }
  return fallback;
}

export async function evalBridge<T>(
  page: Page,
  fn: (bridge: TaktLightTestBridge) => T,
): Promise<T> {
  return page.evaluate((fnSrc) => {
    const bridge = (window as unknown as { __TAKTLIGHT_TEST__?: TaktLightTestBridge })
      .__TAKTLIGHT_TEST__;
    if (!bridge) {
      throw new Error(
        "window.__TAKTLIGHT_TEST__ is not installed. Run TaktLight in dev mode.",
      );
    }
    const compiled = new Function(`return (${fnSrc})`)() as (
      b: TaktLightTestBridge,
    ) => T;
    return compiled(bridge);
  }, fn.toString());
}

export const test = base.extend<TauriTestFixtures>({
  consoleErrors: async ({}, use) => {
    await use([]);
  },
  pageErrors: async ({}, use) => {
    await use([]);
  },
  tauriPage: async ({ consoleErrors, pageErrors }, use) => {
    let browser: Browser;
    try {
      browser = await chromium.connectOverCDP(CDP_URL);
    } catch (err) {
      throw new Error(
        `Could not connect to Tauri WebView2 CDP at ${CDP_URL}. Launch TaktLight first with 'npm run dev:debug'. Underlying error: ${String(err)}`,
      );
    }

    const page = await findTaktLightPage(browser);

    const onConsole = (msg: { type: () => string; text: () => string }) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    };
    const onPageError = (err: Error) => {
      pageErrors.push(err.message);
    };

    page.on("console", onConsole);
    page.on("pageerror", onPageError);

    await expect(page.getByText("TAKTLIGHT")).toBeVisible({ timeout: 15_000 });

    await use(page);

    page.off("console", onConsole);
    page.off("pageerror", onPageError);

    expect(
      pageErrors,
      `Uncaught page errors detected: ${pageErrors.join("; ")}`,
    ).toEqual([]);
    expect(
      consoleErrors,
      `Console errors detected: ${consoleErrors.join("; ")}`,
    ).toEqual([]);
  },
});

export { expect };
