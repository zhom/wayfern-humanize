// @ts-check

/**
 * Connect to a running Wayfern browser via CDP, refresh the fingerprint
 * for macOS, then read it back.
 */

import { chromium } from "playwright";
import { wayfern } from "../src/index.js";

const cdpUrl = process.env.WAYFERN_CDP ?? "http://127.0.0.1:9222";

const browser = await chromium.connectOverCDP(cdpUrl);
const context = browser.contexts()[0] ?? await browser.newContext();
const page = context.pages()[0] ?? await context.newPage();

const wfp = wayfern(page);

await wfp.refreshFingerprint({
    operatingSystem: "macos",
    timezone: "Europe/Paris",
    language: "fr-FR",
});

const fp = /** @type {any} */ (await wfp.getFingerprint());
console.log("user agent:", fp.userAgent);
console.log("platform:", fp.platform);
console.log("timezone:", fp.timezone);

await wfp.cdp.detach();
await browser.close();
