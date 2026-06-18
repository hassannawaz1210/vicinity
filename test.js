import assert from "node:assert/strict";
import { haversine, geohashEncode, neighborhood } from "./server.js";

// --- distance strategy ----------------------------------------------------
const d = haversine(33.6436, 72.9650, 33.7232, 73.0433);
assert.ok(Math.abs(d - 11400) < 300, `expected ~11.4km, got ${Math.round(d)}m`);
assert.equal(haversine(10, 20, 10, 20), 0);

const paired = (dist, rA, rB) => dist <= Math.min(rA, rB);
assert.ok(paired(120, 150, 200), "120m within both ranges should pair");
assert.ok(!paired(120, 150, 100), "120m exceeds the tighter 100m range — no pair");
assert.ok(!paired(5000, 150, 150), "5km apart at 150m range — no pair");

// --- geohash strategy -----------------------------------------------------
assert.equal(geohashEncode(57.64911, 10.40744, 7), "u4pruyd");
assert.equal(geohashEncode(57.64911, 10.40744, 11), "u4pruydqqvj");

const hood = neighborhood("u4pruyd");
assert.equal(hood.size, 9, `neighborhood should have 9 cells, got ${hood.size}`);
assert.ok(hood.has("u4pruyd"), "neighborhood must include the center cell");
for (const cell of hood) assert.ok(neighborhood(cell).has("u4pruyd"), `not symmetric for "${cell}"`);

console.log("ok - distance + geohash strategies");
