// @ts-check

import { pick, randInt } from "./random.js";

/**
 * @typedef {"qwerty" | "azerty"} LayoutName
 * @typedef {import("./random.js").Rng} Rng
 */

/** @type {Record<LayoutName, string[]>} */
const LAYOUTS = {
    qwerty: [
        "`1234567890-=",
        "qwertyuiop[]\\",
        "asdfghjkl;'",
        "zxcvbnm,./",
    ],
    azerty: [
        "&é\"'(-è_çà)=",
        "azertyuiop^$",
        "qsdfghjklmù*",
        "wxcvbn,;:!",
    ],
};

/**
 * 2D keyboard model used to score key distance, pick neighbor keys for
 * realistic mistypes, and decide whether a character can be produced
 * directly without IME composition.
 */
export class KeyboardLayout {
    /**
     * @param {LayoutName} [name]
     */
    constructor(name = "qwerty") {
        this.name = name;
        this.grid = LAYOUTS[name].map((row) => row.split(""));
        /** @type {Map<string, [number, number]>} */
        this.posMap = new Map();
        for (let r = 0; r < this.grid.length; r += 1) {
            for (let c = 0; c < this.grid[r].length; c += 1) {
                this.posMap.set(this.grid[r][c], [r, c]);
            }
        }

        if (name === "azerty") {
            // The number row characters can also be reached via shift; map digits
            // to their unshifted positions so distance lookups still work.
            const azertyRow0 = "&é\"'(-è_çà)";
            const digits = "1234567890";
            for (let i = 0; i < digits.length; i += 1) {
                const base = azertyRow0[i];
                const pos = this.posMap.get(base);
                if (pos && !this.posMap.has(digits[i])) {
                    this.posMap.set(digits[i], pos);
                }
            }
            this.directAccents = new Set("éèàùç");
            this.composedAccents = new Set("âêîôûäëïöü");
        } else {
            this.directAccents = new Set();
            this.composedAccents = new Set("âêîôûäëïöüéèàùç");
        }
    }

    /**
     * @param {string} ch
     * @returns {string}
     */
    normalize(ch) {
        const lower = ch.toLowerCase();
        if (this.composedAccents.has(lower)) {
            return lower
                .normalize("NFD")
                .replace(/\p{M}/gu, "");
        }
        return lower;
    }

    /**
     * @param {string} ch
     * @returns {boolean}
     */
    hasKey(ch) {
        return this.posMap.has(this.normalize(ch));
    }

    /**
     * @param {string} ch
     * @returns {string[]}
     */
    neighbors(ch) {
        const norm = this.normalize(ch);
        const pos = this.posMap.get(norm);
        if (!pos) return [];
        const [r, c] = pos;
        /** @type {[number, number][]} */
        const deltas = [
            [-1, -1], [-1, 0], [-1, 1],
            [0, -1], [0, 1],
            [1, -1], [1, 0], [1, 1],
        ];
        /** @type {string[]} */
        const out = [];
        for (const [dr, dc] of deltas) {
            const nr = r + dr;
            const nc = c + dc;
            if (nr >= 0 && nr < this.grid.length) {
                const row = this.grid[nr];
                if (nc >= 0 && nc < row.length) out.push(row[nc]);
            }
        }
        return out;
    }

    /**
     * Euclidean distance between two keys on the grid. Returns a large
     * fallback when either key is unknown.
     *
     * @param {string} a
     * @param {string} b
     * @returns {number}
     */
    distance(a, b) {
        const pa = this.posMap.get(this.normalize(a));
        const pb = this.posMap.get(this.normalize(b));
        if (!pa || !pb) return 4.0;
        const dr = pa[0] - pb[0];
        const dc = pa[1] - pb[1];
        return Math.sqrt(dr * dr + dc * dc);
    }

    /**
     * Pick a plausible mistype for `ch`. Falls back to any grid key when
     * the source character has no neighbors (e.g. CJK).
     *
     * @param {Rng} rng
     * @param {string} ch
     * @returns {string}
     */
    randomNeighbor(rng, ch) {
        const wasUpper = ch !== ch.toLowerCase() && ch === ch.toUpperCase();
        const ns = this.neighbors(ch);
        let result;
        if (ns.length === 0) {
            const flat = this.grid.flat();
            result = flat[randInt(rng, 0, flat.length - 1)];
        } else {
            result = pick(rng, ns);
        }
        return wasUpper ? result.toUpperCase() : result;
    }

    /** @param {string} ch */
    isDirectAccent(ch) {
        return this.directAccents.has(ch.toLowerCase());
    }

    /** @param {string} ch */
    isComposedAccent(ch) {
        return this.composedAccents.has(ch.toLowerCase());
    }
}
