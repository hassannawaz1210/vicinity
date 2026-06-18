// Vicinity — browser client.
// Anonymous proximity voice chat. WebRTC full-mesh, WS signaling, geolocation.
// Canvas room: a phosphor-green sonar scope driven by live audio levels.
// Plain ES module, no build step, no deps.

// --- config ---------------------------------------------------------------
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.relay.metered.ca:80" },
  // Best-effort free TURN (Metered OpenRelay). Relays media only for peers that
  // can't connect directly (symmetric NAT). Public + rate-limited — if it's
  // down the browser just falls back to STUN/host, nothing breaks.
  // ponytail: for reliable TURN, swap these for your own free Metered key
  // (50GB/mo) or fetch ephemeral creds at runtime.
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
];
const LOC_THROTTLE_MS = 15000;
const SELF = "__self__";
// range in metres: 10 m floor, whole-planet ceiling, round-number grid.
const RANGE_MIN = 10;
const GLOBAL = 20015000;            // half Earth's circumference
const DEFAULT_RANGE = 150;
// step scales with magnitude so +/- stays a "reasonable" jump at every zoom
const stepFor = (v) =>
  v < 1000 ? 100 : v < 10000 ? 1000 : v < 100000 ? 10000 : v < 1000000 ? 100000 : 1000000;
const fmtRange = (m) =>
  m >= GLOBAL ? "GLOBAL" : m >= 1000 ? `${m / 1000} KM` : `${m} M`;

// --- DOM ------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const setupEl = $("setup");
const roomEl = $("room");
const nameInput = $("name");
const shuffleBtn = $("shuffle");
const joinBtn = $("joinBtn");
const muteBtn = $("muteBtn");
const statusEl = $("status");
const canvas = $("scene");
const rangeUpBtn = $("rangeUp");
const rangeDownBtn = $("rangeDown");
const rangeVal = $("rangeVal");
const audioContainer = $("audioContainer");

// --- state ----------------------------------------------------------------
let myId = null, myName = "", ws = null, localStream = null;
let muted = false, joined = false, reconnectUsed = false;
let lastLocSent = 0;
let audioCtx = null;
let range = DEFAULT_RANGE;   // current search range in metres
let rangeSendTimer = null;
const meters = [];           // { analyser, data, part }

// participant: { id, name, isSelf, level } — level is smoothed RMS 0..1
const parts = new Map();
// peerId -> { pc, audio, name }
const peers = new Map();

// --- identity / names -----------------------------------------------------
const ADJ = ["brave","calm","sly","lone","odd","warm","swift","quiet","wild","kind","dry","wry"];
const NOUN = ["fox","moth","wren","lynx","owl","elk","crow","hare","newt","carp","vole","stag"];
const rand = (a) => a[Math.floor(Math.random() * a.length)];
const randomName = () => `${rand(ADJ)}-${rand(NOUN)}-${Math.floor(Math.random()*90+10)}`;

// stable pseudo-random 0..1 from a string + salt (for placement)
function seed(s, salt) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10000) / 10000;
}

// --- landing --------------------------------------------------------------
nameInput.value = randomName();
shuffleBtn.addEventListener("click", () => { nameInput.value = randomName(); });
nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") onJoin(); });
joinBtn.addEventListener("click", onJoin);
muteBtn.addEventListener("click", toggleMute);

function setRange(next) {
  next = Math.min(GLOBAL, Math.max(RANGE_MIN, next));
  if (next === range) return;
  range = next;
  rangeVal.textContent = fmtRange(range);
  rangeDownBtn.disabled = range <= RANGE_MIN;
  rangeUpBtn.disabled = range >= GLOBAL;
  pulseAt = nowT;                       // kick the re-scan animation
  clearTimeout(rangeSendTimer);         // debounce rapid taps
  rangeSendTimer = setTimeout(() => send({ type: "range", range }), 250);
}
// step to the next/previous round multiple of the current band's step
rangeUpBtn.addEventListener("click", () => { const s = stepFor(range); setRange((Math.floor(range / s) + 1) * s); });
rangeDownBtn.addEventListener("click", () => { const s = stepFor(range - 1); setRange((Math.ceil(range / s) - 1) * s); });
rangeVal.textContent = fmtRange(range);

if (!window.isSecureContext) {
  setStatus("Open this over HTTPS (or localhost) to use the mic and location.", "error");
  joinBtn.disabled = true;
}

// --- ui helpers -----------------------------------------------------------
// Before joining, status shows in the DOM <p>. In-room it's drawn as a HUD
// line on the scope (see drawSonar) so it costs no layout space.
let hud = { msg: "", kind: "" };
function setStatus(msg, kind = "") {
  hud = { msg, kind };
  if (joined) { statusEl.classList.add("hidden"); return; }
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? " " + kind : "");
  statusEl.classList.toggle("hidden", !msg);
}
function updateStatus() {
  if (!joined) return;
  const n = peers.size;
  if (n === 0) setStatus("scanning…", "");
  else setStatus(`${n} ${n === 1 ? "contact" : "contacts"}`, "ok");
}

// --- join -----------------------------------------------------------------
async function onJoin() {
  if (joined) return;
  myName = (nameInput.value || "").trim() || randomName();
  joinBtn.disabled = true;
  setStatus("Requesting microphone…");
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    joinBtn.disabled = false;
    if (err && (err.name === "NotAllowedError" || err.name === "SecurityError"))
      setStatus("Microphone permission denied. Allow it and tap Join again.", "error");
    else if (err && err.name === "NotFoundError")
      setStatus("No microphone found on this device.", "error");
    else setStatus("Could not access microphone: " + ((err && err.message) || err), "error");
    return;
  }

  joined = true;
  setupEl.classList.add("hidden");
  roomEl.classList.remove("hidden");
  setStatus("Finding people nearby…");

  parts.set(SELF, { id: SELF, name: myName, isSelf: true, level: 0 });
  attachMeter(localStream, parts.get(SELF));
  startRenderer();
  startGeolocation();
  connect();
}

// --- websocket ------------------------------------------------------------
function wsUrl() {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/`;
}
function connect() {
  try { ws = new WebSocket(wsUrl()); }
  catch (err) { setStatus("Could not open connection: " + ((err && err.message) || err), "error"); return; }
  ws.addEventListener("open", () => { reconnectUsed = false; send({ type: "join", name: myName, range }); });
  ws.addEventListener("message", (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    handleMessage(msg);
  });
  ws.addEventListener("close", onSocketClose);
  ws.addEventListener("error", () => setStatus("Connection error.", "error"));
}
function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function onSocketClose() {
  for (const id of [...peers.keys()]) closePeer(id);
  updateStatus();
  if (!joined) return;
  // ponytail: one delayed reconnect, no backoff loop.
  if (!reconnectUsed) {
    reconnectUsed = true;
    setStatus("Connection lost. Reconnecting…", "error");
    setTimeout(() => { if (joined) connect(); }, 2000);
  } else setStatus("Disconnected. Reload the page to rejoin.", "error");
}

// --- message router -------------------------------------------------------
function handleMessage(msg) {
  switch (msg.type) {
    case "welcome": myId = msg.id; break;
    case "peers": for (const p of msg.peers || []) maybeConnectTo(p.id, p.name); updateStatus(); break;
    case "peer-joined": maybeConnectTo(msg.id, msg.name); break;
    case "peer-left": closePeer(msg.id); updateStatus(); break;
    case "signal": handleSignal(msg.from, msg.data); break;
  }
}

// --- geolocation ----------------------------------------------------------
function startGeolocation() {
  if (!navigator.geolocation) { setStatus("Geolocation isn't supported here.", "error"); return; }
  navigator.geolocation.watchPosition(
    (pos) => {
      const now = Date.now();
      if (now - lastLocSent < LOC_THROTTLE_MS) return;
      lastLocSent = now;
      send({ type: "loc", lat: pos.coords.latitude, lon: pos.coords.longitude });
    },
    (err) => {
      if (err.code === err.PERMISSION_DENIED) setStatus("Location denied — can't find people near you.", "error");
      else if (err.code === err.POSITION_UNAVAILABLE) setStatus("Location unavailable right now.", "error");
      else setStatus("Location error: " + err.message, "error");
    },
    // ponytail: maximumAge:Infinity returns a cached fix instantly so joining
    // isn't gated on a fresh GPS lookup.
    { enableHighAccuracy: false, maximumAge: Infinity, timeout: 20000 }
  );
}

// --- speaking meter -------------------------------------------------------
// ponytail: one shared AudioContext; the render loop reads each part.level.
function attachMeter(stream, part) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const src = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    meters.push({ analyser, data: new Uint8Array(analyser.fftSize), part });
  } catch { /* no Web Audio = flat levels; voice still works */ }
}
function pumpMeters() {
  for (const m of meters) {
    m.analyser.getByteTimeDomainData(m.data);
    let sum = 0;
    for (let i = 0; i < m.data.length; i++) { const v = (m.data[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / m.data.length);
    // smooth: fast attack, slow release
    m.part.level = Math.max(rms, m.part.level * 0.88);
  }
}

// --- webrtc mesh ----------------------------------------------------------
// ponytail: full mesh fine to ~6 peers (O(N^2)); SFU beyond that.
function createPeer(peerId, name) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  pc.addEventListener("icecandidate", (ev) => { if (ev.candidate) sendSignal(peerId, { kind: "ice", candidate: ev.candidate }); });
  pc.addEventListener("track", (ev) => attachRemoteAudio(peerId, ev.streams[0]));
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") { closePeer(peerId); updateStatus(); }
  });
  peers.set(peerId, { pc, audio: null, name: name || "anon" });
  parts.set(peerId, { id: peerId, name: name || "anon", isSelf: false, level: 0 });
  return peers.get(peerId);
}
function maybeConnectTo(peerId, name) {
  if (!peerId || peerId === myId || peers.has(peerId)) return;
  const entry = createPeer(peerId, name);
  if (myId && myId < peerId) makeOffer(peerId, entry.pc);
}
async function makeOffer(peerId, pc) {
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(peerId, { kind: "offer", sdp: pc.localDescription.sdp });
  } catch (err) { console.warn("offer failed for", peerId, err); }
}
async function handleSignal(from, data) {
  if (!from || !data) return;
  let entry = peers.get(from);
  if (!entry) { if (data.kind !== "offer") return; entry = createPeer(from, "anon"); }
  const pc = entry.pc;
  try {
    if (data.kind === "offer") {
      await pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal(from, { kind: "answer", sdp: pc.localDescription.sdp });
    } else if (data.kind === "answer") {
      await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
    } else if (data.kind === "ice") {
      try { await pc.addIceCandidate(data.candidate); } catch { /* early candidate */ }
    }
  } catch (err) { console.warn("signal handling failed from", from, err); }
}
function sendSignal(to, data) { send({ type: "signal", to, from: myId, data }); }
function attachRemoteAudio(peerId, stream) {
  const entry = peers.get(peerId);
  if (!entry) return;
  if (!entry.audio) {
    const audio = document.createElement("audio");
    audio.autoplay = true; audio.playsInline = true;
    audioContainer.appendChild(audio);
    entry.audio = audio;
    const part = parts.get(peerId);
    if (part) attachMeter(stream, part);
  }
  entry.audio.srcObject = stream;
  entry.audio.play && entry.audio.play().catch(() => {});
}
function closePeer(peerId) {
  const entry = peers.get(peerId);
  if (!entry) return;
  try { entry.pc.close(); } catch {}
  if (entry.audio) { entry.audio.srcObject = null; entry.audio.remove(); }
  peers.delete(peerId);
  parts.delete(peerId);
}

// --- mute -----------------------------------------------------------------
function toggleMute() {
  if (!localStream) return;
  muted = !muted;
  for (const t of localStream.getAudioTracks()) t.enabled = !muted;
  muteBtn.textContent = muted ? "Muted" : "Mute";
  muteBtn.classList.toggle("muted", muted);
}

// ==========================================================================
//  RENDERER — one rAF loop drawing the sonar scope
// ==========================================================================
const ctx = canvas.getContext("2d");
let dpr = 1, W = 0, H = 0, t0 = 0, nowT = 0;
let pulseAt = -10;         // time of last range change, for the re-scan pulse
const ripples = new Map(); // partId -> ripple phase accumulator (sonar)
let started = false;

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const r = canvas.getBoundingClientRect();
  W = Math.max(1, Math.round(r.width));
  H = Math.max(1, Math.round(r.height));
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function startRenderer() {
  if (started) return;
  started = true;
  resize();
  window.addEventListener("resize", resize);
  canvas.addEventListener("pointerdown", () => { if (audioCtx && audioCtx.state === "suspended") audioCtx.resume(); });
  requestAnimationFrame(frame);
}
function frame(t) {
  if (!t0) t0 = t;
  const time = (t - t0) / 1000;
  nowT = time;
  pumpMeters();
  ctx.clearRect(0, 0, W, H);
  drawSonar(time);
  requestAnimationFrame(frame);
}

// --- SONAR ----------------------------------------------------------------
function drawSonar(time) {
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.44;
  ctx.fillStyle = "#01040a"; ctx.fillRect(0, 0, W, H);

  // range rings + crosshairs, each labelled with its distance fraction
  ctx.strokeStyle = "rgba(68,255,153,0.18)"; ctx.lineWidth = 1;
  ctx.font = "9px " + getMono(); ctx.textBaseline = "bottom"; ctx.textAlign = "left";
  for (let i = 1; i <= 4; i++) {
    const rr = R * i / 4;
    ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "rgba(68,255,153,0.35)";
    ctx.fillText(fmtRange(Math.round(range * i / 4)), cx + 3, cy - rr - 1);
  }
  ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();

  // re-scan pulse: a bright ring sweeps out from center when range changes
  const since = nowT - pulseAt;
  if (since >= 0 && since < 0.85) {
    const k = since / 0.85;
    ctx.strokeStyle = `rgba(120,255,180,${0.6 * (1 - k)})`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, k * R, 0, Math.PI * 2); ctx.stroke();
  }

  // sweep with afterglow fan
  const sweep = time * 1.1 % (Math.PI * 2);
  for (let i = 0; i < 28; i++) {
    const a = sweep - i * 0.05;
    ctx.strokeStyle = `rgba(68,255,153,${0.16 * (1 - i / 28)})`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); ctx.stroke();
  }

  // peers as blips
  for (const p of parts.values()) {
    if (p.isSelf) continue;
    const ang = seed(p.id, 7) * Math.PI * 2;
    const dist = (0.35 + seed(p.id, 13) * 0.6) * R;
    const x = cx + Math.cos(ang) * dist, y = cy + Math.sin(ang) * dist;

    // radar persistence: brighten as sweep passes
    let d = ((sweep - ang) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    const persist = Math.max(0, 1 - d / 0.9);
    const speaking = p.level > 0.045;

    // speaking ping ripples
    if (speaking) {
      let ph = (ripples.get(p.id) || 0) + 0.022;
      ripples.set(p.id, ph);
      for (let k = 0; k < 2; k++) {
        const rp = (ph + k * 0.5) % 1;
        ctx.strokeStyle = `rgba(68,255,153,${0.5 * (1 - rp)})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, 6 + rp * 34, 0, Math.PI * 2); ctx.stroke();
      }
    } else ripples.set(p.id, 0);

    const glow = Math.min(1, 0.35 + persist * 0.65 + (speaking ? 0.4 : 0));
    ctx.shadowColor = "#44ff99"; ctx.shadowBlur = 12 * glow;
    ctx.fillStyle = `rgba(120,255,180,${glow})`;
    ctx.beginPath(); ctx.arc(x, y, speaking ? 6 : 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = `rgba(120,255,180,${0.5 + glow * 0.5})`;
    ctx.font = "12px " + getMono();
    ctx.textBaseline = "middle";
    const flip = x > cx ? -1 : 1;
    ctx.textAlign = flip < 0 ? "right" : "left";
    ctx.fillText(p.name, x + flip * 10, y);
  }

  // self at center
  const self = parts.get(SELF);
  const lv = self ? self.level : 0;
  ctx.shadowColor = "#ffc457"; ctx.shadowBlur = 14;
  ctx.fillStyle = "#ffc457";
  ctx.beginPath(); ctx.arc(cx, cy, 5 + lv * 14, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#ffc457"; ctx.font = "12px " + getMono();
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.fillText(myName + " (you)", cx, cy + 16);

  scanlines();
  drawHud(time);
}

// HUD: corner radar readout — replaces the old status line + nothing else
// competes for layout space.
function drawHud(time) {
  const col = hud.kind === "error" ? "#ff6b7a" : "#44ff99";
  ctx.textBaseline = "top";
  // top-left: contacts / status, with a blinking marker
  ctx.fillStyle = col; ctx.font = "11px " + getMono(); ctx.textAlign = "left";
  const dot = Math.floor(time * 2) % 2 ? ">" : " ";
  ctx.fillText(`${dot} ${(hud.msg || "").toUpperCase()}`, 12, 12);
}

// --- shared CRT overlay ---------------------------------------------------
let monoCache = null;
function getMono() {
  if (!monoCache) monoCache = getComputedStyle(document.body).getPropertyValue("--mono") || "monospace";
  return monoCache;
}
function scanlines() {
  ctx.fillStyle = "rgba(0,0,0,0.10)";
  for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
  // vignette
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.2, W / 2, H / 2, Math.max(W, H) * 0.7);
  g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}
