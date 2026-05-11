// @ts-check

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildPath, distance } from "../src/bezier.js";

test("buildPath returns empty for sub-pixel moves", () => {
    assert.deepEqual(buildPath({ x: 5, y: 5 }, { x: 5, y: 5 }), []);
});

test("buildPath produces monotonic time", () => {
    const path = buildPath({ x: 0, y: 0 }, { x: 600, y: 400 }, { overshoot: 0 });
    assert.ok(path.length > 10);
    for (let i = 1; i < path.length; i += 1) {
        assert.ok(path[i].t >= path[i - 1].t);
    }
});

test("buildPath ends near the target without overshoot", () => {
    const target = { x: 800, y: 600 };
    const path = buildPath({ x: 0, y: 0 }, target, { overshoot: 0 });
    const last = path[path.length - 1];
    assert.ok(distance(last, target) < 5, `expected end near ${target.x},${target.y} got ${last.x},${last.y}`);
});

test("buildPath samples are deduped", () => {
    const path = buildPath({ x: 0, y: 0 }, { x: 5, y: 5 }, { overshoot: 0 });
    for (let i = 1; i < path.length; i += 1) {
        assert.ok(path[i].x !== path[i - 1].x || path[i].y !== path[i - 1].y);
    }
});
