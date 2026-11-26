# Third-party notices

The original code written for this project is MIT licensed (see `LICENSE`). Bundled third-party code and model weights are not relicensed by the project; each retains the separate licence and attribution identified below. Their notices are included in the release. This does not grant rights to third-party trademarks.

## SigmaQuoridor — model weights `models/sigma_9x9.onnx`

- Source: https://github.com/bartolomeo3000/SigmaQuoridor
- Copyright: the SigmaQuoridor authors
- Licence: MIT. The full notice is in `vendor/sigma/LICENSE`.
- What we use: the 9×9 policy/value network, unmodified. We convert nothing; the
  original `.onnx` file is shipped as-is.
- `models/sigma_9x9_batch.onnx` is a derived copy of the same weights: only the
  batch dimension of the input/output and two `Reshape` constants were changed
  (1 → N / 0) so several positions can be evaluated in one call. It remains
  under the same MIT licence and attribution.
- Obligation: keep this notice with any redistribution of the weights.

## ONNX Runtime Web

- Source: https://github.com/microsoft/onnxruntime
- Copyright: Microsoft Corporation
- Licence: MIT. The full notice is in `vendor/ort/LICENSE`, alongside additional
  component notices in `vendor/ort/licenses/`.
- What we use: the WebGPU browser build and its JSEP wasm, vendored under
  `vendor/ort/` (`ort.min.js`, `ort-wasm-simd-threaded.jsep.mjs`,
  `ort-wasm-simd-threaded.jsep.wasm`), version 1.22.0. Vendoring avoids a
  third-party CDN and lets the page work offline. (1.19.2's WebGPU provider
  returned corrupted outputs for every batch sample after the first.)
- Obligation: keep the MIT notice when redistributing the runtime.

## PeerJS — `vendor/peerjs.min.js`

- Source: https://github.com/peers/peerjs
- Copyright: the PeerJS authors
- Licence: MIT. See `vendor/peerjs/LICENSE` and `vendor/peerjs/licenses/` for its bundled dependencies.
- What we use: the minified browser build, vendored without a third-party CDN.
  Only Direct rooms use PeerJS for WebRTC signalling and data channels.

## Hosted room services (not bundled libraries)

- `W-` invitations use this project's Cloudflare Workers WebSocket relay.
- `R-` invitations use the public ntfy.sh HTTPS relay.
- Direct rooms use public PeerJS signalling and WebRTC connection services.
- See `privacy.html#rooms` for the data exchanged with these services.

## Detour search engine

- Source: https://github.com/EmyoTyyy/detour at `8a48b84b5f4f9427619822d2b5624b5f95294d07`
- Copyright: (c) 2026 EmyoT
- Licence: MIT. The full notice is in `vendor/detour/LICENSE`.
- What we use: `engine.js` and `weights.js` from the upstream `path/` directory.
  The vendored files are `vendor/detour/engine.js` and
  `vendor/detour/weights.js`, exposed through ES modules. `detour.js` translates
  positions and moves into this project's rules API. The local engine adds root
  move filtering and optional move ordering and scoring based on the separately
  credited SigmaQuoridor and Claustrophobia models.
  It also adjusts how the root search handles score bounds and retries.

## Claustrophobia policy

- Source: https://github.com/Plaaasma/Claustrophobia/releases/tag/v1.3.1
- Copyright: (c) 2026 Plaaasma
- Licence: MIT. See `vendor/claustrophobia/LICENSE`.
- What we use: the public `champion.pt` checkpoint converted to ONNX without
  retraining, plus a JavaScript adapter for the release's 20-plane input and
  209-action policy. The browser uses the policy to guide Detour search.

## Quoridor

- Designer: Mirko Marchesi. The rule set used here is the standard 9×9 board with
  10 walls per player. Pawns and walls are drawn with canvas primitives; no
  official board artwork is bundled. Quoridor is a trademark of Gigamic and is
  used to identify the game implemented here. This independent project is not
  affiliated with or endorsed by Gigamic; its software licence grants no trademark rights.

## Fonts and other assets

The page uses system fonts. The favicon and social preview in `assets/` are original project artwork.

## If you fork this

Keep `LICENSE` and this file, and keep the attribution line visible on the page
(`index.html` footer). If you retrain or replace the weights with your own model,
state it clearly and drop the SigmaQuoridor attribution only if no part of their
weights remains.
