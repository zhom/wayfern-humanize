// @ts-check

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildTypingEvents } from "../src/typer.js";

/**
 * Replay the event stream and confirm the resulting text matches.
 *
 * @param {ReturnType<typeof buildTypingEvents>} events
 */
function replay(events) {
    /** @type {string[]} */
    const buf = [];
    for (const e of events) {
        if (e.action === "backspace") buf.pop();
        else if (e.char !== undefined) buf.push(e.char);
    }
    return buf.join("");
}

test("typer produces events that converge on the target text", () => {
    const text = "hello world";
    const events = buildTypingEvents(text, { wpm: 60 });
    assert.ok(events.length >= text.length);
    assert.equal(replay(events), text);
});

test("typer time monotonically increases", () => {
    const events = buildTypingEvents("the quick brown fox", { wpm: 60 });
    for (let i = 1; i < events.length; i += 1) {
        assert.ok(events[i].time >= events[i - 1].time);
    }
});

test("typer handles empty text", () => {
    assert.deepEqual(buildTypingEvents(""), []);
});

test("typer handles non-keyboard scripts", () => {
    for (const text of ["你好世界", "Привет мир", "東京タワー", "Hello 你好 world"]) {
        const events = buildTypingEvents(text, { wpm: 60 });
        assert.equal(replay(events), text);
    }
});

test("typer with errors disabled produces exact-length output", () => {
    const text = "hello world";
    const events = buildTypingEvents(text, { wpm: 60, errors: false });
    assert.equal(events.length, text.length);
    assert.equal(replay(events), text);
    for (const e of events) assert.equal(e.action, "char");
});
