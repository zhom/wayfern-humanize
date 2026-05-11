// @ts-check

import { buildPath } from "./bezier.js";
import { defaultRng, rand, randInt } from "./random.js";

/**
 * @typedef {import("playwright").Page} Page
 * @typedef {import("playwright").Locator} Locator
 * @typedef {import("./bezier.js").Point} Point
 * @typedef {import("./random.js").Rng} Rng
 */

/**
 * @typedef {Object} MoveOptions
 * @prop {number} [duration] Override the auto-computed move duration in ms.
 * @prop {number} [overshoot] Probability of overshooting (0–1). Default 0.2.
 * @prop {Rng} [rng]
 */

/**
 * @typedef {Object} ClickOptions
 * @prop {"left"|"right"|"middle"} [button] Default "left".
 * @prop {number} [clickCount] Default 1.
 * @prop {number} [delay] Down→up delay in ms; randomized if omitted.
 * @prop {Point} [position] Click point relative to the locator's bounding box; randomized if omitted.
 * @prop {Rng} [rng]
 * @prop {false | { minDistance?: number, min?: number, max?: number }} [hoverPause] Insert a "hover" pause between landing on the target and pressing mousedown, when the cursor traveled more than `minDistance` (default 150 px). Default `{ minDistance: 150, min: 120, max: 350 }`. Pass `false` to disable.
 */

/**
 * @typedef {Object} DriftOptions
 * @prop {number} [intervalMin] Min ms between drift moves. Default 800.
 * @prop {number} [intervalMax] Max ms between drift moves. Default 2500.
 * @prop {number} [maxDelta] Max |Δx|, |Δy| per drift step in pixels. Default 3.
 * @prop {Rng} [rng]
 */

/**
 * Tracks the virtual cursor position between moves so paths start where
 * the previous move ended (Playwright's mouse has no public position).
 */
export class HumanCursor {
    /**
     * @param {Page} page
     * @param {{ rng?: Rng, start?: Point }} [options]
     */
    constructor(page, options = {}) {
        this.page = page;
        this.rng = options.rng ?? defaultRng;
        const vp = page.viewportSize();
        this.position = options.start ?? {
            x: randInt(this.rng, 0, vp?.width ?? 800),
            y: randInt(this.rng, 0, vp?.height ?? 600),
        };
    }

    /**
     * Move the cursor along a curved path to `(x, y)`.
     *
     * @param {number} x
     * @param {number} y
     * @param {MoveOptions} [options]
     */
    async moveTo(x, y, options = {}) {
        const target = { x: Math.round(x), y: Math.round(y) };
        if (this.position.x === target.x && this.position.y === target.y) return;
        const path = buildPath(this.position, target, { ...options, rng: options.rng ?? this.rng });
        let prevTime = 0;
        for (const step of path) {
            const dt = step.t - prevTime;
            if (dt > 0) await sleep(dt);
            prevTime = step.t;
            await this.page.mouse.move(step.x, step.y, { steps: 1 });
        }
        // Ensure we land on the exact target.
        await this.page.mouse.move(target.x, target.y, { steps: 1 });
        this.position = target;
    }

    /**
     * Move into a Locator, stopping at a randomized point inside its
     * bounding box (biased toward the centre).
     *
     * @param {Locator} locator
     * @param {MoveOptions & { position?: Point }} [options]
     * @returns {Promise<Point>} The point inside the box that was reached.
     */
    async moveToLocator(locator, options = {}) {
        // Matches Playwright's own click/hover behavior: scroll the
        // target into the viewport before reading its box, otherwise
        // the box can be off-screen and the click misses. The try/catch
        // covers both a missing method (test stubs) and async rejection
        // (e.g. element detached mid-scroll).
        try { await locator.scrollIntoViewIfNeeded(); } catch { /* tolerated */ }
        const box = await locator.boundingBox();
        if (!box) throw new Error("Locator has no bounding box");
        const inner = options.position ?? randomPointInBox(box.width, box.height, this.rng);
        const target = { x: box.x + inner.x, y: box.y + inner.y };
        await this.moveTo(target.x, target.y, options);
        return inner;
    }

    /**
     * Move to a Locator and click it. Mouse-down/up delay is randomized
     * unless `delay` is given.
     *
     * @param {Locator} locator
     * @param {ClickOptions} [options]
     */
    async clickLocator(locator, options = {}) {
        const start = { x: this.position.x, y: this.position.y };
        await this.moveToLocator(locator, { rng: options.rng });
        await this._hoverPause(start, options);
        await this._press(options);
    }

    /**
     * Click at an absolute viewport coordinate after moving there.
     *
     * @param {number} x
     * @param {number} y
     * @param {ClickOptions} [options]
     */
    async clickAt(x, y, options = {}) {
        const start = { x: this.position.x, y: this.position.y };
        await this.moveTo(x, y, { rng: options.rng });
        await this._hoverPause(start, options);
        await this._press(options);
    }

    /**
     * Idle drift — small ±maxDelta-pixel jitters at random intervals over
     * `durationMs`. Humans never hold a mouse perfectly still, so this
     * fills the gaps between deliberate actions with realistic noise.
     *
     * @param {number} durationMs
     * @param {DriftOptions} [options]
     */
    async drift(durationMs, options = {}) {
        const rng = options.rng ?? this.rng;
        const intervalMin = options.intervalMin ?? 800;
        const intervalMax = options.intervalMax ?? 2500;
        const maxDelta = options.maxDelta ?? 3;
        const end = Date.now() + durationMs;
        // Loop until the wall-clock deadline expires. Each iteration:
        // sleep a random interval, then dispatch one tiny mousemove.
        while (true) {
            const remaining = end - Date.now();
            if (remaining <= 0) break;
            const wait = Math.min(remaining, randInt(rng, intervalMin, intervalMax));
            await sleep(wait);
            if (Date.now() >= end) break;
            let dx = 0;
            let dy = 0;
            // Reroll until we have a non-zero delta — a 0,0 step would
            // be a no-op (Playwright dedupes consecutive identical points).
            while (dx === 0 && dy === 0) {
                dx = randInt(rng, -maxDelta, maxDelta);
                dy = randInt(rng, -maxDelta, maxDelta);
            }
            const nx = Math.max(0, this.position.x + dx);
            const ny = Math.max(0, this.position.y + dy);
            await this.page.mouse.move(nx, ny, { steps: 1 });
            this.position = { x: nx, y: ny };
        }
    }

    /**
     * Insert a "hover" pause when the cursor traveled meaningful distance
     * to the target — mimics a user visually confirming the target
     * before pressing. Skipped on short moves (quick repeated clicks).
     *
     * @param {Point} start
     * @param {ClickOptions} options
     */
    async _hoverPause(start, options) {
        if (options.hoverPause === false) return;
        const cfg = options.hoverPause && typeof options.hoverPause === "object"
            ? options.hoverPause
            : {};
        const minDistance = cfg.minDistance ?? 150;
        const min = cfg.min ?? 120;
        const max = cfg.max ?? 350;
        const dist = Math.hypot(this.position.x - start.x, this.position.y - start.y);
        if (dist < minDistance) return;
        await sleep(randInt(options.rng ?? this.rng, min, max));
    }

    /**
     * Mousedown → variable delay → mouseup, repeated for clickCount.
     *
     * @param {ClickOptions} options
     */
    async _press(options) {
        const button = options.button ?? "left";
        const clickCount = options.clickCount ?? 1;
        for (let i = 0; i < clickCount; i += 1) {
            await this.page.mouse.down({ button });
            const downUpDelay = options.delay ?? randInt(options.rng ?? this.rng, 60, 160);
            await sleep(downUpDelay);
            await this.page.mouse.up({ button });
            if (i + 1 < clickCount) {
                await sleep(randInt(options.rng ?? this.rng, 70, 140));
            }
        }
    }
}

/**
 * Pick a point inside a `width × height` box biased toward the centre,
 * sampled in polar coords with `rho ∈ [0, 1)`.
 *
 * @param {number} width
 * @param {number} height
 * @param {Rng} rng
 * @returns {Point}
 */
function randomPointInBox(width, height, rng) {
    const phi = rand(rng, 0, 2 * Math.PI);
    const rho = rng();
    return {
        x: (rho * Math.cos(phi) * width) / 2 + width / 2,
        y: (rho * Math.sin(phi) * height) / 2 + height / 2,
    };
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
