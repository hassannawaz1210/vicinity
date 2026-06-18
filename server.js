import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 9966;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

// Matching strategy — switch with MATCH_MODE=distance|geohash (default distance).
// Both are kept so we can A/B them before committing to one.
const MODE = (process.env.MATCH_MODE || "distance").toLowerCase() === "geohash" ? "geohash" : "distance";

const RANGE_MIN = 10;        // metres — tightest "vicinity" (distance mode)
const RANGE_MAX = 20015000;  // metres — half Earth's circumference = whole planet
const DEFAULT_RANGE = 150;
const GEOHASH_PRECISION = 7; // ~150m cell (geohash mode)
const SWITCH_COOLDOWN_MS = 5000;

// --- distance (great-circle) ----------------------------------------------
export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const clampRange = (r) =>
  Number.isFinite(r) ? Math.min(RANGE_MAX, Math.max(RANGE_MIN, r)) : DEFAULT_RANGE;

// --- geohash (cell bucketing) ---------------------------------------------
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
export function geohashEncode(lat, lon, precision = GEOHASH_PRECISION) {
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  let hash = "", bit = 0, ch = 0, even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) { ch = (ch << 1) | 1; lonMin = mid; } else { ch = ch << 1; lonMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { ch = (ch << 1) | 1; latMin = mid; } else { ch = ch << 1; latMax = mid; }
    }
    even = !even;
    if (++bit === 5) { hash += BASE32[ch]; bit = 0; ch = 0; }
  }
  return hash;
}
const NEIGHBOR = {
  n: ["p0r21436x8zb9dcf5h7kjnmqesgutwvy", "bc01fg45238967deuvhjyznpkmstqrwx"],
  s: ["14365h7k9dcfesgujnmqp0r2twvyx8zb", "238967debc01fg45kmstqrwxuvhjyznp"],
  e: ["bc01fg45238967deuvhjyznpkmstqrwx", "p0r21436x8zb9dcf5h7kjnmqesgutwvy"],
  w: ["238967debc01fg45kmstqrwxuvhjyznp", "14365h7k9dcfesgujnmqp0r2twvyx8zb"],
};
const BORDER = {
  n: ["prxz", "bcfguvyz"], s: ["028b", "0145hjnp"], e: ["bcfguvyz", "prxz"], w: ["0145hjnp", "028b"],
};
function adjacent(hash, dir) {
  const last = hash.charAt(hash.length - 1), type = hash.length % 2;
  let parent = hash.slice(0, -1);
  if (BORDER[dir][type].indexOf(last) !== -1 && parent !== "") parent = adjacent(parent, dir);
  return parent + BASE32.charAt(NEIGHBOR[dir][type].indexOf(last));
}
export function neighborhood(hash) {
  if (!hash) return new Set();
  const n = adjacent(hash, "n"), s = adjacent(hash, "s"), e = adjacent(hash, "e"), w = adjacent(hash, "w");
  return new Set([hash, n, s, e, w, adjacent(n, "e"), adjacent(n, "w"), adjacent(s, "e"), adjacent(s, "w")]);
}

// --- static file serving --------------------------------------------------
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(404).end("Not found");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found"); return; }
    const type = CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type }).end(data);
  });
}
const server = http.createServer(serveStatic);

// --- shared state ---------------------------------------------------------
// id -> { ws, lat, lon, range, name, peers:Set, geohash, lastSwitch }
const clients = new Map();
const nameOf = (id) => (clients.get(id) || {}).name || "anon";
const cleanName = (raw) => String(raw || "").trim().slice(0, 24) || "anon";
function send(ws, obj) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }
function sendTo(id, obj) { const c = clients.get(id); if (c) send(c.ws, obj); }
const isValidCoord = (lat, lon) =>
  Number.isFinite(lat) && Number.isFinite(lon) &&
  lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;

// --- strategy: distance ---------------------------------------------------
// Pair iff distance <= min(rangeA, rangeB). Symmetric; recomputing the moved
// client captures every pair involving it. Emits peer-joined/left diffs.
// Hysteresis: pair when within the range, but keep an existing pair until it
// drifts 20% past it. Without this, GPS jitter at the boundary flaps peers
// connect/disconnect on every location update.
const HYSTERESIS = 1.2;
function eligible(a, b, alreadyPaired) {
  if (a.lat == null || b.lat == null) return false;
  const limit = Math.min(a.range, b.range) * (alreadyPaired ? HYSTERESIS : 1);
  return haversine(a.lat, a.lon, b.lat, b.lon) <= limit;
}
function recompute(id) {
  const a = clients.get(id);
  if (!a) return;
  const want = new Set();
  if (a.lat != null) for (const [bid, b] of clients) if (bid !== id && eligible(a, b, a.peers.has(bid))) want.add(bid);
  for (const bid of want) if (!a.peers.has(bid)) {
    a.peers.add(bid); clients.get(bid).peers.add(id);
    sendTo(id, { type: "peer-joined", id: bid, name: nameOf(bid) });
    sendTo(bid, { type: "peer-joined", id, name: nameOf(id) });
  }
  for (const bid of [...a.peers]) if (!want.has(bid)) {
    a.peers.delete(bid); const b = clients.get(bid); if (b) b.peers.delete(id);
    sendTo(id, { type: "peer-left", id: bid });
    sendTo(bid, { type: "peer-left", id });
  }
}
function distanceLeave(id) {
  const a = clients.get(id);
  if (a) for (const bid of a.peers) {
    const b = clients.get(bid);
    if (b) { b.peers.delete(id); sendTo(bid, { type: "peer-left", id }); }
  }
}

// --- strategy: geohash ----------------------------------------------------
// Room = your cell + its 8 neighbors. Range is ignored in this mode.
function roomMembers(geohash) {
  const near = neighborhood(geohash);
  const ids = [];
  for (const [id, c] of clients) if (c.geohash && near.has(c.geohash)) ids.push(id);
  return ids;
}
function geohashLeave(id) {
  const c = clients.get(id);
  if (!c || !c.geohash) return;
  const old = c.geohash;
  c.geohash = null;
  for (const otherId of roomMembers(old)) if (otherId !== id) sendTo(otherId, { type: "peer-left", id });
}
function geohashEnter(id, geohash) {
  const c = clients.get(id);
  if (!c) return;
  const peerIds = roomMembers(geohash).filter((x) => x !== id);
  c.geohash = geohash;
  send(c.ws, { type: "peers", peers: peerIds.map((pid) => ({ id: pid, name: nameOf(pid) })) });
  for (const otherId of peerIds) sendTo(otherId, { type: "peer-joined", id, name: nameOf(id) });
}
function geohashLoc(id, lat, lon) {
  const c = clients.get(id);
  if (!c) return;
  const gh = geohashEncode(lat, lon, GEOHASH_PRECISION);
  if (gh === c.geohash) return;
  const now = Date.now();
  if (c.geohash && now - (c.lastSwitch || 0) < SWITCH_COOLDOWN_MS) return; // debounce jitter
  geohashLeave(id);
  geohashEnter(id, gh);
  c.lastSwitch = now;
}

// --- dispatch -------------------------------------------------------------
function onLoc(id, lat, lon) {
  const c = clients.get(id);
  if (!c) return;
  c.lat = lat; c.lon = lon;
  if (MODE === "geohash") geohashLoc(id, lat, lon); else recompute(id);
}
function onRange(id, r) {
  const c = clients.get(id);
  if (!c) return;
  c.range = clampRange(r);
  if (MODE === "distance") recompute(id);
}
function onLeave(id) {
  if (MODE === "geohash") geohashLeave(id); else distanceLeave(id);
}

// --- websocket layer ------------------------------------------------------
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  const id = crypto.randomUUID();
  clients.set(id, { ws, lat: null, lon: null, range: DEFAULT_RANGE, name: "anon", peers: new Set(), geohash: null, lastSwitch: 0 });
  send(ws, { type: "welcome", id });
  console.log(`conn ${id.slice(0, 6)} (total ${clients.size})`);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const c = clients.get(id);
    if (!c) return;

    // Guard: a throw here used to kill the socket silently. Log and survive.
    try {
      switch (msg.type) {
        case "join":
          c.name = cleanName(msg.name);
          if (msg.range != null) c.range = clampRange(Number(msg.range));
          console.log(`join ${id.slice(0, 6)} name=${c.name} range=${c.range}`);
          break;
        case "loc":
          if (isValidCoord(msg.lat, msg.lon)) {
            onLoc(id, msg.lat, msg.lon);
            console.log(`loc  ${id.slice(0, 6)} peers=${c.peers.size}`);
          }
          break;
        case "range":
          onRange(id, Number(msg.range));
          console.log(`range ${id.slice(0, 6)} -> ${c.range} peers=${c.peers.size}`);
          break;
        case "signal":
          if (typeof msg.to === "string") sendTo(msg.to, { type: "signal", from: id, data: msg.data });
          break;
        default:
          break;
      }
    } catch (err) {
      console.error(`ERR handling ${msg.type} from ${id.slice(0, 6)}:`, err);
    }
  });

  ws.on("close", (code, reason) => {
    onLeave(id); clients.delete(id);
    console.log(`close ${id.slice(0, 6)} code=${code} reason=${reason || ""} (total ${clients.size})`);
  });
  ws.on("error", (err) => {
    onLeave(id); clients.delete(id);
    console.log(`error ${id.slice(0, 6)}: ${err && err.message}`);
  });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`Vicinity server on :${PORT} (match mode: ${MODE})`));
}
