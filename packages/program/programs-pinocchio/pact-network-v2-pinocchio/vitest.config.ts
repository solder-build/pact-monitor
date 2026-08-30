import { defineConfig } from "vitest/config";

// LiteSVM is a NAPI-RS native addon — Vitest docs explicitly call this class
// out (alongside Prisma, bcrypt, canvas) as needing the `forks` pool not
// `threads`. `forks` has been the Vitest 2.x+ default, but pinning it here
// insulates the suite from any future default flip.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    // Each test file constructs its own `new LiteSVM()` — fork-per-file is the
    // correct isolation level. Do NOT set singleFork: true unless cross-test
    // bleed is observed (which would indicate a global in helpers, not LiteSVM).
    poolOptions: {
      forks: { singleFork: false },
    },
    testTimeout: 30_000,
  },
});
