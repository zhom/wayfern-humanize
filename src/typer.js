// @ts-check

/**
 * Markov-style typing simulator that produces a stream of timed
 * keystrokes — including realistic mistypes and self-corrections.
 */

import { KeyboardLayout } from "./keyboard.js";
import { getWordDifficulty, isCommonBigram } from "./language.js";
import { defaultRng, normal } from "./random.js";

const PROB_ERROR = 0.04;
const PROB_SWAP_ERROR = 0.015;
const PROB_NOTICE_ERROR = 0.85;
const DRIFT_CORRECTION_PROB = 0.8;

const SPEED_BOOST_COMMON_WORD = 0.6;
const SPEED_PENALTY_COMPLEX_WORD = 1.3;
const SPEED_BOOST_CLOSE_KEYS = 0.5;
const SPEED_BOOST_BIGRAM = 0.4;
const FAR_KEY_THRESHOLD = 4.0;
const FAR_KEY_PENALTY = 1.2;
const CLOSE_KEY_THRESHOLD = 2.0;
const MIN_SPEED_MULTIPLIER = 0.15;

const COMPLEX_WORD_ERROR_MULT = 1.5;
const COMMON_WORD_ERROR_MULT = 0.5;
const COMPOSED_ACCENT_ERROR_MULT = 2.0;

const TIME_KEYSTROKE_STD = 0.03;
const TIME_BACKSPACE_MEAN = 0.12;
const TIME_BACKSPACE_STD = 0.02;
const TIME_REACTION_MEAN = 0.35;
const TIME_REACTION_STD = 0.1;
const TIME_DIRECT_ACCENT_PENALTY = 0.15;
const TIME_COMPOSED_ACCENT_PENALTY = 0.4;
const TIME_UPPERCASE_PENALTY = 0.2;
const TIME_SPACE_PAUSE_MEAN = 0.25;
const TIME_SPACE_PAUSE_STD = 0.05;

const MIN_KEYSTROKE_TIME = 0.02;
const MIN_REACTION_TIME = 0.1;
const MIN_BACKSPACE_TIME = 0.03;

const FATIGUE_FACTOR = 1.0005;
const FATIGUE_CAP = 1.5;
const AVG_WORD_LENGTH = 5.0;
const WPM_STD = 10.0;
const DEFAULT_WPM = 80.0;

const PUNCT_BOUNDARIES = ' \n\t.,;!?:()[]{}<>"\'';

/**
 * @typedef {"char" | "backspace"} TypingActionKind
 *
 * @typedef {Object} TypingEvent
 * @prop {number} time Cumulative time in seconds since the first keystroke.
 * @prop {TypingActionKind} action Whether to type a character or backspace.
 * @prop {string} [char] Set when `action === "char"` — the actual character to send.
 */

/**
 * @typedef {Object} TyperOptions
 * @prop {number} [wpm] Target words per minute (default 80).
 * @prop {import("./keyboard.js").LayoutName} [layout] Keyboard layout (default "qwerty").
 * @prop {import("./random.js").Rng} [rng] Optional seedable RNG.
 * @prop {boolean} [errors] Allow mistypes and self-corrections (default true).
 */

/**
 * Build a sequence of timed typing events that, when applied in order,
 * produce `text` — including any backspaces from corrected mistypes.
 *
 * @param {string} text
 * @param {TyperOptions} [options]
 * @returns {TypingEvent[]}
 */
export function buildTypingEvents(text, options = {}) {
    if (text.length === 0) return [];

    const rng = options.rng ?? defaultRng;
    const targetWpm = options.wpm ?? DEFAULT_WPM;
    const allowErrors = options.errors ?? true;
    const keyboard = new KeyboardLayout(options.layout ?? "qwerty");

    const sessionWpm = Math.max(10, normal(rng, targetWpm, WPM_STD));
    const baseKeystrokeTime = 60 / (sessionWpm * AVG_WORD_LENGTH);

    const target = Array.from(text);
    /** @type {string[]} */
    let current = [];
    let mentalPos = 0;
    /** @type {string | null} */
    let lastTyped = null;
    let fatigue = 1.0;
    let totalTime = 0;
    let lastWasBackspace = false;
    /** @type {TypingEvent[]} */
    const events = [];

    /** @returns {string | null} */
    const currentWord = () => {
        if (mentalPos >= target.length) return null;
        let start = mentalPos;
        while (start > 0 && target[start - 1] !== " ") start -= 1;
        let end = mentalPos;
        while (end < target.length && target[end] !== " ") end += 1;
        return target.slice(start, end).join("");
    };

    /**
     * @param {string} ch
     * @returns {number}
     */
    const keystrokeTime = (ch) => {
        let t = baseKeystrokeTime * fatigue;
        const word = currentWord();
        if (word) {
            const diff = getWordDifficulty(word);
            if (diff === "common") t *= SPEED_BOOST_COMMON_WORD;
            else if (diff === "complex") t *= SPEED_PENALTY_COMPLEX_WORD;
        }
        if (lastTyped) {
            if (isCommonBigram(lastTyped, ch)) {
                t *= SPEED_BOOST_BIGRAM;
            } else {
                const dist = keyboard.distance(lastTyped, ch);
                if (dist > 0 && dist < CLOSE_KEY_THRESHOLD) t *= SPEED_BOOST_CLOSE_KEYS;
                else if (dist > FAR_KEY_THRESHOLD) t *= FAR_KEY_PENALTY;
            }
        }
        if (ch === " ") {
            t += normal(rng, TIME_SPACE_PAUSE_MEAN, TIME_SPACE_PAUSE_STD);
        } else if (keyboard.isComposedAccent(ch)) {
            t += TIME_COMPOSED_ACCENT_PENALTY;
        } else if (keyboard.isDirectAccent(ch)) {
            t += TIME_DIRECT_ACCENT_PENALTY;
        } else if (ch !== ch.toLowerCase() && ch === ch.toUpperCase()) {
            t += TIME_UPPERCASE_PENALTY;
        }
        t = Math.max(MIN_SPEED_MULTIPLIER * baseKeystrokeTime, t);
        return Math.max(MIN_KEYSTROKE_TIME, normal(rng, t, TIME_KEYSTROKE_STD));
    };

    const maxSteps = target.length * 10;
    let steps = 0;

    while (current.length !== target.length || current.join("") !== target.join("")) {
        if (steps > maxSteps) break;
        steps += 1;

        // Find first divergence between what's been typed and the target.
        let firstError = target.length;
        const minLen = Math.min(current.length, target.length);
        for (let i = 0; i < minLen; i += 1) {
            if (current[i] !== target[i]) { firstError = i; break; }
        }
        if (current.length > target.length && firstError === target.length) {
            firstError = target.length;
        }

        // Decide whether to backspace existing errors before continuing.
        if (firstError < current.length) {
            let shouldCorrect = false;
            if (lastWasBackspace || mentalPos >= target.length) {
                shouldCorrect = true;
            } else if (current.length > 0) {
                const lastChar = current[current.length - 1];
                const distance = current.length - firstError;
                if (PUNCT_BOUNDARIES.includes(lastChar)) {
                    shouldCorrect = true;
                } else if (distance >= 2 && rng() < DRIFT_CORRECTION_PROB) {
                    shouldCorrect = true;
                } else if (distance === 1 && rng() < PROB_NOTICE_ERROR) {
                    shouldCorrect = true;
                }
            }

            if (shouldCorrect) {
                if (!lastWasBackspace) {
                    totalTime += Math.max(MIN_REACTION_TIME, normal(rng, TIME_REACTION_MEAN, TIME_REACTION_STD));
                }
                totalTime += Math.max(MIN_BACKSPACE_TIME, normal(rng, TIME_BACKSPACE_MEAN, TIME_BACKSPACE_STD));
                current.pop();
                mentalPos = current.length;
                lastWasBackspace = true;
                events.push({ time: totalTime, action: "backspace" });
                continue;
            }
        }

        lastWasBackspace = false;
        if (mentalPos > current.length) mentalPos = current.length;
        if (mentalPos >= target.length) break;

        const intended = target[mentalPos];
        fatigue = Math.min(FATIGUE_CAP, fatigue * FATIGUE_FACTOR);
        const onKeyboard = keyboard.hasKey(intended);

        // Adjacent-letter swap (anticipation): "the" → "hte" then resolves on next loop.
        if (allowErrors && onKeyboard && mentalPos + 1 < target.length) {
            const after = target[mentalPos + 1];
            if (after !== " " && after !== intended && keyboard.hasKey(after) && rng() < PROB_SWAP_ERROR) {
                const dt = keystrokeTime(after);
                totalTime += dt;
                current.push(after);
                lastTyped = after;
                mentalPos += 1;
                events.push({ time: totalTime, action: "char", char: after });
                continue;
            }
        }

        let typed;
        if (allowErrors && onKeyboard) {
            let pErr = PROB_ERROR;
            const word = currentWord();
            if (word) {
                const diff = getWordDifficulty(word);
                if (diff === "complex") pErr *= COMPLEX_WORD_ERROR_MULT;
                else if (diff === "common") pErr *= COMMON_WORD_ERROR_MULT;
            }
            if (keyboard.isComposedAccent(intended)) pErr *= COMPOSED_ACCENT_ERROR_MULT;
            typed = rng() < pErr ? keyboard.randomNeighbor(rng, intended) : intended;
        } else {
            typed = intended;
        }

        const dt = keystrokeTime(typed);
        totalTime += dt;
        current.push(typed);
        lastTyped = typed;
        mentalPos += 1;
        events.push({ time: totalTime, action: "char", char: typed });
    }

    return events;
}
