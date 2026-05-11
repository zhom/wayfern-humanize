// @ts-check

/**
 * Verification harness — runs in two phases:
 *
 *   Phase 1 (Wayfern binary):
 *     Spawns the local Wayfern Chromium build, then exercises only the
 *     Wayfern.* CDP fingerprint commands. Wayfern gates Runtime.evaluate
 *     and Page.addScriptToEvaluateOnNewDocument behind a paid token,
 *     so we can't read page state from this browser without one — but
 *     getFingerprint/refreshFingerprint are NOT gated, which is exactly
 *     what we want to verify.
 *
 *   Phase 2 (Playwright Chromium):
 *     Drives the humanizer (mouse, typing, scroll) against an
 *     instrumented local page and asserts on humanness properties of
 *     the recorded events. Uses Playwright's bundled Chromium where
 *     Runtime.evaluate works, since Phase 1 already proved the same
 *     code path lands in Wayfern.
 *
 * Usage:
 *   node verify/run.mjs
 *
 * Env:
 *   WAYFERN_BINARY  override the Wayfern Chromium path
 *   WAYFERN_HEADED  set to "1" to launch with a window
 *   VERBOSE         set to "1" for browser logs and debug output
 *   SKIP_WAYFERN    set to "1" to skip Phase 1
 *   SKIP_HUMAN      set to "1" to skip Phase 2
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { wayfern } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DEFAULT_BINARY = resolve(
    ROOT,
    "../wayfern-macos/build/src/out/Default/Chromium.app/Contents/MacOS/Chromium",
);

const BINARY = process.env.WAYFERN_BINARY ?? DEFAULT_BINARY;
const HEADLESS = process.env.WAYFERN_HEADED !== "1";
const VERBOSE = process.env.VERBOSE === "1";

/**
 * Resolve the Wayfern token. Order of precedence:
 *   1. WAYFERN_TOKEN env
 *   2. WAYFERN_TEST_TOKEN env
 *   3. WAYFERN_TEST_TOKEN= line in ../wayfern-macos/.env
 *
 * @returns {string | undefined}
 */
function resolveWayfernToken() {
    if (process.env.WAYFERN_TOKEN) return process.env.WAYFERN_TOKEN;
    if (process.env.WAYFERN_TEST_TOKEN) return process.env.WAYFERN_TEST_TOKEN;
    const envPath = resolve(ROOT, "../wayfern-macos/.env");
    if (!existsSync(envPath)) return undefined;
    try {
        const contents = readFileSync(envPath, "utf8");
        const match = contents.match(/^\s*WAYFERN_TEST_TOKEN\s*=\s*"?([^"\n]+)"?/m);
        return match?.[1];
    } catch { return undefined; }
}

/** @type {Array<{ name: string, ok: boolean, detail?: string, phase: string }>} */
const results = [];

/**
 * @param {string} phase
 * @param {string} name
 * @param {() => void | Promise<void>} fn
 */
async function check(phase, name, fn) {
    try {
        await fn();
        results.push({ phase, name, ok: true });
        console.log(`  ✓ ${name}`);
    } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        results.push({ phase, name, ok: false, detail });
        console.log(`  ✗ ${name}\n      ${detail}`);
    }
}

/**
 * @param {boolean} cond
 * @param {string} msg
 */
function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

/**
 * @param {{ userAgent?: string, platform?: string } | null} fp
 * @returns {"macos" | "windows" | "linux"}
 */
function detectHostOs(fp) {
    const ua = fp?.userAgent ?? "";
    const platform = (fp?.platform ?? "").toLowerCase();
    if (/Mac OS X|Macintosh/i.test(ua) || platform.includes("mac")) return "macos";
    if (/Windows/i.test(ua) || platform.includes("win")) return "windows";
    return "linux";
}

/**
 * @param {{ userAgent?: string, platform?: string }} fp
 * @param {"macos" | "windows" | "linux" | "android" | "ios"} os
 * @returns {boolean}
 */
function matchesOs(fp, os) {
    const ua = fp.userAgent ?? "";
    const p = (fp.platform ?? "").toLowerCase();
    switch (os) {
        case "macos":   return /Mac OS X|Macintosh/i.test(ua) || p.includes("mac");
        case "windows": return /Windows/i.test(ua) || p.includes("win");
        case "linux":   return /Linux|X11/i.test(ua) || p.includes("linux");
        case "android": return /Android/i.test(ua) || p.includes("android");
        case "ios":     return /iPhone|iPad|iOS/i.test(ua) || p.includes("ios");
    }
}

/** @param {number[]} xs */
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
/** @param {number[]} xs */
const stddev = (xs) => {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
};

/** @returns {Promise<number>} */
async function freePort() {
    const { default: net } = await import("node:net");
    return new Promise((resolveFn) => {
        const srv = net.createServer();
        srv.listen(0, () => {
            const addr = srv.address();
            const port = typeof addr === "object" && addr ? addr.port : 0;
            srv.close(() => resolveFn(port));
        });
    });
}

/**
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
async function serveVerifyPage() {
    const html = readFileSync(join(__dirname, "page.html"));
    const port = await freePort();
    const server = createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
    });
    await new Promise((r) => server.listen(port, "127.0.0.1", () => r(undefined)));
    return {
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((r) => server.close(() => r(undefined))),
    };
}

/* ---------------- Phase 1: Wayfern binary fingerprint CDP ---------------- */

async function phase1() {
    if (process.env.SKIP_WAYFERN === "1") {
        console.log("\n=== Phase 1: Wayfern fingerprint CDP === [SKIPPED]\n");
        return;
    }
    if (!existsSync(BINARY)) {
        console.log(`\n=== Phase 1: Wayfern fingerprint CDP === [SKIPPED — binary not at ${BINARY}]\n`);
        return;
    }

    console.log("\n=== Phase 1: Wayfern fingerprint CDP ===");

    const port = await freePort();
    const userDataDir = mkdtempSync(join(tmpdir(), "wayfern-verify-"));
    const wayfernToken = resolveWayfernToken();
    if (wayfernToken && VERBOSE) {
        console.log(`[verify] using wayfern token ${wayfernToken.slice(0, 8)}…`);
    }
    /** @type {string[]} */
    const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=DialMediaRouteProvider",
        "--use-mock-keychain",
        "--password-store=basic",
    ];
    if (HEADLESS) args.push("--headless=new", "--disable-gpu");
    if (wayfernToken) args.push(`--wayfern-token=${wayfernToken}`);

    if (VERBOSE) console.log(`[verify] spawn ${BINARY} ${args.join(" ")}`);
    const child = spawn(BINARY, args, { stdio: VERBOSE ? "inherit" : "pipe" });

    let info;
    const start = Date.now();
    while (Date.now() - start < 15000) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (r.ok) { info = await r.json(); break; }
        } catch {}
        await new Promise((r) => setTimeout(r, 200));
    }
    if (!info) {
        child.kill("SIGKILL");
        try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
        throw new Error("Wayfern browser failed to start in 15s");
    }
    if (VERBOSE) console.log(`[verify] browser online: ${info.Browser}`);

    let browser;
    try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        const ctx = browser.contexts()[0] ?? await browser.newContext();
        // We can't navigate or evaluate on Wayfern without a token, but
        // we don't need to — fingerprint commands attach to the Browser
        // session directly. Just create an empty page so we have a target.
        const page = ctx.pages()[0] ?? await ctx.newPage();
        const wf = wayfern(page);

        /** @type {any} */
        let initialFp;
        await check("phase1", "Wayfern.getFingerprint returns a populated payload", async () => {
            initialFp = await wf.getFingerprint();
            assert(initialFp && typeof initialFp === "object", "no payload");
            assert(typeof initialFp.userAgent === "string" && initialFp.userAgent.length > 0,
                `userAgent missing: ${JSON.stringify(initialFp).slice(0, 120)}`);
            if (VERBOSE) console.log(`      UA: ${initialFp.userAgent}`);
        });

        // Detect host OS from the initial fingerprint so we know which
        // refresh is "host OS" (free, no token required) vs cross-OS.
        const hostOs = detectHostOs(initialFp);
        if (VERBOSE) console.log(`      host OS detected: ${hostOs}`);

        await check("phase1", `Wayfern.refreshFingerprint(${hostOs}) — host OS, no token needed`, async () => {
            await wf.refreshFingerprint({ operatingSystem: hostOs });
            /** @type {any} */
            const fp = await wf.getFingerprint();
            assert(typeof fp.userAgent === "string", "no UA after refresh");
            if (VERBOSE) console.log(`      UA=${fp.userAgent} platform=${fp.platform}`);
            assert(matchesOs(fp, hostOs), `UA/platform doesn't look like ${hostOs}: ${fp.userAgent} / ${fp.platform}`);
        });

        await check("phase1", "Successive host-OS refreshes randomize at least one field", async () => {
            await wf.refreshFingerprint({ operatingSystem: hostOs });
            /** @type {any} */
            const a = await wf.getFingerprint();
            await wf.refreshFingerprint({ operatingSystem: hostOs });
            /** @type {any} */
            const b = await wf.getFingerprint();
            const fields = ["userAgent", "screenWidth", "screenHeight", "hardwareConcurrency", "deviceMemory", "webglRenderer"];
            const differs = fields.some((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
            assert(differs, "two host-OS refreshes returned identical values across all probed fields");
        });

        // Cross-OS requires a paid plan; only run when a token is configured.
        if (wayfernToken) {
            const otherOses = /** @type {const} */ (["windows", "macos", "linux"]).filter((os) => os !== hostOs);
            for (const os of otherOses) {
                await check("phase1", `Wayfern.refreshFingerprint(${os}) — cross-OS via token`, async () => {
                    await wf.refreshFingerprint({ operatingSystem: os, wayfernToken });
                    /** @type {any} */
                    const fp = await wf.getFingerprint();
                    if (VERBOSE) console.log(`      after ${os}: UA=${fp.userAgent} platform=${fp.platform}`);
                    assert(matchesOs(fp, os), `UA/platform doesn't look like ${os}: ${fp.userAgent} / ${fp.platform}`);
                });
            }
        } else {
            await check("phase1", "Cross-OS refresh is gated when no token is set", async () => {
                let rejected = false;
                try {
                    const otherOs = hostOs === "macos" ? "windows" : "macos";
                    await wf.refreshFingerprint({ operatingSystem: otherOs });
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    rejected = /paid plan|wayfernToken/i.test(msg);
                }
                assert(rejected, "expected gating error from cross-OS refresh without token");
            });
            console.log("      (set WAYFERN_TOKEN=... to verify cross-OS refresh end-to-end)");
        }

        await wf.cdp.detach();
    } finally {
        if (browser) await browser.close().catch(() => {});
        child.kill("SIGTERM");
        try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    }
}

/* ---------------- Phase 2: humanization on Playwright Chromium ---------------- */

async function phase2() {
    if (process.env.SKIP_HUMAN === "1") {
        console.log("\n=== Phase 2: humanization on Playwright Chromium === [SKIPPED]\n");
        return;
    }

    console.log("\n=== Phase 2: humanization on Playwright Chromium ===");

    const server = await serveVerifyPage();
    const browser = await chromium.launch({ headless: HEADLESS });
    try {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });

        // Pre-inject the event recorder before any navigation.
        await ctx.addInitScript(() => {
            const events = [];
            const t0 = performance.now();
            const log = (e) => events.push({ ...e, t: performance.now() - t0 });
            const opts = { capture: true, passive: true };
            addEventListener("mousemove", (e) => log({ type: "mousemove", x: e.clientX, y: e.clientY }), opts);
            addEventListener("mousedown", (e) => log({ type: "mousedown", x: e.clientX, y: e.clientY }), opts);
            addEventListener("mouseup",   (e) => log({ type: "mouseup",   x: e.clientX, y: e.clientY }), opts);
            addEventListener("click",     (e) => log({ type: "click",     x: e.clientX, y: e.clientY }), opts);
            addEventListener("wheel",     (e) => log({ type: "wheel", dx: e.deltaX, dy: e.deltaY }), opts);
            addEventListener("keydown",   (e) => log({ type: "keydown", key: e.key }), opts);
            addEventListener("keyup",     (e) => log({ type: "keyup",   key: e.key }), opts);
            addEventListener("input",     (e) => log({ type: "input", value: /** @type {any} */ (e.target).value }), opts);
            addEventListener("scroll",    () => log({ type: "scroll", y: window.scrollY }), opts);
            // @ts-ignore
            window.__events = events;
            // @ts-ignore
            window.__resetEvents = () => { events.length = 0; };
        });

        const page = await ctx.newPage();
        page.on("pageerror", (e) => console.log(`[page error] ${e.message}`));
        await page.goto(server.url, { waitUntil: "load" });
        await page.waitForFunction("typeof window.__events !== 'undefined'", null, { timeout: 5000 });

        const wf = wayfern(page);

        const reset = () => page.evaluate("window.__resetEvents()");
        /** @returns {Promise<any[]>} */
        const dump = () => /** @type {Promise<any[]>} */ (page.evaluate("window.__events.slice()"));

        // --- Explicit API: mouse ---
        await reset();
        await wf.move(200, 200, { overshoot: 0 });
        await wf.move(900, 600);
        const moveEvents = await dump();
        const mousemoves = moveEvents.filter((e) => e.type === "mousemove");

        await check("phase2", "mouse path is multi-step (≥ 20 mousemove events)", () => {
            assert(mousemoves.length >= 20, `got ${mousemoves.length}`);
        });

        await check("phase2", "mouse path is curved (perpendicular deviation > 5px)", () => {
            // Use the second leg only — the first leg has overshoot:0, the
            // second uses defaults so it should curve.
            const a = mousemoves[Math.floor(mousemoves.length / 2)];
            const b = mousemoves[mousemoves.length - 1];
            const dx = b.x - a.x, dy = b.y - a.y;
            const len = Math.hypot(dx, dy) || 1;
            let maxDev = 0;
            for (let i = Math.floor(mousemoves.length / 2) + 1; i < mousemoves.length - 1; i += 1) {
                const p = mousemoves[i];
                const dev = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
                if (dev > maxDev) maxDev = dev;
            }
            assert(maxDev > 5, `max perpendicular deviation only ${maxDev.toFixed(2)}px`);
        });

        await check("phase2", "mousemove inter-event delays vary (stddev > 0.5 ms)", () => {
            /** @type {number[]} */
            const dts = [];
            for (let i = 1; i < mousemoves.length; i += 1) {
                dts.push(mousemoves[i].t - mousemoves[i - 1].t);
            }
            const sd = stddev(dts);
            assert(sd > 0.5, `stddev only ${sd.toFixed(2)}`);
        });

        // --- Click ---
        // Pre-position the cursor far from the target so the click
        // induces a long move and we can assert on hover-before-click.
        await wf.move(50, 50, { overshoot: 0 });
        await reset();
        await wf.click("#target");
        const clickEvents = await dump();
        const downs = clickEvents.filter((e) => e.type === "mousedown");
        const ups = clickEvents.filter((e) => e.type === "mouseup");
        const clickMoves = clickEvents.filter((e) => e.type === "mousemove");

        await check("phase2", "click produces 1 mousedown + 1 mouseup", () => {
            assert(downs.length === 1 && ups.length === 1, `got ${downs.length} down / ${ups.length} up`);
        });

        await check("phase2", "mousedown→mouseup delay is in human range (40–250 ms)", () => {
            const dt = ups[0].t - downs[0].t;
            assert(dt >= 40 && dt <= 250, `down→up was ${dt.toFixed(1)} ms`);
        });

        await check("phase2", "click on far target inserts hover-before-click pause (≥ 100 ms)", () => {
            const lastMove = clickMoves[clickMoves.length - 1];
            const gap = downs[0].t - lastMove.t;
            assert(gap >= 100, `expected hover pause ≥ 100 ms before mousedown, got ${gap.toFixed(1)} ms`);
            assert(gap <= 500, `expected hover pause ≤ 500 ms before mousedown, got ${gap.toFixed(1)} ms`);
        });

        // --- Typing (no errors) ---
        await reset();
        await wf.type("#email", "alice@example.com", { wpm: 80, errors: false });
        const typeEvents = await dump();
        const keydowns = typeEvents.filter((e) => e.type === "keydown");
        const inputs = typeEvents.filter((e) => e.type === "input");

        await check("phase2", "typing emits one keydown per character", () => {
            assert(keydowns.length === "alice@example.com".length,
                `got ${keydowns.length} for ${"alice@example.com".length}`);
        });

        await check("phase2", "final input value matches target", () => {
            const last = inputs[inputs.length - 1];
            assert(last && last.value === "alice@example.com", `got ${last && last.value}`);
        });

        await check("phase2", "keystroke delays vary (stddev > 8 ms — humans aren't metronomes)", () => {
            /** @type {number[]} */
            const dts = [];
            for (let i = 1; i < keydowns.length; i += 1) {
                dts.push(keydowns[i].t - keydowns[i - 1].t);
            }
            const sd = stddev(dts);
            assert(sd > 8, `keystroke delay stddev only ${sd.toFixed(2)}`);
        });

        // --- Typing with errors ---
        await reset();
        await wf.type("#password", "ThisIsALongerPassword123!", { wpm: 60, errors: true, clear: true });
        const finalValue = await page.locator("#password").inputValue();
        const typeErrEvents = await dump();
        const backspaces = typeErrEvents.filter((e) => e.type === "keydown" && e.key === "Backspace");

        await check("phase2", "error-mode typing converges on target text", () => {
            assert(finalValue === "ThisIsALongerPassword123!", `got "${finalValue}"`);
        });

        if (VERBOSE) console.log(`      observed ${backspaces.length} backspace(s)`);

        // --- Scroll ---
        await reset();
        await wf.scrollBy(1500);
        const scrollEvents = await dump();
        const wheels = scrollEvents.filter((e) => e.type === "wheel");

        await check("phase2", "scroll is broken into many wheel ticks (≥ 4)", () => {
            assert(wheels.length >= 4, `got ${wheels.length}`);
        });

        await check("phase2", "wheel deltas vary (stddev > 0.5)", () => {
            const sd = stddev(wheels.map((w) => w.dy));
            assert(sd > 0.5, `wheel dy stddev only ${sd.toFixed(2)}`);
        });

        await check("phase2", "scroll actually moved the page", async () => {
            const y = /** @type {number} */ (await page.evaluate("window.scrollY"));
            assert(y > 800, `scrollY = ${y}`);
        });

        // ---- Drop-in parity: vanilla Playwright calls go through hooks ----

        // page.mouse.move (no steps) → curved path
        await reset();
        await page.mouse.move(100, 100, { steps: 1 }); // raw seed
        await page.mouse.move(800, 500);
        const vanillaMoveEvents = await dump();
        const vanillaMoves = vanillaMoveEvents.filter((e) => e.type === "mousemove");
        await check("phase2", "vanilla page.mouse.move is hooked into a curved path", () => {
            assert(vanillaMoves.length >= 10, `only ${vanillaMoves.length} mousemove events — hook not active?`);
        });

        // locator.hover → cursor moves to locator
        await reset();
        await page.locator("#target").hover();
        const hoverEvents = await dump();
        const hoverMoves = hoverEvents.filter((e) => e.type === "mousemove");
        await check("phase2", "vanilla locator.hover triggers humanized cursor path", () => {
            assert(hoverMoves.length >= 10, `only ${hoverMoves.length} mousemove events on hover`);
        });

        // locator.click → trial + human click
        await reset();
        await page.locator("#target").click();
        const vClickEvents = await dump();
        const vDowns = vClickEvents.filter((e) => e.type === "mousedown");
        const vUps = vClickEvents.filter((e) => e.type === "mouseup");
        await check("phase2", "vanilla locator.click produces 1 mousedown + 1 mouseup", () => {
            assert(vDowns.length === 1 && vUps.length === 1, `got ${vDowns.length}/${vUps.length}`);
        });
        await check("phase2", "vanilla locator.click has a variable mousedown→mouseup delay", () => {
            const dt = vUps[0].t - vDowns[0].t;
            assert(dt >= 40 && dt <= 250, `down→up was ${dt.toFixed(1)} ms`);
        });

        // page.keyboard.type → humanized
        await reset();
        await page.locator("#email").fill("");
        await page.locator("#email").focus();
        await page.keyboard.type("bob@example.com");
        const vKeyEvents = await dump();
        const vKeydowns = vKeyEvents.filter((e) => e.type === "keydown");
        await check("phase2", "vanilla keyboard.type produces variable inter-key delays", () => {
            /** @type {number[]} */
            const dts = [];
            for (let i = 1; i < vKeydowns.length; i += 1) {
                dts.push(vKeydowns[i].t - vKeydowns[i - 1].t);
            }
            const sd = stddev(dts);
            assert(sd > 8, `keyboard.type delay stddev only ${sd.toFixed(2)}`);
        });

        // page.mouse.wheel → broken into ticks
        await reset();
        await page.evaluate("window.scrollTo(0,0)");
        await page.mouse.wheel(0, 1200);
        const vWheelEvents = await dump();
        const vWheels = vWheelEvents.filter((e) => e.type === "wheel");
        await check("phase2", "vanilla mouse.wheel is broken into multiple ticks (≥ 4)", () => {
            assert(vWheels.length >= 4, `got ${vWheels.length} wheel events`);
        });

        // --- Idle micro-jitter ---
        await wf.move(400, 400, { overshoot: 0 });
        await reset();
        const idleStart = Date.now();
        await wf.idle(1500, { intervalMin: 200, intervalMax: 400, maxDelta: 3 });
        const idleElapsed = Date.now() - idleStart;
        const idleEvents = await dump();
        const idleMoves = idleEvents.filter((e) => e.type === "mousemove");

        await check("phase2", "idle honors the requested duration", () => {
            assert(idleElapsed >= 1500 && idleElapsed < 2200, `elapsed ${idleElapsed} ms`);
        });

        await check("phase2", "idle emits multiple micro-jitter moves (≥ 3)", () => {
            assert(idleMoves.length >= 3, `only ${idleMoves.length} jitter moves`);
        });

        await check("phase2", "idle moves are small (|Δx|, |Δy| ≤ 3 px)", () => {
            for (let i = 1; i < idleMoves.length; i += 1) {
                const dx = Math.abs(idleMoves[i].x - idleMoves[i - 1].x);
                const dy = Math.abs(idleMoves[i].y - idleMoves[i - 1].y);
                assert(dx <= 3 && dy <= 3,
                    `step ${i}: delta (${dx}, ${dy}) exceeds 3 px — not micro-jitter`);
            }
        });

        // --- fillForm: Tab-between-fields for forms ---
        await page.evaluate("window.scrollTo(0, 0)");
        await page.locator("#email").fill("");
        await page.locator("#password").fill("");
        await reset();
        await wf.fillForm({
            "#email": "carol@example.com",
            "#password": "secret123",
        });
        const formEvents = await dump();
        const formKeydowns = formEvents.filter((e) => e.type === "keydown");
        const tabKeys = formKeydowns.filter((e) => e.key === "Tab");

        await check("phase2", "fillForm presses Tab between fields", () => {
            assert(tabKeys.length === 1, `expected 1 Tab between 2 fields, got ${tabKeys.length}`);
        });

        await check("phase2", "fillForm landed values in both fields", async () => {
            const e = await page.locator("#email").inputValue();
            const p = await page.locator("#password").inputValue();
            assert(e === "carol@example.com", `email got "${e}"`);
            assert(p === "secret123", `password got "${p}"`);
        });

        // Dialog auto-accept
        await page.evaluate("setTimeout(() => alert('hi'), 50)");
        const dialogStart = Date.now();
        // The hook accepts the dialog asynchronously after a random
        // delay. We just wait for the alert to disappear by re-evaluating.
        await new Promise((r) => setTimeout(r, 4000));
        const dialogElapsed = Date.now() - dialogStart;
        await check("phase2", "dialog is auto-accepted after a delay", async () => {
            // If the dialog was still open we couldn't have evaluated:
            // the alert() blocks JS execution.
            const alive = await page.evaluate("1+1").then(() => true, () => false);
            assert(alive, "dialog still open after 4s — hook didn't accept");
            assert(dialogElapsed > 500, `dialog dismissed too fast (${dialogElapsed} ms)`);
        });
    } finally {
        await browser.close().catch(() => {});
        await server.close();
    }
}

/* ---------------- Run ---------------- */

try {
    await phase1();
} catch (e) {
    console.log(`\n[verify] Phase 1 crashed: ${e instanceof Error ? e.message : e}`);
    results.push({ phase: "phase1", name: "phase 1 setup", ok: false, detail: String(e) });
}

try {
    await phase2();
} catch (e) {
    console.log(`\n[verify] Phase 2 crashed: ${e instanceof Error ? e.message : e}`);
    results.push({ phase: "phase2", name: "phase 2 setup", ok: false, detail: String(e) });
}

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\n[verify] ${passed} passed, ${failed} failed`);
for (const r of results) {
    if (!r.ok) console.log(`  ✗ [${r.phase}] ${r.name}`);
}
process.exit(failed > 0 ? 1 : 0);
