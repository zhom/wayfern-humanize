// @ts-check

import { HumanCursor } from "./cursor.js";
import { installHooks } from "./hooks.js";
import { defaultRng, randInt } from "./random.js";
import { humanScroll, scrollIntoView } from "./scroll.js";
import { buildTypingEvents } from "./typer.js";
import { WayfernCdp } from "./cdp.js";

/**
 * @typedef {import("playwright").Page} Page
 * @typedef {import("playwright").Locator} Locator
 * @typedef {import("./bezier.js").Point} Point
 * @typedef {import("./random.js").Rng} Rng
 * @typedef {import("./typer.js").TyperOptions} TyperOptions
 * @typedef {import("./cursor.js").MoveOptions} MoveOptions
 * @typedef {import("./cursor.js").ClickOptions} ClickOptions
 * @typedef {import("./scroll.js").ScrollOptions} ScrollOptions
 * @typedef {import("./cdp.js").RefreshFingerprintOptions} RefreshFingerprintOptions
 * @typedef {import("./cdp.js").Fingerprint} Fingerprint
 */

/**
 * @typedef {Object} WayfernOptions
 * @prop {Rng} [rng] Custom RNG for deterministic tests.
 * @prop {Point} [cursorStart] Initial virtual cursor position.
 * @prop {false | import("./hooks.js").HookOptions} [hooks] Transparent hook configuration. Pass `false` to disable hooking and use explicit `wf.*` methods only. Default: install all hooks.
 */

/**
 * @typedef {Object} TypeOptions
 * @prop {number} [wpm]
 * @prop {import("./keyboard.js").LayoutName} [layout]
 * @prop {boolean} [errors]
 * @prop {Rng} [rng]
 * @prop {boolean} [clear] Clear the field before typing (default false).
 * @prop {boolean} [focus] Focus the locator before typing (default true). Set to false if focus is already established.
 */

/**
 * @param {Page} page
 * @param {string | Locator} target
 * @returns {Locator}
 */
function asLocator(page, target) {
    if (typeof target === "string") return page.locator(target);
    return target;
}

/**
 * Top-level wrapper bound to a single Playwright Page. Owns one virtual
 * cursor (so subsequent moves chain naturally) and one CDP session for
 * the Wayfern.* fingerprint commands.
 */
export class Wayfern {
    /**
     * @param {Page} page
     * @param {WayfernOptions} [options]
     */
    constructor(page, options = {}) {
        this.page = page;
        this.rng = options.rng ?? defaultRng;
        this.cursor = new HumanCursor(page, { rng: this.rng, start: options.cursorStart });
        /** Generic CDP escape hatch — use this for any non-fingerprint command. */
        this.cdp = new WayfernCdp(page);
        /** @type {{ mouseDown?: (opts?: any) => Promise<void>, mouseUp?: (opts?: any) => Promise<void>, mouseMove?: (x: number, y: number, opts?: any) => Promise<void>, mouseWheel?: (dx: number, dy: number) => Promise<void>, keyboardType?: (text: string, opts?: any) => Promise<void>, keyboardPress?: (key: string, opts?: any) => Promise<void> }} */
        this._raw = {};
        if (options.hooks !== false) {
            installHooks(page, this, options.hooks ?? {});
        }
    }

    /**
     * Move the cursor to absolute viewport coordinates along a curved
     * path with optional overshoot.
     *
     * @param {number} x
     * @param {number} y
     * @param {MoveOptions} [options]
     */
    async move(x, y, options) {
        await this.cursor.moveTo(x, y, options);
    }

    /**
     * Move the cursor onto a target (selector or Locator) and stop at
     * a randomized point inside it.
     *
     * @param {string | Locator} target
     * @param {MoveOptions & { position?: Point }} [options]
     */
    async hover(target, options) {
        await this.cursor.moveToLocator(asLocator(this.page, target), options);
    }

    /**
     * Click the target. When given a string selector the locator is
     * resolved on the current page. Otherwise behaves like a humanized
     * `Locator.click()`: move → mousedown → variable delay → mouseup.
     *
     * @param {string | Locator} target
     * @param {ClickOptions} [options]
     */
    async click(target, options) {
        await this.cursor.clickLocator(asLocator(this.page, target), options);
    }

    /**
     * @param {string | Locator} target
     * @param {ClickOptions} [options]
     */
    async dblclick(target, options) {
        await this.cursor.clickLocator(asLocator(this.page, target), {
            ...options,
            clickCount: 2,
        });
    }

    /**
     * Click at an absolute viewport coordinate.
     *
     * @param {number} x
     * @param {number} y
     * @param {ClickOptions} [options]
     */
    async clickAt(x, y, options) {
        await this.cursor.clickAt(x, y, options);
    }

    /**
     * Type `text` into the target with realistic timing, mistypes, and
     * self-corrections. By default the locator is focused first; pass
     * `focus: false` if the caller already focused (e.g. just clicked).
     *
     * @param {string | Locator} target
     * @param {string} text
     * @param {TypeOptions} [options]
     */
    async type(target, text, options = {}) {
        const locator = asLocator(this.page, target);
        if (options.focus !== false) {
            await locator.focus();
        }
        if (options.clear) {
            await locator.fill("");
        }
        await this.typeText(text, options);
    }

    /**
     * Type into the currently-focused element without resolving a
     * locator. Useful when the focus is in a contenteditable, iframe,
     * or after a custom interaction sequence.
     *
     * @param {string} text
     * @param {TyperOptions} [options]
     */
    async typeText(text, options = {}) {
        const events = buildTypingEvents(text, { ...options, rng: options.rng ?? this.rng });
        // When hooks are installed, page.keyboard.type is patched to call
        // back into us — use the captured originals to avoid recursion.
        const press = this._raw.keyboardPress ?? this.page.keyboard.press.bind(this.page.keyboard);
        const type = this._raw.keyboardType ?? this.page.keyboard.type.bind(this.page.keyboard);
        let prev = 0;
        for (const ev of events) {
            const dt = (ev.time - prev) * 1000;
            if (dt > 0) await sleep(dt);
            prev = ev.time;
            if (ev.action === "backspace") {
                await press("Backspace");
            } else if (ev.char !== undefined) {
                await type(ev.char);
            }
        }
    }

    /**
     * Scroll the page by `(deltaX, deltaY)`, broken up into many small
     * wheel events with non-uniform timing.
     *
     * @param {number} deltaX
     * @param {number} deltaY
     * @param {ScrollOptions} [options]
     */
    async scroll(deltaX, deltaY, options) {
        await humanScroll(this.page, deltaX, deltaY, {
            ...options,
            rng: options?.rng ?? this.rng,
            _wheel: this._raw.mouseWheel,
        });
    }

    /**
     * Vertical scroll-by helper.
     *
     * @param {number} deltaY
     * @param {ScrollOptions} [options]
     */
    async scrollBy(deltaY, options) {
        await humanScroll(this.page, 0, deltaY, {
            ...options,
            rng: options?.rng ?? this.rng,
            _wheel: this._raw.mouseWheel,
        });
    }

    /**
     * Scroll until `target` is in view, mimicking a user reading
     * toward it rather than a single jump.
     *
     * @param {string | Locator} target
     * @param {ScrollOptions & { timeout?: number, gap?: number }} [options]
     */
    async scrollTo(target, options) {
        await scrollIntoView(this.page, asLocator(this.page, target), {
            ...options,
            rng: options?.rng ?? this.rng,
            _wheel: this._raw.mouseWheel,
        });
    }

    /**
     * Idle delay drawn from a uniform [min, max] range — useful for
     * "thinking" pauses between actions.
     *
     * @param {number} min ms
     * @param {number} max ms
     */
    async pause(min, max) {
        await sleep(randInt(this.rng, min, max));
    }

    /**
     * Sleep for `durationMs` while the virtual cursor drifts by tiny
     * 1–3 px steps at random intervals — a perfectly still mouse between
     * actions is a tell on behavioral detection.
     *
     * @param {number} durationMs
     * @param {import("./cursor.js").DriftOptions} [options]
     */
    async idle(durationMs, options) {
        await this.cursor.drift(durationMs, { rng: this.rng, ...options });
    }

    /**
     * Fill a sequence of form fields, tabbing between them instead of
     * clicking each one — what a human filling out a login or signup
     * form actually does. The first field is clicked into; subsequent
     * fields are reached via `Tab` and inherit the resulting focus.
     *
     * Caller is responsible for the form having a tab order matching
     * the iteration order of `values`.
     *
     * @param {Record<string, string> | Array<[string, string]>} values  Map of selector → text. Object insertion order is the tab order.
     * @param {import("./typer.js").TyperOptions & { clear?: boolean }} [options]
     */
    async fillForm(values, options = {}) {
        const entries = Array.isArray(values) ? values : Object.entries(values);
        if (entries.length === 0) return;
        const rng = options.rng ?? this.rng;
        const press = this._raw.keyboardPress
            ?? this.page.keyboard.press.bind(this.page.keyboard);

        const [firstSel, firstVal] = entries[0];
        await this.click(firstSel);
        if (options.clear) {
            const selectAll = isMac() ? "Meta+A" : "Control+A";
            await press(selectAll);
            await press("Delete");
        }
        await this.typeText(firstVal, options);

        for (let i = 1; i < entries.length; i += 1) {
            const [, val] = entries[i];
            await sleep(randInt(rng, 120, 320));
            await press("Tab");
            await sleep(randInt(rng, 80, 200));
            if (options.clear) {
                const selectAll = isMac() ? "Meta+A" : "Control+A";
                await press(selectAll);
                await press("Delete");
            }
            await this.typeText(val, options);
        }
    }

    /**
     * Wayfern CDP `refreshFingerprint`. See `RefreshFingerprintOptions`
     * for the params; all are optional. The PDL definition lives at
     * `wayfern/patches/extra/fingerprint/new-content-browser-devtools-wayfern.pdl.patch`.
     *
     * @param {RefreshFingerprintOptions} [params]
     * @returns {Promise<unknown>}
     */
    async refreshFingerprint(params) {
        return this.cdp.refreshFingerprint(params);
    }

    /**
     * Wayfern CDP `getFingerprint`. The wire response is wrapped as
     * `{ fingerprint: {...} }`; this returns the inner object.
     *
     * @returns {Promise<Fingerprint>}
     */
    async getFingerprint() {
        return this.cdp.getFingerprint();
    }
}

/**
 * Convenience factory. Equivalent to `new Wayfern(page, options)`.
 *
 * @param {Page} page
 * @param {WayfernOptions} [options]
 * @returns {Wayfern}
 */
export function wayfern(page, options) {
    return new Wayfern(page, options);
}

/** @param {number} ms */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detect macOS so we can pick Cmd vs Ctrl for select-all. Wrapped in a
 * function so TypeScript doesn't have to resolve `process` as a global.
 *
 * @returns {boolean}
 */
function isMac() {
    return typeof globalThis !== "undefined"
        && /** @type {any} */ (globalThis).process?.platform === "darwin";
}
