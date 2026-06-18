import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 9966;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const GEOHASH_PRECISION = 7;
const SWITCH_COOLDOWN_MS = 5000; // see debounce note on handleLoc

// --- geohash encode (standard base32 algorithm) ----------------------------
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
export function geohashEncode(lat, lon, precision = GEOHASH_PRECISION) {
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  let hash = "";
  let bit = 0, ch = 0, even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) { ch = (ch << 1) | 1; lonMin = mid; }
      else { ch = ch << 1; lonMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { ch = (ch << 1) | 1; latMin = mid; }
      else { ch = ch << 1; latMax = mid; }
    }
    even = !even;
    if (++bit === 5) {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

// --- static file serving ----------------------------------------------------
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  // normalize + confine to PUBLIC_DIR (block path traversal)
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(404).end("Not found");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    const type = CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type }).end(data);
  });
}

const server = http.createServer(serveStatic);

// --- signaling state (in memory only) ---------------------------------------
// clients: id -> { ws, geohash, lat, lon, lastSwitch }
const clients = new Map();

function roomMembers(geohash) {
  const ids = [];
  for (const [id, c] of clients) if (c.geohash === geohash) ids.push(id);
  return ids;
}

function nameOf(id) {
  const c = clients.get(id);
  return (c && c.name) || "anon";
}

// Trim + cap a client-supplied display name. textContent on the client side
// handles escaping, so we only bound length here.
function cleanName(raw) {
  const s = String(raw || "").trim().slice(0, 24);
  return s || "anon";
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function sendTo(id, obj) {
  const c = clients.get(id);
  if (c) send(c.ws, obj);
}

function leaveRoom(id) {
  const c = clients.get(id);
  if (!c || !c.geohash) return;
  const old = c.geohash;
  c.geohash = null;
  for (const otherId of roomMembers(old)) {
    if (otherId !== id) sendTo(otherId, { type: "peer-left", id });
  }
}

function enterRoom(id, geohash) {
  const c = clients.get(id);
  if (!c) return;
  const peerIds = roomMembers(geohash).filter((x) => x !== id);
  c.geohash = geohash;
  send(c.ws, { type: "peers", peers: peerIds.map((pid) => ({ id: pid, name: nameOf(pid) })) });
  for (const otherId of peerIds) sendTo(otherId, { type: "peer-joined", id, name: nameOf(id) });
}

function isValidCoord(lat, lon) {
  return (
    Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
  );
}

function handleLoc(id, lat, lon) {
  const c = clients.get(id);
  if (!c || !isValidCoord(lat, lon)) return;
  c.lat = lat;
  c.lon = lon;
  const gh = geohashEncode(lat, lon, GEOHASH_PRECISION);
  if (gh === c.geohash) return; // same cell, nothing to do

  // ponytail: crude time-based debounce — ignore a cell switch if we switched
  // within the last few seconds, so GPS jitter on a cell boundary doesn't
  // thrash rooms. Upgrade path: require the new cell to be reported N times
  // (or stable for T ms) before committing, instead of a flat cooldown.
  const now = Date.now();
  if (c.geohash && now - (c.lastSwitch || 0) < SWITCH_COOLDOWN_MS) return;

  leaveRoom(id);
  enterRoom(id, gh);
  c.lastSwitch = now;
}

// --- websocket layer ---------------------------------------------------------
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const id = crypto.randomUUID();
  clients.set(id, { ws, geohash: null, lat: null, lon: null, lastSwitch: 0, name: "anon" });
  send(ws, { type: "welcome", id });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed
    }
    if (!msg || typeof msg !== "object") return;

    switch (msg.type) {
      case "join": {
        // carries the display name; room is assigned on first valid "loc"
        const c = clients.get(id);
        if (c) c.name = cleanName(msg.name);
        break;
      }
      case "loc":
        handleLoc(id, msg.lat, msg.lon);
        break;
      case "signal":
        // relay {type,to,from,data} -> {type:"signal",from,data}; drop if gone
        if (typeof msg.to === "string") {
          sendTo(msg.to, { type: "signal", from: id, data: msg.data });
        }
        break;
      default:
        break; // ignore unknown types
    }
  });

  ws.on("close", () => {
    leaveRoom(id);
    clients.delete(id);
  });

  ws.on("error", () => {
    leaveRoom(id);
    clients.delete(id);
  });
});

// Only start listening when run directly (not when imported by test.js).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => {
    console.log(`Vicinity signaling server listening on :${PORT}`);
  });
}
