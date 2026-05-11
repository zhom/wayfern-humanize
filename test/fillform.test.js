// @ts-check

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { Wayfern } from "../src/wayfern.js";

/**
 * Build a minimal Page surface for testing fillForm:
 *   - `locatorSelectors` records every selector resolved via page.locator()
 *     (so we can see which fields were *targeted by the humanized cursor*,
 *     which is the proxy for "got clicked").
 *   - `events` records keyboard.type / press calls in order.
 */
function makePage() {
    /** @type {Array<{ kind: string, arg?: any }>} */
    const events = [];
    /** @type {string[]} */
    const locatorSelectors = [];

    const keyboard = {
        async type(text) { events.push({ kind: "type", arg: text }); },
        async press(key) { events.push({ kind: "press", arg: key }); },
    };
    const mouse = {
        async move() {}, async down() {}, async up() {},
        async click() {}, async dblclick() {}, async wheel() {},
    };

    /**
     * @param {string} selector
     */
    function locator(selector) {
        locatorSelectors.push(selector);
        return {
            page: () => page,
            async focus() {},
            async click() {},
            async boundingBox() { return { x: 100, y: 100, width: 80, height: 30 }; },
            async isChecked() { return false; },
        };
    }

    const page = {
        mouse, keyboard, locator,
        viewportSize() { return { width: 1280, height: 800 }; },
        /** @param {string} _e @param {Function} _f */
        on(_e, _f) {},
        /** @param {string} _e @param {Function} _f */
        once(_e, _f) {},
    };
    return { page: /** @type {any} */ (page), events, locatorSelectors };
}

/**
 * Build a Wayfern with `typeText` and `click` short-circuited so we can
 * test the structural flow of fillForm without paying for the typing
 * model or the Bézier cursor path.
 */
function makeFastWayfern(page, events) {
    const wfp = new Wayfern(page, { hooks: false });
    wfp.typeText = async (text) => { events.push({ kind: "type", arg: text }); };
    wfp.click = async (target) => {
        // Trigger the page.locator() resolution so locatorSelectors records it.
        if (typeof target === "string") page.locator(target);
    };
    return wfp;
}

test("fillForm clicks the first field then tabs between subsequent fields", async () => {
    const { page, events, locatorSelectors } = makePage();
    const wfp = makeFastWayfern(page, events);

    await wfp.fillForm({
        "#email": "alice@example.com",
        "#password": "hunter2",
        "#name": "Alice",
    });

    // Only the first selector is resolved via page.locator — subsequent
    // fields are reached via Tab without a click.
    assert.deepEqual(locatorSelectors, ["#email"]);

    // Two Tab presses between 3 fields.
    const tabPresses = events.filter((e) => e.kind === "press" && e.arg === "Tab");
    assert.equal(tabPresses.length, 2);

    // All three values typed in order.
    const typed = events.filter((e) => e.kind === "type").map((e) => e.arg);
    assert.deepEqual(typed, ["alice@example.com", "hunter2", "Alice"]);

    // Tab presses interleave between typings: type, press(Tab), type, press(Tab), type.
    const kinds = events
        .filter((e) => e.kind === "type" || (e.kind === "press" && e.arg === "Tab"))
        .map((e) => (e.kind === "type" ? "T" : "tab"));
    assert.deepEqual(kinds, ["T", "tab", "T", "tab", "T"]);
});

test("fillForm with clear option emits select-all + Delete before each field", async () => {
    const { page, events } = makePage();
    const wfp = makeFastWayfern(page, events);

    await wfp.fillForm({ "#a": "1", "#b": "2" }, { clear: true });

    const presses = events.filter((e) => e.kind === "press").map((e) => e.arg);
    const selectAll = process.platform === "darwin" ? "Meta+A" : "Control+A";
    assert.deepEqual(presses, [selectAll, "Delete", "Tab", selectAll, "Delete"]);
});

test("fillForm accepts an array of [selector, value] pairs", async () => {
    const { page, events, locatorSelectors } = makePage();
    const wfp = makeFastWayfern(page, events);

    await wfp.fillForm([["#x", "first"], ["#y", "second"]]);

    assert.deepEqual(locatorSelectors, ["#x"]);
    const typed = events.filter((e) => e.kind === "type").map((e) => e.arg);
    assert.deepEqual(typed, ["first", "second"]);
});

test("fillForm with empty input is a no-op", async () => {
    const { page, events, locatorSelectors } = makePage();
    const wfp = makeFastWayfern(page, events);
    await wfp.fillForm({});
    assert.deepEqual(locatorSelectors, []);
    assert.deepEqual(events, []);
});
