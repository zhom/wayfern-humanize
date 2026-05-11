// @ts-check

/**
 * Transparent hooks that make vanilla Playwright calls (`page.click`,
 * `locator.hover`, `page.mouse.move`, `page.keyboard.type`, …) go
 * through the humanizer — so existing code is humanized without
 * rewrites.
 */

import { randInt } from "./random.js";

/**
 * @typedef {import("playwright").Page} Page
 * @typedef {import("playwright").Locator} Locator
 * @typedef {import("./wayfern.js").Wayfern} Wayfern
 */

// Private symbols — not registered in the global Symbol registry so two
// copies of this package in the same process don't accidentally share state.
const INSTALLED = Symbol("wayfern:installed");
const PATCHED_LOCATOR_PROTO = Symbol("wayfern:locator-patched");

/** Reverse lookup from a page to its Wayfern wrapper — needed by the prototype-level Locator hooks. */
const PAGE_WAYFERN = /** @type {WeakMap<Page, Wayfern>} */ (new WeakMap());

/**
 * @typedef {Object} HookOptions
 * @prop {boolean | { min?: number, max?: number }} [dialog] Auto-accept dialogs after a random delay. Default `{ min: 800, max: 3000 }`. Pass `false` to disable.
 * @prop {boolean} [mouse] Hook `page.mouse.{move,click,dblclick,wheel}`. Default true.
 * @prop {boolean} [keyboard] Hook `page.keyboard.type` to use the humanized typer. Default true.
 * @prop {boolean} [locator] Hook `Locator.{click,dblclick,hover,check,uncheck,setChecked}`. Default true.
 */

/**
 * Install hooks on `page`. Safe to call once per page; subsequent
 * calls are no-ops. The Locator prototype is patched once per process
 * (a WeakMap gates the dispatch so non-attached pages are unaffected).
 *
 * @param {Page} page
 * @param {Wayfern} wf
 * @param {HookOptions} [options]
 */
export function installHooks(page, wf, options = {}) {
    // @ts-ignore
    if (page[INSTALLED]) return;
    // @ts-ignore
    page[INSTALLED] = true;
    PAGE_WAYFERN.set(page, wf);

    if (options.mouse !== false) patchMouse(page, wf);
    if (options.keyboard !== false) patchKeyboard(page, wf);
    if (options.locator !== false) patchLocatorProto(page);
    if (options.dialog !== false) attachDialog(page, wf, options.dialog);

    // Clean up the page→wayfern mapping when the page closes so we don't
    // hold references to dead pages indefinitely.
    page.once("close", () => PAGE_WAYFERN.delete(page));
}

/**
 * @param {Page} page
 * @param {Wayfern} wf
 */
function patchMouse(page, wf) {
    const mouse = page.mouse;
    const origMove = mouse.move.bind(mouse);
    const origClick = mouse.click.bind(mouse);
    const origDblclick = mouse.dblclick.bind(mouse);
    const origWheel = mouse.wheel.bind(mouse);

    // Expose originals so the humanizer can drive raw mouse without
    // recursing back through the hook.
    wf._raw = wf._raw ?? {};
    wf._raw.mouseDown = mouse.down.bind(mouse);
    wf._raw.mouseUp = mouse.up.bind(mouse);
    wf._raw.mouseMove = origMove;
    wf._raw.mouseWheel = origWheel;

    mouse.move = async function (x, y, options) {
        // `steps` is the documented escape hatch — when the caller
        // explicitly asks for stepped interpolation, defer to vanilla.
        if (options?.steps !== undefined) return origMove(x, y, options);
        await wf.cursor.moveTo(x, y);
    };
    mouse.click = async function (x, y, options) {
        if (/** @type {any} */ (options)?.steps !== undefined) return origClick(x, y, options);
        await wf.cursor.clickAt(x, y, options);
    };
    mouse.dblclick = async function (x, y, options) {
        if (/** @type {any} */ (options)?.steps !== undefined) return origDblclick(x, y, options);
        await wf.cursor.clickAt(x, y, { ...options, clickCount: 2 });
    };
    mouse.wheel = async function (deltaX, deltaY) {
        await wf.scroll(deltaX, deltaY);
    };
}

/**
 * @param {Page} page
 * @param {Wayfern} wf
 */
function patchKeyboard(page, wf) {
    const kb = page.keyboard;
    const origType = kb.type.bind(kb);
    const origPress = kb.press.bind(kb);

    wf._raw = wf._raw ?? {};
    wf._raw.keyboardType = origType;
    wf._raw.keyboardPress = origPress;

    kb.type = async function (text, options) {
        // Single-character calls come from the humanizer itself — pass
        // through to avoid recursion. Same for explicit `delay` overrides.
        if (typeof text !== "string" || text.length <= 1 || options?.delay !== undefined) {
            return origType(text, options);
        }
        await wf.typeText(text);
    };
}

/**
 * @param {Page} page
 */
function patchLocatorProto(page) {
    const sample = page.locator("html");
    const proto = /** @type {any} */ (Object.getPrototypeOf(sample));
    if (proto[PATCHED_LOCATOR_PROTO]) return;
    proto[PATCHED_LOCATOR_PROTO] = true;

    const orig = {
        click: proto.click,
        dblclick: proto.dblclick,
        hover: proto.hover,
        check: proto.check,
        uncheck: proto.uncheck,
        setChecked: proto.setChecked,
        type: proto.type,
        tap: proto.tap,
        press: proto.press,
        pressSequentially: proto.pressSequentially,
    };

    proto.click = async function (options) {
        const wf = PAGE_WAYFERN.get(this.page());
        if (!wf || options?.trial || options?.force) return orig.click.call(this, options);
        // Trial first so we keep Playwright's actionability checks
        // (visibility, intersection, scroll-into-view).
        await orig.click.call(this, { ...options, trial: true });
        await wf.cursor.clickLocator(this, options);
    };

    proto.dblclick = async function (options) {
        const wf = PAGE_WAYFERN.get(this.page());
        if (!wf || options?.trial || options?.force) return orig.dblclick.call(this, options);
        await orig.dblclick.call(this, { ...options, trial: true });
        await wf.cursor.clickLocator(this, { ...options, clickCount: 2 });
    };

    proto.hover = async function (options) {
        const wf = PAGE_WAYFERN.get(this.page());
        if (!wf || options?.trial || options?.force) return orig.hover.call(this, options);
        await orig.hover.call(this, { ...options, trial: true });
        await wf.cursor.moveToLocator(this, { position: options?.position });
    };

    proto.check = async function (options) {
        const wf = PAGE_WAYFERN.get(this.page());
        if (!wf || options?.trial || options?.force) return orig.check.call(this, options);
        await orig.check.call(this, { ...options, trial: true });
        if (await this.isChecked().catch(() => true)) return;
        await wf.cursor.clickLocator(this, options);
    };

    proto.uncheck = async function (options) {
        const wf = PAGE_WAYFERN.get(this.page());
        if (!wf || options?.trial || options?.force) return orig.uncheck.call(this, options);
        await orig.uncheck.call(this, { ...options, trial: true });
        if (!(await this.isChecked().catch(() => false))) return;
        await wf.cursor.clickLocator(this, options);
    };

    proto.setChecked = async function (checked, options) {
        const wf = PAGE_WAYFERN.get(this.page());
        if (!wf || options?.trial || options?.force) {
            return orig.setChecked.call(this, checked, options);
        }
        await orig.setChecked.call(this, checked, { ...options, trial: true });
        const current = await this.isChecked().catch(() => null);
        if (current === checked) return;
        await wf.cursor.clickLocator(this, options);
    };

    proto.type = async function (text, options) {
        const wf = PAGE_WAYFERN.get(this.page());
        if (!wf || typeof text !== "string" || text.length === 0 || options?.delay !== undefined) {
            return orig.type.call(this, text, options);
        }
        await this.focus();
        await wf.typeText(text);
    };

    // `pressSequentially` is the canonical replacement for `.type` since
    // Playwright 1.39 — hook it the same way.
    if (orig.pressSequentially) {
        proto.pressSequentially = async function (text, options) {
            const wf = PAGE_WAYFERN.get(this.page());
            if (!wf || typeof text !== "string" || text.length === 0 || options?.delay !== undefined) {
                return orig.pressSequentially.call(this, text, options);
            }
            await this.focus();
            await wf.typeText(text);
        };
    }

    proto.tap = async function (options) {
        const wf = PAGE_WAYFERN.get(this.page());
        if (!wf || options?.trial || options?.force) return orig.tap.call(this, options);
        await orig.tap.call(this, { ...options, trial: true });
        // Tap is touch — move the cursor first so it feels like a finger
        // landing on a known spot, then trigger the actual tap.
        await wf.cursor.moveToLocator(this, { position: options?.position });
        return orig.tap.call(this, options);
    };

    // `Locator.press(key, opts)` is a single keystroke — only add a
    // pre-press reaction delay when the caller didn't pass an explicit
    // delay (otherwise honor their intent).
    proto.press = async function (key, options) {
        const wf = PAGE_WAYFERN.get(this.page());
        if (!wf || options?.delay !== undefined) {
            return orig.press.call(this, key, options);
        }
        return orig.press.call(this, key, { ...options, delay: randInt(wf.rng, 40, 140) });
    };
}

/**
 * @param {Page} page
 * @param {Wayfern} wf
 * @param {true | { min?: number, max?: number } | undefined} cfg
 */
function attachDialog(page, wf, cfg) {
    const min = (typeof cfg === "object" && cfg?.min) ?? 800;
    const max = (typeof cfg === "object" && cfg?.max) ?? 3000;
    page.on("dialog", async (dialog) => {
        await new Promise((r) => setTimeout(r, randInt(wf.rng, min, max)));
        await dialog.accept().catch(() => {});
    });
}
