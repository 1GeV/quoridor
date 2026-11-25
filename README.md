# Quoridor 9x9 — web build

A self-contained Quoridor board with several AI engines, local two-player mode and
peer-to-peer rooms. No framework, no build step, no server state: the whole app
is a collection of ES modules plus locally executed ONNX models. This is a public
beta; no claim is made that its AI is stronger than Barricade's main-site Expert.

Play at **https://1gev.github.io/quoridor/**.

## Quick start

```bash
npm ci              # install test and benchmark dependencies
node serve.js 8099   # any static server works
# open http://localhost:8099/
```

The page and its built-in AI run as a static site. On Windows, double-click
`Start Web.bat` after Node.js is installed. `serve.js` exists because ES modules and `fetch()` of the model
do not work from `file://`.

### Deploying to GitHub Pages

The public deployment uses the public repository's `gh-pages` branch and the
standard GitHub Pages hostname. It requires no paid hosting, custom domain,
application server or paid AI. Run `npm run build` to generate `dist/` from an
explicit list of website files; publish that directory to `gh-pages`. Set
Settings → Pages → Deploy from a branch → `gh-pages` → `/ (root)`.

Local screenshots, developer notes, dependencies, tests and benchmark programs
are excluded from the deployed website. The English privacy notice describes
browser storage and optional third-party connections. No maintainer's personal
name, email, phone number or address is included in this project's own published
credits or policies. Third-party copyright notices retain their authors' credits.
These documents do not establish regulatory approval or replace any disclosures
required by applicable law for a particular deployment.

GitHub Pages serves the site. Alpha-beta and Sigma run on the visitor’s device
and require no account, API key, paid API, or application server. The optional
External AI setting uses an endpoint the player supplies, which may charge for
requests. The Python desktop application is independent of this site.

The build is about 71 MiB because the ONNX Runtime WebGPU wasm and model files are
vendored. Selected models start loading while the human is thinking, with
verified model/runtime bytes cached locally for later visits. On GitHub Pages,
a scoped service worker supplies COOP/COEP for this project's files so supported
browsers can use up to four WASM CPU threads. CPU inference runs in a background
worker; the plain Alpha-beta search has its own worker. Unsupported or restricted
browsers keep the single-threaded path. Neural evaluations finish in full; no
inference timeout or reduced model is used. Search budgets remain as selected.
First-use model preparation shows downloaded byte progress, then reports file
verification and runtime initialization separately; cached models show when
they are being read from this browser.
Rooms use HTTPS + WebRTC; connectivity still
depends on the signalling provider, browser and network.

## Modes

| Mode | What it does |
| --- | --- |
| **vs AI** | Play against the selected engine. *Flip sides* swaps who controls each colour at the current position. |
| **2 players** | Hot-seat on one device, red moves first. |
| **room** | Create a four-letter room and send the code to a friend. The host plays red, the guest blue. |

**I always play from the bottom** also applies to room games: the guest's board
rotates without changing move notation or network actions. Turning it off
restores the fixed Red-at-bottom view.

In **2 players**, **Undo** takes back one move. In **vs AI**, it returns to
your previous turn. Both modes support undo after the game ends.

In **Saved games**, choose **Open replay** or **Import game** to load a game.
Use the slider to pick a position, choose **2 players** or a colour against the
AI, then select **Play from here**. To continue a finished game, go back at
least one move first. **Export position** downloads a JSON file containing
the moves up to the position on screen, including in an unfinished game.
**Auto speed** sets the delay between replay moves and can be changed during playback.

## Game ending

A player wins on reaching the opposite edge. Repeated positions are legal, and
play can continue beyond 200 individual moves. Earlier saved move lists can be
resumed from any position where neither pawn has reached its goal.

Finishing a live game opens a result card with a personal win/loss message in
vs AI and rooms, a move/wall summary, and another-game controls. Local games also
offer immediate replay and undo, even when saving is disabled. Dismiss the card
to inspect the final board; **View result** opens it again. The winning player
and result remain highlighted. Replay does not interrupt you with result cards,
and celebration effects respect reduced-motion preferences.

The built-in web engines solve positions with zero or one wall left in total.
For a fixed wall layout, the solver labels pawn positions backwards from the goal
rows. With one wall left, placing it moves to a solved zero-wall layout. The
remaining pawn edges and those solved exits determine the shortest forced win
or longest forced loss. With two walls remaining, the alpha-beta engine also
looks for short forced wins against every legal reply. If it cannot prove a win
within its time budget, normal search takes over.

## Rooms

* **Create room** registers a peer id `q9-<CODE>` on the public PeerJS broker and
  waits. The code (for example `AVK7`) is shown in the panel.
* **Join** connects to that id; the guest is blue.
* Both browsers check move legality, whose turn it is and the move number.
  The host keeps the move list and sends it to each guest after connecting.
  Leaving and joining again with the same code restores the game while the host
  has the room open. The guest can request a rematch and the host decides when
  to start it.
* Traffic is a WebRTC data channel between the two browsers; no game data
  reaches this project's host. PeerJS is MIT licensed and vendored in
  `vendor/peerjs.min.js`.

Known limits: both players need internet access to the PeerJS broker, and a
very restrictive NAT can still block the direct connection (a TURN server would
be needed). If the broker is unreachable, the panel says so and local modes keep
working.

## External AI cost control and privacy

Entering an endpoint does not enable automatic API calls for AI turns. The
per-seat **Allow automatic AI move requests** option is unchecked by
default; without that explicit opt-in, the seat waits and prompts you to enable
permission in External AI settings. Enable the option and **Save & apply** to
continue; paused AI-vs-AI games also require pressing **Play**. The Test
button and each AI-chat message send a live request and may incur provider
charges. See [privacy.html](./privacy.html) for the request contents, local
storage and third-party connections.

## Engine behaviour

The plain Alpha-beta option uses the MIT-licensed Detour search engine and its
lightweight evaluation weights. It considers every legal root
move and uses selective alpha-beta search below the root. It runs in a Web
Worker, with 0.35, 1.2, 2.2 and 4 second budgets. Starting a new game, changing
modes or pausing autoplay cancels pending search. The adapter checks the result
against the game rules.

Sigma uses the vendored SigmaQuoridor policy/value model. PUCT uses the parent
position’s value as the starting estimate for unexplored moves. The search
reuses results when different move orders reach a position with the same model
input. When available, WebGPU batches distinct positions and reduces batch
size as the search deadline approaches. The CPU fallback uses WebAssembly. The runtime and
model load on the first Sigma turn. Depending on the selected tier, simulation
search has a 1.4, 2.4, 3.2, or 4 second budget and checks the time between inference
calls. The 2048 tier targets 2048 simulations in that time. Initial model loading
is timed separately. After the turn the UI shows actual simulations, the target,
the backend and elapsed search time. WebGPU batch inference is checked against
single-position inference during loading. Both engines check immediate wins and
one-turn defences and use the exact solver when at most one wall remains.

Guided Alpha-beta is an experimental 1.2 second option. It uses one Sigma policy
inference to order the current position's moves, then uses Detour to search.
The policy adds a bounded preference to uncertain root scores. Proven results
use the search score, and immediate wins and defences take priority. The mode
shares the Sigma model download and falls back to plain Detour if inference
fails. The per-turn budget includes inference after the model is loaded.

**Claustrophobia + Alpha-beta** uses the public Claustrophobia v1.3.1
self-play model to guide Detour. The 28.5 MB ONNX model loads on the first turn
that needs it. Its policy uses exact wall and shortest-path features. Search
and inference run on the player's device. Standard (1.2 s) is the default.
Deep (3 s) gives the same engine more time. See `NOTICE.md` for attribution.

The most recent available local log against the separately obtained Barricade
embedded Expert engine (50,000 nodes) recorded 7 wins and 6 losses before a
planned 16-game run stopped. It used a 1.2 second guided-search budget and
alternating sides. The run is incomplete, lacks a final summary and is not a
benchmark against the main-site Expert. It does not establish a reliable win
rate or consistent superiority. Tests of move legality and model encoding also
do not measure overall playing strength. Run
`node tools/match_expert.mjs <offline-engine-dir> --pairs=4 --ms=1200` for a new
local comparison; the tool does not copy opponent files into the site.

## External AI

Select **External AI** for an engine seat. Choose **API format**: Chat Completions
(`/v1/chat/completions`), OpenAI Responses (`/v1/responses`), Anthropic Messages
(`/v1/messages`), or automatic detection from a complete endpoint URL. A base
URL ending in `/v1` gets the selected format's suffix. Custom endpoint paths
can be used exactly as entered by checking the matching option and selecting
their request format. Responses requests use `store: false`; provider-side
logging and caching remain subject to that provider's policy. Browser requests
need CORS at the endpoint. The **Test** button sends a live request asking for
`OK`. **Save & apply** saves the configuration. Automatic move requests remain
disabled until explicitly enabled and saved for that profile; the seat waits
while permission is off. The key is sent only to the
configured endpoint in an authorization header. By default the browser keeps it
in session storage. The remember option also stores it unencrypted on this
device. “Forget this API key” removes it from this app's browser storage; revoke
it separately at the provider.

The compact settings form keeps connection examples and data details under
**Connection help & privacy**. A local server can use a loopback URL such as
`http://localhost:1234/v1`; it must expose a supported API format, allow this
site's origin through CORS, and satisfy any browser local-network permission.
Leave the key blank only when the server does not require authentication.
`localhost` refers to the device running the browser.

Each move sends the rules, the two pawn coordinates, every placed wall, remaining
wall reserves, the side to move, move count, result when available, up to 12 recent
moves and all legal actions. Coordinates follow the fixed notation even when the
board is flipped. The expected reply is one action and optional commentary.

```json
{"move":"H e5","say":"Slow the opponent’s route.","plan":["Check the left corridor next turn."]}
```

A reply may use a coordinate like `e8`, wall notation like `H e5` or `V e5`, or a
legal numeric action ID in `move`. `say` and `plan` are displayed in chat.
Plans never place moves. The game checks the reply against the legal-action list
and uses local Alpha-beta for the turn if the endpoint fails or sends an invalid
reply. Valid decisions for identical context can be reused in the current tab.
The result cache is separate for each logical seat and board colour, and matches
the endpoint, API format, model, image permission and full submitted position
context. Saving settings or forgetting a key clears it. Changing the endpoint,
model, format or key also cancels that profile's pending chat and clears its
conversation. The page labels reused moves and provider-reported cached tokens;
provider prompt-cache availability and pricing are not guaranteed by this app.
If board images are enabled for the seat, `{"want_board":true}` requests a single
512×512 JPEG of the board for a follow-up call.

Chat sends the current position, the question and up to eight previous chat
messages for that seat. Chat replies are displayed as text and do not play moves.

After building, `node tools/check-external-ai-ui.mjs` checks consent, all three
formats, local CORS, caching, cancellation and mobile layout with local mock
responses. It requires Chromium remote debugging at `http://127.0.0.1:9225`
(override with `QUORIDOR_CDP_URL`) and uses an isolated browser context.
`node tools/check-ai-performance.mjs` compares one- and four-thread browser
execution, checks the full model outputs agree, measures continuous play from a
wall-rich position, and verifies that model bytes are reused after a reload.

## Agent interface

On touchscreens, drag a horizontal or vertical wall control onto the board and
release to place it. Invalid positions and releases outside the board do not
make a move; tapping a wall control still selects the orientation for tap-to-place.

The page exposes a small API on `window.quoridor`, which is enough for a script
or an external agent to play:

```js
quoridor.newGame();                 // reset, red to move
quoridor.move(45);                  // play a legal action id, returns true/false
quoridor.state();                   // { pos, walls, turn, ply, terminal, legal, last }
quoridor.setMode("hotseat");        // "ai" | "hotseat" | "room"
```

Action ids follow the desktop engine exactly:

* `0..80` — pawn move to cell `row * 9 + col`;
* `81..144` — horizontal wall, anchor `(row, col)` in `row * 8 + col`;
* `145..208` — vertical wall, same anchor scheme.

Walls span two cells; the anchor is their top-left slot. `state().legal` is the
authoritative list for the current position. A minimal agent loop:

```js
const s = quoridor.state();
const action = myPolicy(s);         // must be in s.legal
quoridor.move(action);
```

The separate Python desktop build exposes a line-based JSON protocol over stdin/stdout.

## Files

```
index.html          game layout
board.css           theme and responsive layout
app.js              canvas UI, game flow, rooms, public API
rules.js            rules and immutable State
alphabeta.js        original alpha-beta for benchmarks
detour.js           Detour adapter
alphabeta-worker.js background search
guided.js           Sigma policy inference and the remaining Detour budget
endgame.js          exact endgame solver and bounded proof search
sigma.js            Sigma encoder, sequential and batched PUCT agents
heuristic.js        last-resort opponent
models/             sigma_9x9.onnx, sigma_9x9_batch.onnx (dynamic batch)
vendor/             peerjs.min.js, ort/ (ONNX Runtime Web + WebGPU)
serve.js            tiny static server with COOP/COEP headers
tests/              rules, encoder parity, engine legality (node --test)
tools/              benchmarks, A/B matches, move inspector
```

The WebGPU runtime is vendored (`vendor/ort/ort.min.js`,
`ort-wasm-simd-threaded.jsep.{mjs,wasm}`), so the page does not need a CDN and
needs no model CDN. `serve.js` sends
`Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` so threaded wasm
is available. On GitHub Pages, a narrowly scoped service worker supplies those
headers to same-origin GETs, enabling up to four CPU threads without caching or
proxying external requests.

## Tests and tools

```bash
node --test tests/*.test.mjs              # rules and engine regression tests
node tools/match_detour.mjs 180 6         # Detour vs original, six openings with sides swapped
node tools/match_sigma_detour.mjs 2000 2  # Sigma vs Detour, equal ms and two openings with sides swapped
node tools/match_sigma_detour.mjs 1200 2 0 guided # Guided vs Detour at the browser preset
node tools/match_sigma_detour.mjs 1200 2 4 guided # Same budget on another group of openings
node tools/bench.mjs 7 1500              # original alpha-beta nodes/s and legality
node tools/match.mjs 2 48 7 1500         # alpha-beta vs Sigma, alternating colours
node tools/match_batch.mjs 2 512 64 16   # batched vs sequential Sigma
node tools/duel.mjs 7 1000               # alpha-beta vs heuristic / depth duels
MOVES="67,13,..." node tools/inspect.mjs # decode a recorded game
```

`gpu_test.html` is a development page for measuring WebGPU/wasm inference in a
browser; it is not part of the game.

## Licence and credits

MIT for this code. SigmaQuoridor weights are MIT (c) their authors; ONNX Runtime
Web, PeerJS and Detour are MIT. Quoridor is a trademark of Gigamic — this project is an
unaffiliated implementation of the public rules. See `NOTICE.md`.
