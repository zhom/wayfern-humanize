// @ts-check

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { installHooks } from "../src/hooks.js";

/**
 * Build a fake Page/Mouse/Keyboard/Locator surface big enough to install
 * hooks against. Records calls into per-method arrays so tests can
 * assert on routing.
 *
 * @returns {ReturnType<typeof makePage>}
 */
function makePage() {
    /** @type {Record<string, any[]>} */
    const calls = {
        mouseMove: [], mouseDown: [], mouseUp: [], mouseClick: [], mouseDblclick: [], mouseWheel: [],
        kbType: [], kbPress: [],
        locClick: [], locHover: [], locTap: [], locType: [], locPressSequentially: [], locPress: [],
        dialogListeners: [],
    };

    /** @type {Record<string | symbol, any>} */
    const dummyLocatorProto = {
        click(opts) { calls.locClick.push(opts); return Promise.resolve(); },
        dblclick() { return Promise.resolve(); },
        hover(opts) { calls.locHover.push(opts); return Promise.resolve(); },
        check() { return Promise.resolve(); },
        uncheck() { return Promise.resolve(); },
        setChecked() { return Promise.resolve(); },
        type(text, opts) { calls.locType.push({ text, opts }); return Promise.resolve(); },
        pressSequentially(text, opts) { calls.locPressSequentially.push({ text, opts }); return Promise.resolve(); },
        tap(opts) { calls.locTap.push(opts); return Promise.resolve(); },
        press(key, opts) { calls.locPress.push({ key, opts }); return Promise.resolve(); },
        focus() { return Promise.resolve(); },
        isChecked() { return Promise.resolve(false); },
        boundingBox() { return Promise.resolve({ x: 100, y: 100, width: 80, height: 30 }); },
    };

    /**
     * @param {string} _selector
     */
    function makeLocator(_selector) {
        const loc = Object.create(dummyLocatorProto);
        loc.page = () => page;
        return loc;
    }

    const page = {
        mouse: {
            async move(x, y, opts) { calls.mouseMove.push({ x, y, opts }); },
            async down(opts) { calls.mouseDown.push(opts); },
            async up(opts) { calls.mouseUp.push(opts); },
            async click(x, y, opts) { calls.mouseClick.push({ x, y, opts }); },
            async dblclick(x, y, opts) { calls.mouseDblclick.push({ x, y, opts }); },
            async wheel(dx, dy) { calls.mouseWheel.push({ dx, dy }); },
        },
        keyboard: {
            async type(text, opts) { calls.kbType.push({ text, opts }); },
            async press(key, opts) { calls.kbPress.push({ key, opts }); },
        },
        viewportSize() { return { width: 1280, height: 800 }; },
        locator: makeLocator,
        /**
         * @param {string} event
         * @param {Function} listener
         */
        on(event, listener) {
            if (event === "dialog") calls.dialogListeners.push(listener);
        },
        /** @param {string} _event @param {Function} _listener */
        once(_event, _listener) {},
    };

    return { page: /** @type {any} */ (page), calls, sampleLocator: page.locator("html") };
}

test("installHooks marks the page as installed and is idempotent", () => {
    const { page } = makePage();
    const wf = makeWf(page);
    installHooks(page, wf);
    const movePatched = page.mouse.move;
    installHooks(page, wf); // second call should not re-patch
    assert.equal(page.mouse.move, movePatched);
});

test("page.mouse.wheel routes through wf.scroll (the humanized path)", async () => {
    const { page, calls } = makePage();
    /** @type {Array<[number, number]>} */
    const scrollCalls = [];
    const wf = makeWf(page, {
        scroll: async (dx, dy) => { scrollCalls.push([dx, dy]); },
    });
    installHooks(page, wf);
    await page.mouse.wheel(0, 500);
    assert.equal(scrollCalls.length, 1);
    assert.deepEqual(scrollCalls[0], [0, 500]);
    // raw mouse.wheel was preserved on wf._raw
    assert.equal(typeof wf._raw.mouseWheel, "function");
    // raw should not have been hit by the hooked call.
    assert.equal(calls.mouseWheel.length, 0);
});

test("page.keyboard.type with single char bypasses the humanizer (no recursion)", async () => {
    const { page, calls } = makePage();
    let typeCalls = 0;
    const wf = makeWf(page, { typeText: async () => { typeCalls += 1; } });
    installHooks(page, wf);
    await page.keyboard.type("x");
    assert.equal(typeCalls, 0, "should not call wf.typeText for a single char");
    assert.equal(calls.kbType.length, 1);
});

test("page.keyboard.type with multi-char text routes through wf.typeText", async () => {
    const { page } = makePage();
    let lastText = "";
    const wf = makeWf(page, { typeText: async (t) => { lastText = t; } });
    installHooks(page, wf);
    await page.keyboard.type("hello");
    assert.equal(lastText, "hello");
});

test("page.keyboard.type with explicit delay bypasses humanizer", async () => {
    const { page, calls } = makePage();
    let typeCalls = 0;
    const wf = makeWf(page, { typeText: async () => { typeCalls += 1; } });
    installHooks(page, wf);
    await page.keyboard.type("hello", { delay: 100 });
    assert.equal(typeCalls, 0);
    assert.equal(calls.kbType.length, 1);
});

test("page.mouse.move with explicit steps bypasses humanizer", async () => {
    const { page, calls } = makePage();
    let moveCalls = 0;
    const wf = makeWf(page, {
        cursor: { moveTo: async () => { moveCalls += 1; } },
    });
    installHooks(page, wf);
    await page.mouse.move(200, 200, { steps: 1 });
    assert.equal(moveCalls, 0, "explicit steps must bypass humanizer");
    assert.equal(calls.mouseMove.length, 1);
});

test("dialog listener is attached when not disabled", () => {
    const { page, calls } = makePage();
    const wf = makeWf(page);
    installHooks(page, wf);
    assert.equal(calls.dialogListeners.length, 1);
});

test("dialog listener is NOT attached when dialog: false", () => {
    const { page, calls } = makePage();
    const wf = makeWf(page);
    installHooks(page, wf, { dialog: false });
    assert.equal(calls.dialogListeners.length, 0);
});

test("Locator.click with trial: true bypasses humanizer", async () => {
    const { page, sampleLocator, calls } = makePage();
    let cursorClicks = 0;
    const wf = makeWf(page, {
        cursor: { clickLocator: async () => { cursorClicks += 1; } },
    });
    installHooks(page, wf);
    await sampleLocator.click({ trial: true });
    assert.equal(cursorClicks, 0);
    assert.equal(calls.locClick.length, 1);
});

test("Locator.click without trial routes through wf.cursor.clickLocator", async () => {
    const { page, sampleLocator, calls } = makePage();
    let cursorClicks = 0;
    const wf = makeWf(page, {
        cursor: { clickLocator: async () => { cursorClicks += 1; } },
    });
    installHooks(page, wf);
    await sampleLocator.click();
    assert.equal(cursorClicks, 1, "humanized click must run");
    // The trial call still goes through to validate actionability.
    assert.equal(calls.locClick.length, 1);
    assert.equal(calls.locClick[0].trial, true);
});

test("Locator.press injects a random delay when none is provided", async () => {
    const { page, sampleLocator, calls } = makePage();
    const wf = makeWf(page);
    installHooks(page, wf);
    await sampleLocator.press("Enter");
    assert.equal(calls.locPress.length, 1);
    const { opts } = calls.locPress[0];
    assert.ok(opts && typeof opts.delay === "number" && opts.delay >= 40 && opts.delay <= 140,
        `expected delay in [40, 140], got ${opts?.delay}`);
});

test("Locator.press preserves explicit delay", async () => {
    const { page, sampleLocator, calls } = makePage();
    const wf = makeWf(page);
    installHooks(page, wf);
    await sampleLocator.press("Enter", { delay: 999 });
    assert.equal(calls.locPress[0].opts.delay, 999);
});

test("Locator.pressSequentially is hooked when present on the prototype", async () => {
    const { page, sampleLocator, calls } = makePage();
    let typeCalls = 0;
    const wf = makeWf(page, { typeText: async () => { typeCalls += 1; } });
    installHooks(page, wf);
    await sampleLocator.pressSequentially("hi");
    assert.equal(typeCalls, 1);
    // The vanilla version should not have been called.
    assert.equal(calls.locPressSequentially.length, 0);
});

/**
 * Minimal Wayfern stub for tests — covers the surface installHooks
 * touches (cursor, scroll, typeText, rng).
 *
 * @param {any} page
 * @param {Object} [overrides]
 * @returns {any}
 */
function makeWf(page, overrides = {}) {
    return {
        page,
        rng: () => 0.5,
        _raw: {},
        cursor: {
            moveTo: async () => {},
            clickAt: async () => {},
            clickLocator: async () => {},
            moveToLocator: async () => {},
            ...(/** @type {any} */ (overrides).cursor),
        },
        scroll: /** @type {any} */ (overrides).scroll ?? (async () => {}),
        typeText: /** @type {any} */ (overrides).typeText ?? (async () => {}),
    };
}
