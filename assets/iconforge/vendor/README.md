# Icon Forge — vendored third-party code

Nothing in this folder is wiki code. It is committed as-is so Icon Forge needs
no build step and loads no third-party JavaScript at run time.

| File | What it is | Licence |
|---|---|---|
| `imgly-bg-removal.js` | `@imgly/background-removal` 1.7.0, the `dist/index.mjs` from npm, with the two-line patch below. Powers the "Smart remove" background mode. | see `imgly-LICENSE.md` |
| `ort.wasm.min.js` | `onnxruntime-web` 1.21.0, the `dist/ort.wasm.min.mjs` build from npm, unmodified. It is a peer dependency of the above — the wasm-only build, 46 KB. | MIT (Microsoft) |

Both were `.mjs` upstream and are `.js` here: every module on this site is a
`.js` ES module, and it keeps them off any host's guesswork about MIME types.

**The patch.** Upstream, the library resolves the ONNX runtime through the
bare specifier `onnxruntime-web`, which only a bundler or an import map can
resolve — and **import maps do not apply inside Web Workers**, which is where
the segmentation has to run (on the main thread it freezes the tab). So the
two dynamic imports are rewritten to sit next to this file:

```
- ort = (await import("onnxruntime-web/webgpu")).default;
+ ort = (await import("./ort.webgpu.min.js")).default;
- ort = (await import("onnxruntime-web")).default;
+ ort = (await import("./ort.wasm.min.js")).default;
```

Nothing else is touched. `ort.webgpu.min.js` is deliberately **not** vendored:
that branch only runs when the caller asks for `device: 'gpu'`, which the wiki
never does. Drop the file in from npm if that ever changes.

**Re-apply it on upgrade** — download the new `dist/index.mjs`, rename it, and
make those two replacements again before committing.

**How they load.** `bgremoval.js` starts `bg-worker.js`, which dynamically
imports `imgly-bg-removal.js` the first time someone picks Smart remove; that in
turn pulls in `ort.wasm.min.js` when it builds the inference session. Nothing
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
