# Vicinity

Anonymous proximity voice chat. People in the same ~150m cell are dropped into
a room and talk over WebRTC — no accounts, no names stored, no database. The
room renders as a phosphor-green **sonar scope**: you're the center, nearby
people are blips, and a ping ripples out from whoever's talking.

- **No signup.** Pick a throwaway callsign and join.
- **Proximity rooms.** Grouped by a precision-7 geohash (~150m) of your location.
- **Peer-to-peer audio.** WebRTC full mesh; the server only relays signaling.
- **In-memory only.** No DB, no logs of who said what or where.

## Run

```sh
npm i
npm start
```

Open <http://localhost:9966/>. The server serves the client from `./public` and
the WebSocket endpoint on the same port.

> Mic + geolocation require a **secure context**. `localhost` works. A LAN IP
> over plain `http://` does not — tunnel it for HTTPS, e.g.
> `npx localtunnel --port 9966` or `cloudflared tunnel --url http://localhost:9966`.

## Test

```sh
npm test   # asserts the inline geohash encoder against a known value
```

## Env vars

| Var  | Default | Description            |
|------|---------|------------------------|
| PORT | 9966    | HTTP + WebSocket port. |

## How it works

- On each `loc`, the server computes a precision-7 geohash (standard base32,
  inline — no dependency). Your room = clients in your cell **or any of its 8
  neighbors**, so people near a cell boundary (or with slightly disagreeing
  GPS/wifi fixes) still match.
- Entering a room you get the current `peers`; existing members get
  `peer-joined`. Leaving (cell change or disconnect) sends `peer-left`.
- Cell switches are debounced ~5s to absorb GPS jitter at cell edges.
- The browser detects who's speaking from live Web Audio RMS and animates the
  scope; usernames are display-only and bounded to 24 chars server-side.

### WebSocket protocol

JSON messages. Malformed input and unknown types are ignored — the server never
crashes on bad data.

**Server → client**

| Message | Shape |
|---------|-------|
| welcome     | `{ type:"welcome", id }` — once on connect |
| peers       | `{ type:"peers", peers:[{ id, name }] }` — current members of the room you entered |
| peer-joined | `{ type:"peer-joined", id, name }` |
| peer-left   | `{ type:"peer-left", id }` |
| signal      | `{ type:"signal", from, data }` — relayed WebRTC signaling |

**Client → server**

| Message | Shape |
|---------|-------|
| join   | `{ type:"join", name }` — sets display name; room assigned on first valid `loc` |
| loc    | `{ type:"loc", lat, lon }` — sent periodically; must be finite + in range |
| signal | `{ type:"signal", to, data }` — relayed to `to`; dropped if the target is gone |

The server stamps `from` with the sender's own assigned id, so it can't be
spoofed; any client-supplied `from` is ignored.

## Not done yet

- **TURN server.** STUN-only — peers behind symmetric NAT (some phones on
  cellular) won't connect. Add a `turn:` entry in `client.js` `ICE_SERVERS`.
- **Abuse controls.** Anonymous voice near you needs mute/block/report before
  any public deployment.
- **Scale.** Full mesh is fine to ~6 peers; larger rooms need an SFU.

Deliberate shortcuts are marked with `ponytail:` comments in the source.
