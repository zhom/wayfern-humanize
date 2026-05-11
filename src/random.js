// @ts-check

/**
 * Random number utilities. Uses Math.random by default; pass a seedable
 * RNG into the Humanizer constructor if reproducibility is needed.
 */

/**
 * @typedef {() => number} Rng A function returning a float in [0, 1).
 */

/** @type {Rng} */
export const defaultRng = () => Math.random();

/**
 * @param {Rng} rng
 * @param {number} lo inclusive lower bound
 * @param {number} hi exclusive upper bound
 * @returns {number}
 */
export function rand(rng, lo, hi) {
    return rng() * (hi - lo) + lo;
}

/**
 * @param {Rng} rng
 * @param {number} lo inclusive
 * @param {number} hi inclusive
 * @returns {number}
 */
export function randInt(rng, lo, hi) {
    return Math.floor(rng() * (hi - lo + 1)) + lo;
}

/**
 * Sample from a normal distribution via Box–Muller.
 *
 * @param {Rng} rng
 * @param {number} mean
 * @param {number} stdDev
 * @returns {number}
 */
export function normal(rng, mean, stdDev) {
    const u1 = Math.max(rng(), 1e-10);
    const u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + stdDev * z;
}

/**
 * @template T
 * @param {Rng} rng
 * @param {readonly T[]} arr
 * @returns {T}
 */
export function pick(rng, arr) {
    return arr[Math.floor(rng() * arr.length)];
}
