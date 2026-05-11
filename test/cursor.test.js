// @ts-check

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { HumanCursor } from "../src/cursor.js";

/**
 * Build a fake Page surface that records every mouse call with a
 * wall-clock timestamp. Lets tests assert on call counts, deltas, and
 * inter-call timing without launching a browser.
 */
function makePage() {
    /** @type {Array<{ kind: string, x?: number, y?: number, opts?: any, t: number }>} */
    const calls = [];
    const start = Date.now();
    const mouse = {
        async move(x, y, opts) { calls.push({ kind: "move", x, y, opts, t: Date.now() - start }); },
        async down(opts) { calls.push({ kind: "down", opts, t: Date.now() - start }); },
        async up(opts) { calls.push({ kind: "up", opts, t: Date.now() - start }); },
        async click() {}, async dblclick() {}, async wheel() {},
    };
    const page = {
        mouse,
        viewportSize() { return { width: 1280, height: 800 }; },
    };
    return { page: /** @type {any} */ (page), calls };
}

/**
 * @param {{ x: number, y: number, width: number, height: number }} box
 */
function makeLocator(box) {
    return { boundingBox: async () => box };
}

test("drift produces several small mousemove events over the duration", async () => {
    const { page, calls } = makePage();
    const cursor = new HumanCursor(page, { start: { x: 500, y: 500 } });
    const startTime = Date.now();
    await cursor.drift(1500, { intervalMin: 150, intervalMax: 350, maxDelta: 3 });
    const elapsed = Date.now() - startTime;
    const moves = calls.filter((c) => c.kind === "move");

    // Duration honored (allow some slack for the last sleep).
    assert.ok(elapsed >= 1500 && elapsed < 1900, `elapsed ${elapsed}`);
    // At least a handful of jitters fired.
    assert.ok(moves.length >= 4, `expected ≥ 4 drift moves, got ${moves.length}`);
    // Each step is a 1-step move with small delta.
    for (let i = 0; i < moves.length; i += 1) {
        const prev = i === 0 ? { x: 500, y: 500 } : moves[i - 1];
        const dx = Math.abs(/** @type {number} */ (moves[i].x) - /** @type {number} */ (prev.x));
        const dy = Math.abs(/** @type {number} */ (moves[i].y) - /** @type {number} */ (prev.y));
        assert.ok(dx <= 3 && dy <= 3, `step ${i}: delta (${dx},${dy}) exceeds maxDelta`);
        assert.equal(moves[i].opts?.steps, 1);
    }
});

test("drift never emits a zero-delta step", async () => {
    const { page, calls } = makePage();
    const cursor = new HumanCursor(page, { start: { x: 200, y: 200 } });
    await cursor.drift(800, { intervalMin: 80, intervalMax: 150, maxDelta: 2 });
    const moves = calls.filter((c) => c.kind === "move");
    for (let i = 1; i < moves.length; i += 1) {
        const same = moves[i].x === moves[i - 1].x && moves[i].y === moves[i - 1].y;
        assert.ok(!same, `consecutive moves at same position ${moves[i].x},${moves[i].y}`);
    }
});

test("drift updates cursor.position so the next deliberate move starts from the drifted spot", async () => {
    const { page } = makePage();
    const cursor = new HumanCursor(page, { start: { x: 200, y: 200 } });
    await cursor.drift(400, { intervalMin: 80, intervalMax: 150, maxDelta: 2 });
    // Position should have moved at least 1 pixel from the start.
    const moved = cursor.position.x !== 200 || cursor.position.y !== 200;
    assert.ok(moved, `position unchanged: ${cursor.position.x},${cursor.position.y}`);
});

test("clickLocator inserts hover pause when the cursor traveled > minDistance", async () => {
    const { page, calls } = makePage();
    const cursor = new HumanCursor(page, { start: { x: 0, y: 0 } });
    await cursor.clickLocator(/** @type {any} */ (makeLocator({ x: 700, y: 500, width: 80, height: 30 })));

    const moves = calls.filter((c) => c.kind === "move");
    const lastMove = moves[moves.length - 1];
    const downIdx = calls.findIndex((c) => c.kind === "down");
    const down = calls[downIdx];
    const gap = down.t - lastMove.t;
    // Pause range is 120–350 ms; allow generous floor to account for
    // event-loop scheduling.
    assert.ok(gap >= 110, `expected hover pause ≥ 120 ms, got ${gap}`);
    assert.ok(gap <= 500, `expected hover pause ≤ 350 ms, got ${gap}`);
});

test("clickLocator skips hover pause when the cursor barely moved", async () => {
    const { page, calls } = makePage();
    // Start close to the target so the actual travel is < 150 px.
    const cursor = new HumanCursor(page, { start: { x: 740, y: 515 } });
    await cursor.clickLocator(/** @type {any} */ (makeLocator({ x: 700, y: 500, width: 80, height: 30 })));

    const moves = calls.filter((c) => c.kind === "move");
    const lastMove = moves[moves.length - 1];
    const down = calls.find((c) => c.kind === "down");
    assert.ok(down, "no mousedown recorded");
    const gap = /** @type {any} */ (down).t - lastMove.t;
    // Without hover pause, only the down→up delay applies, but that's
    // *after* down. The gap between last move and down should be tiny.
    assert.ok(gap < 100, `expected no hover pause, got ${gap} ms gap`);
});

test("clickLocator hover pause is disabled when hoverPause: false", async () => {
    const { page, calls } = makePage();
    const cursor = new HumanCursor(page, { start: { x: 0, y: 0 } });
    await cursor.clickLocator(
        /** @type {any} */ (makeLocator({ x: 700, y: 500, width: 80, height: 30 })),
        { hoverPause: false },
    );
    const moves = calls.filter((c) => c.kind === "move");
    const lastMove = moves[moves.length - 1];
    const down = calls.find((c) => c.kind === "down");
    assert.ok(down, "no mousedown recorded");
    const gap = /** @type {any} */ (down).t - lastMove.t;
    assert.ok(gap < 100, `expected no hover pause when disabled, got ${gap} ms`);
});

test("clickAt also honors hover pause on long moves", async () => {
    const { page, calls } = makePage();
    const cursor = new HumanCursor(page, { start: { x: 0, y: 0 } });
    await cursor.clickAt(900, 600);
    const moves = calls.filter((c) => c.kind === "move");
    const lastMove = moves[moves.length - 1];
    const down = calls.find((c) => c.kind === "down");
    assert.ok(down, "no mousedown recorded");
    const gap = /** @type {any} */ (down).t - lastMove.t;
    assert.ok(gap >= 110, `expected hover pause on clickAt long move, got ${gap}`);
});
