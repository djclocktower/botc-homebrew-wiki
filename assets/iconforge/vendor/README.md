# Icon Forge — vendored third-party code

Nothing in this folder is wiki code. It is committed as-is so Icon Forge needs
no build step and loads no third-party JavaScript at run time.

| File | What it is | Licence |
|---|---|---|
| `imgly-bg-removal.js` | `@imgly/background-removal` 1.7.0, the `dist/index.mjs` from npm, unmodified. Powers the "Smart AI" background mode. | see `imgly-LICENSE.md` |
| `ort.wasm.min.js` | `onnxruntime-web` 1.21.0, the `dist/ort.wasm.min.mjs` build from npm, unmodified. It is a peer dependency of the above — the wasm-only build, 46 KB. | MIT (Microsoft) |

Both were `.mjs` upstream and are `.js` here: every module on this site is a
`.js` ES module, and it keeps them off any host's guesswork about MIME types.

**How they load.** `iconforge.html` declares an import map pointing the bare
specifier `onnxruntime-web` at `ort.wasm.min.js`; `bgremoval.js` dynamically
imports `imgly-bg-removal.js` the first time someone picks Smart AI. Nothing
here is fetched on a normal page load.

**What still comes from the network.** The ONNX runtime's `.wasm` binary
(~12 MB) and the segmentation model (~44 MB) are fetched from imgly's CDN by
the library itself, on first use, and then cached by the browser. Neither can
be committed — the model alone is bigger than Cloudflare's 25 MiB per-asset
limit, which would fail the whole deploy. If that CDN is unreachable the mode
fails loudly and the tool falls back to "Keep".

**Upgrading.** Re-download both files from npm at matching versions
(`@imgly/background-removal` pins `onnxruntime-web` as a peer dependency —
check its `package.json` before bumping one without the other). Do not patch
them by hand.
