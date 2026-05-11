// @ts-check

import { chromium } from "../src/index.js";

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

await page.goto("https://duckduckgo.com");

await page.click("input[name=q]");
await page.keyboard.type("wayfern");
await page.click("button[type=submit]");

await page.waitForLoadState("domcontentloaded");
await page.mouse.wheel(0, 800);
await page.mouse.wheel(0, -200);

await browser.close();
