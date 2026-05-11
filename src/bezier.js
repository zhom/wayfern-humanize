// @ts-check

import { defaultRng, normal, rand } from "./random.js";

/**
 * @typedef {{ x: number, y: number }} Point
 * @typedef {{ x: number, y: number, t: number }} TimedPoint A point with cumulative time offset in ms.
 * @typedef {import("./random.js").Rng} Rng
 */

/**
 * @param {Point} a
 * @param {Point} b
 */
export function distance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Sample a single point on a cubic Bézier curve at parameter t ∈ [0, 1].
 *
 * @param {Point} p0
 * @param {Point} p1
 * @param {Point} p2
 * @param {Point} p3
 * @param {number} t
 * @returns {Point}
 */
function cubicBezier(p0, p1, p2, p3, t) {
    const u = 1 - t;
    const tt = t * t;
    const uu = u * u;
    const uuu = uu * u;
    const ttt = tt * t;
    return {
        x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
        y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
    };
}

/**
 * Produce two control points perpendicular-offset from the straight line
 * between `from` and `to`, biased toward natural arm motion.
 *
 * @param {Point} from
 * @param {Point} to
 * @param {Rng} rng
 * @returns {[Point, Point]}
 */
function controlPoints(from, to, rng) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
    // Perpendicular unit vector.
    const px = -dy / len;
    const py = dx / len;
    // Curve magnitude scales sub-linearly with distance so very long
    // moves don't loop wildly across the screen.
    const baseMag = Math.min(len * 0.25, 200) + 20;
    // Random sign keeps curves from always bowing the same way.
    const side = rng() < 0.5 ? -1 : 1;
    const m1 = side * Math.abs(normal(rng, baseMag, baseMag * 0.4));
    const m2 = side * Math.abs(normal(rng, baseMag, baseMag * 0.4));
    // Place control points at ~1/3 and ~2/3 of the line, then offset.
    return [
        {
            x: from.x + dx * (1 / 3 + rand(rng, -0.1, 0.1)) + px * m1,
            y: from.y + dy * (1 / 3 + rand(rng, -0.1, 0.1)) + py * m1,
        },
        {
            x: from.x + dx * (2 / 3 + rand(rng, -0.1, 0.1)) + px * m2,
            y: from.y + dy * (2 / 3 + rand(rng, -0.1, 0.1)) + py * m2,
        },
    ];
}

/**
 * Ease-in-out — slow start, fast middle, slow finish. Used to map
 * uniform parameter t to non-uniform sample density along the curve.
 *
 * @param {number} t
 * @returns {number}
 */
function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * @typedef {Object} PathOptions
 * @prop {number} [minSteps] Floor on the number of intermediate samples (default 25).
 * @prop {number} [maxSteps] Ceiling on the number of intermediate samples (default 120).
 * @prop {number} [duration] Total path duration in ms; auto-computed from distance when omitted.
 * @prop {number} [overshoot] Probability of overshooting and correcting (default 0.2). Pass 0 to disable.
 * @prop {Rng} [rng]
 */

/**
 * Build a list of timed points that traces a smooth, slightly curved
 * path from `from` to `to`, including occasional overshoot+correction.
 *
 * @param {Point} from
 * @param {Point} to
 * @param {PathOptions} [options]
 * @returns {TimedPoint[]}
 */
export function buildPath(from, to, options = {}) {
    const rng = options.rng ?? defaultRng;
    const dist = distance(from, to);
    if (dist < 1) return [];

    const steps = Math.min(
        options.maxSteps ?? 120,
        Math.max(options.minSteps ?? 25, Math.round(dist / 6)),
    );
    // Fitts-law-ish duration: log-scaled with distance, plus jitter.
    const duration = options.duration
        ?? Math.max(80, Math.min(1400, Math.round(180 + 90 * Math.log2(dist + 4) + normal(rng, 0, 50))));

    const overshootProb = options.overshoot ?? 0.2;
    const willOvershoot = dist > 80 && rng() < overshootProb;

    /** @type {Point} */
    let actualTarget = to;
    if (willOvershoot) {
        const overshootDist = rand(rng, 8, 25);
        const angle = Math.atan2(to.y - from.y, to.x - from.x);
        actualTarget = {
            x: to.x + Math.cos(angle) * overshootDist,
            y: to.y + Math.sin(angle) * overshootDist,
        };
    }

    const [c1, c2] = controlPoints(from, actualTarget, rng);
    /** @type {TimedPoint[]} */
    const path = [];
    for (let i = 1; i <= steps; i += 1) {
        const u = i / steps;
        const t = easeInOut(u);
        const p = cubicBezier(from, c1, c2, actualTarget, t);
        path.push({ x: Math.round(p.x), y: Math.round(p.y), t: u * duration });
    }

    if (willOvershoot) {
        // Short corrective hop back to the real target.
        const correctSteps = 8;
        const correctDuration = rand(rng, 60, 140);
        const start = path[path.length - 1];
        const baseTime = start.t;
        const [cc1, cc2] = controlPoints(actualTarget, to, rng);
        for (let i = 1; i <= correctSteps; i += 1) {
            const u = i / correctSteps;
            const t = easeInOut(u);
            const p = cubicBezier(actualTarget, cc1, cc2, to, t);
            path.push({
                x: Math.round(p.x),
                y: Math.round(p.y),
                t: baseTime + u * correctDuration,
            });
        }
    }

    return dedupe(path);
}

/**
 * Drop consecutive duplicate (x, y) points so we don't dispatch
 * redundant mousemove events.
 *
 * @param {TimedPoint[]} path
 * @returns {TimedPoint[]}
 */
function dedupe(path) {
    /** @type {TimedPoint[]} */
    const out = [];
    let last;
    for (const p of path) {
        if (!last || last.x !== p.x || last.y !== p.y) {
            out.push(p);
            last = p;
        }
    }
    return out;
}
