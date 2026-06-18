import assert from "node:assert/strict";
import { geohashEncode } from "./server.js";

// Known reference: 57.64911, 10.40744 -> "u4pruydqqvj" (Wikipedia geohash example)
const REF_LAT = 57.64911;
const REF_LON = 10.40744;

const p7 = geohashEncode(REF_LAT, REF_LON, 7);
assert.equal(p7, "u4pruyd", `precision-7 geohash mismatch: got "${p7}"`);

const p11 = geohashEncode(REF_LAT, REF_LON, 11);
assert.equal(p11, "u4pruydqqvj", `precision-11 geohash mismatch: got "${p11}"`);

// Sanity: distinct nearby points should generally differ at p7, and a point
// in another part of the world must differ.
assert.notEqual(geohashEncode(0, 0, 7), p7, "origin should differ from ref");

console.log("ok - geohashEncode produces correct known values");
