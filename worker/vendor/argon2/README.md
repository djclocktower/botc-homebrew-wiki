# Argon2id for the Worker (vendored, do not edit)

The password hash (see "Account security" in CLAUDE.md). Cloudflare's
WebCrypto has no Argon2, so it comes from WebAssembly.

| file | from | sha256 |
|---|---|---|
| `argon2-edge.js` | `argon2-wasm-edge@1.0.23`, `dist/index.esm.js`, verbatim | `3cc41178382b7b2389d912c05846259dd4c92fe4a951c234449a9a3e0d67d309` |
| `argon2.wasm` | same package, `wasm/argon2.wasm` | `106385fa85ea1abdb8449cd4faebbd3140a6d0ea598156556643d2f4db32cda2` |
| `blake2b.wasm` | same package, `wasm/blake2b.wasm` | `a1e021f38270721438905713fa44bbded4ed5bc1aa81bda01d49a4e266131871` |
| `LICENSE` | MIT, Dani Biró (hash-wasm) | |

**Why that package, and why it can be trusted.** `argon2-wasm-edge` is the
Argon2 part of [hash-wasm](https://github.com/Daninet/hash-wasm), repackaged
so it runs on Workers. Workers refuse to compile WebAssembly from bytes at
run time, so the modules have to be `import`ed; `setWASMModules()` exists
for that. Both `.wasm` files are **byte-identical** to the ones embedded in
`hash-wasm@4.11.0` (hash-wasm 4.12 only rebuilt them; its changelog has no
Argon2 changes). The base64 copies inside `argon2-edge.js` are identical to
the `.wasm` files too, and the glue makes no network calls and no `eval`.
The output matches the Argon2 reference implementation's published test
vector: argon2id, "password" / "somesalt", t=2, m=65536, p=1, giving
`09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7`.
`migration/tests/security.test.mjs` checks this.

**How it is loaded.** `worker/argon2.js` imports the two `.wasm` files
(wrangler's default rule turns a `.wasm` import into a
`WebAssembly.Module`) and hands them to `setWASMModules()`. The test fixture
rewrites those two imports for Node. Nothing else imports this folder.

**Upgrading.** Re-download the package, check the `.wasm` files against
hash-wasm's embedded copies again, and re-run the test vector. Do not
hand-edit these files.
