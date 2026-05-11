// @ts-check

/**
 * wayfern-humanizer — Playwright wrapper that transparently humanizes
 * mouse movement, typing, and scrolling, plus Wayfern CDP fingerprint
 * helpers.
 *
 * @example One-line import swap
 * import { chromium } from "wayfern";
 * const browser = await chromium.launch();
 * const page = await browser.newPage();
 * await page.click("button");      // humanized via hooks
 * await page.fill("input", "hi");  // instant fill — unchanged
 *
 * @example Attach to an existing page
 * import { chromium } from "playwright";
 * import { wayfern } from "wayfern";
 * const page = await (await chromium.launch()).newPage();
 * const wfp = wayfern(page);
 * await page.click("button");         // humanized
 * await wfp.typeText("hello");        // explicit typing
 * await wfp.refreshFingerprint({ operatingSystem: "macos" });
 */

import pw from "playwright";

export { Wayfern, wayfern } from "./wayfern.js";
export { chromium, firefox, webkit } from "./browser.js";
export { HumanCursor } from "./cursor.js";
export { WayfernCdp } from "./cdp.js";
export { humanScroll, scrollIntoView } from "./scroll.js";
export { buildTypingEvents } from "./typer.js";
export { buildPath } from "./bezier.js";
export { KeyboardLayout } from "./keyboard.js";
export { installHooks } from "./hooks.js";

// Pass-through re-exports so users replacing their `playwright` import
// with `wayfern-humanizer` don't lose access to the rest of the API.
export const errors = pw.errors;
export const devices = pw.devices;
export const selectors = pw.selectors;
export const request = pw.request;
// eslint-disable-next-line no-underscore-dangle
export const _electron = pw._electron;
// eslint-disable-next-line no-underscore-dangle
export const _android = pw._android;
