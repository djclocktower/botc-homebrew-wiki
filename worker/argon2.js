// Argon2id for the Worker — the one door to the vendored WebAssembly (see
// worker/vendor/argon2/README.md for where it came from and how it was
// checked).
//
// Workers refuse to compile WebAssembly from bytes at run time, so the two
// modules are imported (wrangler turns a `.wasm` import into a
// WebAssembly.Module) and handed to the library once.
//
// ONE hash at a time per isolate. Every Argon2 run allocates its whole memory
// cost (19 MiB at today's settings) for as long as it runs, and an isolate
// has 128 MB for everything. A burst of logins arriving at once would
// otherwise each take their own block at the same moment. Queued, the cost is
// a few extra milliseconds of waiting under a burst, never an out-of-memory
// crash.
import argon2WASM from './vendor/argon2/argon2.wasm';
import blake2bWASM from './vendor/argon2/blake2b.wasm';
import { argon2id, setWASMModules } from './vendor/argon2/argon2-edge.js';

let ready = null;
function init() {
  if (!ready) ready = Promise.resolve(setWASMModules({ argon2WASM, blake2bWASM }));
  return ready;
}

let queue = Promise.resolve();

// password, salt and secret are Uint8Arrays (secret may be empty). Returns
// the raw hash bytes.
export function argon2idRaw({ password, salt, secret, memoryKiB, iterations, parallelism, hashLength }) {
  const run = queue.then(async () => {
    await init();
    return argon2id({
      password, salt,
      secret: secret && secret.length ? secret : undefined,
      memorySize: memoryKiB, iterations, parallelism, hashLength,
      outputType: 'binary'
    });
  });
  // The next caller waits for this one to finish, whether it worked or not.
  queue = run.catch(() => {});
  return run;
}
