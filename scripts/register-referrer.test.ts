// Smoke tests for scripts/register-referrer.ts — the admin CLI. We don't
// want a full e2e against the backend in this unit suite, so the tests
// focus on arg-parsing + local validation (the pieces that run before any
// network call). Exit-2 paths (backend rejects) are covered by the admin
// PATCH route tests in packages/backend/src/routes/partners.test.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "register-referrer.ts");

function run(args: string[], env: Record<string, string> = {}) {
  const res = spawnSync("npx", ["tsx", SCRIPT, ...args], {
    env: {
      ...process.env,
      // Unset by default; tests opt in via env arg.
      ADMIN_TOKEN: "",
      ...env,
    },
    encoding: "utf-8",
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe("register-referrer.ts CLI", () => {
  it("exits 1 when --api-key-label is missing", () => {
    const r = run([
      "--referrer-pubkey=RefPubkey111111111111111111111111111111111",
      "--share-bps=500",
    ]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--api-key-label is required/);
  });

  it("exits 1 when ADMIN_TOKEN is not set", () => {
    const r = run([
      "--api-key-label=some-key",
      "--referrer-pubkey=RefPubkey111111111111111111111111111111111",
      "--share-bps=500",
    ]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /ADMIN_TOKEN/);
  });

  it("exits 1 on --share-bps above 3000 (locally rejected before network)", () => {
    const r = run(
      [
        "--api-key-label=some-key",
        "--referrer-pubkey=RefPubkey111111111111111111111111111111111",
        "--share-bps=3001",
      ],
      { ADMIN_TOKEN: "tok" },
    );
    assert.equal(r.code, 1);
    assert.match(r.stderr, /\[0, 3000\]/);
  });

  it("exits 1 on --share-bps negative", () => {
    const r = run(
      [
        "--api-key-label=some-key",
        "--referrer-pubkey=RefPubkey111111111111111111111111111111111",
        "--share-bps=-1",
      ],
      { ADMIN_TOKEN: "tok" },
    );
    assert.equal(r.code, 1);
  });

  it("exits 1 when registering without --referrer-pubkey", () => {
    const r = run(
      ["--api-key-label=some-key", "--share-bps=500"],
      { ADMIN_TOKEN: "tok" },
    );
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--referrer-pubkey is required/);
  });

  it("exits 1 when --clear is combined with --referrer-pubkey", () => {
    const r = run(
      [
        "--api-key-label=some-key",
        "--clear",
        "--referrer-pubkey=RefPubkey111111111111111111111111111111111",
      ],
      { ADMIN_TOKEN: "tok" },
    );
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--clear is exclusive/);
  });

  it("accepts --api-key-id as alias for --api-key-label", () => {
    // Should NOT fail with "--api-key-label is required" when --api-key-id
    // is given. It will still fail (exit 2) because the backend isn't up,
    // but that proves arg-parsing accepted the alias.
    const r = run(
      [
        "--api-key-id=some-key",
        "--referrer-pubkey=RefPubkey111111111111111111111111111111111",
        "--share-bps=500",
      ],
      { ADMIN_TOKEN: "tok", BACKEND_URL: "http://127.0.0.1:1" }, // non-routable
    );
    // Either exit-2 from fetch failure or exit-0 if backend coincidentally
    // responds; the only outcome we're ruling out is exit-1 (arg validation
    // failure).
    assert.notEqual(r.code, 1, `stderr: ${r.stderr}`);
  });
});
