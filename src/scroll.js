// @ts-check

import { defaultRng, normal, rand, randInt } from "./random.js";

/**
 * @typedef {import("playwright").Page} Page
 * @typedef {import("./random.js").Rng} Rng
 */

/**
 * @typedef {Object} ScrollOptions
 * @prop {number} [steps] Wheel ticks to dispatch; defaults proportional to total delta.
 * @prop {number} [stepDelay] Mean ms between wheel ticks (default 35).
 * @prop {number} [stepDelayJitter] Stddev of step delay (default 12).
 * @prop {number} [jitterX] Stddev of horizontal noise per step in pixels (default 0).
 * @prop {boolean} [overshoot] Allow occasional small overshoot+correction (default true).
 * @prop {Rng} [rng]
 * @prop {(dx: number, dy: number) => Promise<void>} [_wheel] Raw wheel function (injected by Wayfern to bypass its own mouse hook).
 */

/**
 * Scroll by `(deltaX, deltaY)` total, broken up into many small wheel
 * ticks with non-uniform delays and easing — humans rarely emit a
 * single huge wheel event.
 *
 * @param {Page} page
 * @param {number} deltaX
 * @param {number} deltaY
 * @param {ScrollOptions} [options]
 */
export async function humanScroll(page, deltaX, deltaY, options = {}) {
    const rng = options.rng ?? defaultRng;
    const wheel = options._wheel ?? page.mouse.wheel.bind(page.mouse);
    const total = Math.max(Math.abs(deltaX), Math.abs(deltaY));
    if (total === 0) return;

    const steps = options.steps ?? Math.max(4, Math.min(40, Math.round(total / 60)));
    const stepDelayMean = options.stepDelay ?? 35;
    const stepDelayStd = options.stepDelayJitter ?? 12;
    const jitterX = options.jitterX ?? 0;

    const weights = easeInOutWeights(steps, rng);

    let dispatchedX = 0;
    let dispatchedY = 0;
    for (let i = 0; i < steps; i += 1) {
        const w = weights[i];
        const stepX = i === steps - 1 ? deltaX - dispatchedX : Math.round(deltaX * w);
        const stepY = i === steps - 1 ? deltaY - dispatchedY : Math.round(deltaY * w);
        const noiseX = jitterX > 0 ? Math.round(normal(rng, 0, jitterX)) : 0;
        await wheel(stepX + noiseX, stepY);
        dispatchedX += stepX;
        dispatchedY += stepY;
        const dt = Math.max(8, normal(rng, stepDelayMean, stepDelayStd));
        await sleep(dt);
    }

    if ((options.overshoot ?? true) && total > 400 && rng() < 0.25) {
        const overshootY = Math.sign(deltaY) * randInt(rng, 30, 80);
        const overshootX = Math.sign(deltaX) * randInt(rng, 0, 20);
        await wheel(overshootX, overshootY);
        await sleep(randInt(rng, 80, 220));
        await wheel(-overshootX, -overshootY);
    }
}

/**
 * Generate `n` positive weights that sum to ~1 with an ease-in-out
 * shape and small per-step jitter.
 *
 * @param {number} n
 * @param {Rng} rng
 * @returns {number[]}
 */
function easeInOutWeights(n, rng) {
    /** @type {number[]} */
    const raw = [];
    let total = 0;
    for (let i = 0; i < n; i += 1) {
        const x = (i + 0.5) / n;
        // Sine-eased, never zero, slightly jittered.
        const v = Math.max(0.05, Math.sin(x * Math.PI) * rand(rng, 0.85, 1.15));
        raw.push(v);
        total += v;
    }
    return raw.map((v) => v / total);
}

/**
 * Scroll until a Locator is in view, mimicking a user reading and
 * scrolling toward the element rather than jumping with `scrollIntoView`.
 *
 * @param {Page} page
 * @param {import("playwright").Locator} locator
 * @param {ScrollOptions & { timeout?: number, gap?: number }} [options]
 */
export async function scrollIntoView(page, locator, options = {}) {
    const rng = options.rng ?? defaultRng;
    const timeout = options.timeout ?? 8000;
    const gap = options.gap ?? 120;
    const start = Date.now();

    for (;;) {
        const box = await locator.boundingBox();
        const viewport = page.viewportSize();
        if (!box || !viewport) return;
        const aboveBy = -box.y + gap;
        const belowBy = box.y + box.height - viewport.height + gap;
        let delta = 0;
        if (aboveBy > 0) delta = -Math.min(aboveBy, viewport.height * 0.8);
        else if (belowBy > 0) delta = Math.min(belowBy, viewport.height * 0.8);
        else return;

        await humanScroll(page, 0, Math.round(delta + normal(rng, 0, 8)), options);
        await sleep(randInt(rng, 120, 300));
        if (Date.now() - start > timeout) return;
    }
}

/** @param {number} ms */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
