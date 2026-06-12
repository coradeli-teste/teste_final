/**
 * CommonJS shim for the `uuid` package, used ONLY by Jest (wired via
 * `moduleNameMapper` in package.json).
 *
 * The installed `uuid` v14 is an ESM-only package, which Jest's CommonJS test
 * runtime cannot import directly (it throws "Unexpected token 'export'"). The
 * application code imports `{ v4 }` / `{ v4 as uuidv4 }` from `uuid`; this shim
 * provides an API-compatible `v4` backed by Node's built-in
 * `crypto.randomUUID`, which returns a real RFC-4122 version-4 UUID. Tests and
 * the code under test therefore receive genuine, validation-passing UUIDs
 * without loading the ESM module.
 */
const { randomUUID } = require('node:crypto');

/** Generate an RFC-4122 version-4 UUID string. */
function v4() {
  return randomUUID();
}

module.exports = { v4 };
