// @ts-check

/**
 * Browser-type wrappers that auto-attach the Wayfern humanizer to every
 * new page. Lets users do a one-line import swap from `playwright`:
 *
 *   - import { chromium } from "playwright";
 *   + import { chromium } from "wayfern-humanizer";
 *
 * The wrappers are thin: launch/launchPersistentContext/connect/
 * connectOverCDP forward to the underlying BrowserType, then wrap the
 * returned Browser/Context so every `newPage` call gets `wayfern(page)`.
 */

import pw from "playwright";
import { wayfern } from "./wayfern.js";

/**
 * @typedef {import("playwright").BrowserType} BrowserType
 * @typedef {import("playwright").Browser} Browser
 * @typedef {import("playwright").BrowserContext} BrowserContext
 * @typedef {import("playwright").Page} Page
 * @typedef {import("./wayfern.js").WayfernOptions} WayfernOptions
 */

const ATTACHED = Symbol("wayfern:auto-attached");

/**
 * Pull off the optional `wayfern` field without mutating the caller's
 * options object.
 *
 * @template {Record<string, any> | undefined} T
 * @param {T} opts
 * @returns {{ rest: T, wfOpts: WayfernOptions | undefined }}
 */
function splitWayfernOptions(opts) {
    if (!opts || typeof opts !== "object") {
        return { rest: opts, wfOpts: undefined };
    }
    const { wayfern: wfOpts, ...rest } = opts;
    return { rest: /** @type {T} */ (rest), wfOpts };
}

/**
 * Attach to a context: hook newPage and humanize already-open pages.
 *
 * @param {BrowserContext} context
 * @param {WayfernOptions} [options]
 */
function attachContext(context, options) {
    // @ts-ignore
    if (context[ATTACHED]) return;
    // @ts-ignore
    context[ATTACHED] = true;
    for (const page of context.pages()) wayfern(page, options);
    context.on("page", (page) => wayfern(page, options));
}

/**
 * Attach to a browser: hook newContext and newPage so every page is humanized.
 *
 * @param {Browser} browser
 * @param {WayfernOptions} [options]
 */
function attachBrowser(browser, options) {
    // @ts-ignore
    if (browser[ATTACHED]) return;
    // @ts-ignore
    browser[ATTACHED] = true;
    for (const ctx of browser.contexts()) attachContext(ctx, options);
    const origNewContext = browser.newContext.bind(browser);
    browser.newContext = async function (...args) {
        const ctx = await origNewContext(...args);
        attachContext(ctx, options);
        return ctx;
    };
    const origNewPage = browser.newPage.bind(browser);
    browser.newPage = async function (...args) {
        const page = await origNewPage(...args);
        wayfern(page, options);
        return page;
    };
}

/**
 * @param {BrowserType} bt
 * @returns {BrowserType}
 */
function wrap(bt) {
    /** @type {any} */
    const wrapped = Object.create(bt);

    wrapped.launch = async (/** @type {any} */ opts) => {
        const { rest, wfOpts } = splitWayfernOptions(opts);
        const browser = await bt.launch(rest);
        attachBrowser(browser, wfOpts);
        return browser;
    };

    wrapped.launchPersistentContext = async (
        /** @type {string} */ userDataDir,
        /** @type {any} */ opts,
    ) => {
        const { rest, wfOpts } = splitWayfernOptions(opts);
        const ctx = await bt.launchPersistentContext(userDataDir, rest);
        attachContext(ctx, wfOpts);
        return ctx;
    };

    wrapped.connect = async (
        /** @type {any} */ wsEndpoint,
        /** @type {any} */ opts,
    ) => {
        const { rest, wfOpts } = splitWayfernOptions(opts);
        const browser = await bt.connect(wsEndpoint, rest);
        attachBrowser(browser, wfOpts);
        return browser;
    };

    wrapped.connectOverCDP = async (
        /** @type {any} */ endpointURLOrOptions,
        /** @type {any} */ maybeOpts,
    ) => {
        const { rest, wfOpts } = splitWayfernOptions(
            typeof endpointURLOrOptions === "string" ? maybeOpts : endpointURLOrOptions,
        );
        const browser =
            typeof endpointURLOrOptions === "string"
                ? await bt.connectOverCDP(endpointURLOrOptions, rest)
                : await bt.connectOverCDP(rest);
        attachBrowser(browser, wfOpts);
        return browser;
    };

    return wrapped;
}

export const chromium = wrap(pw.chromium);
export const firefox = wrap(pw.firefox);
export const webkit = wrap(pw.webkit);
