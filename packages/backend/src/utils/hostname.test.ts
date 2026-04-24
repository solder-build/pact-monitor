import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalHostname } from "./hostname.js";

describe("canonicalHostname", () => {
  it("lowercases plain hostnames", () => {
    assert.equal(canonicalHostname("API.EXAMPLE.COM"), "api.example.com");
    assert.equal(canonicalHostname("Api.Example.Com"), "api.example.com");
  });

  it("is identity for an already-canonical hostname", () => {
    assert.equal(canonicalHostname("api.example.com"), "api.example.com");
  });

  it("strips https:// scheme", () => {
    assert.equal(
      canonicalHostname("https://api.example.com"),
      "api.example.com",
    );
  });

  it("strips http:// scheme", () => {
    assert.equal(
      canonicalHostname("http://api.example.com"),
      "api.example.com",
    );
  });

  it("strips path and query", () => {
    assert.equal(
      canonicalHostname("https://api.example.com/v0/webhooks"),
      "api.example.com",
    );
    assert.equal(
      canonicalHostname("https://api.example.com/v0/webhooks?x=1&y=2"),
      "api.example.com",
    );
  });

  it("collapses scheme+case+path variants to the same output", () => {
    const canonical = "api.helius.xyz";
    const variants = [
      "api.helius.xyz",
      "API.Helius.XYZ",
      "https://api.helius.xyz",
      "https://API.HELIUS.XYZ/v0/webhooks",
      "http://api.helius.xyz/",
      "https://api.helius.xyz:443",
    ];
    for (const v of variants) {
      assert.equal(canonicalHostname(v), canonical, `variant ${v}`);
    }
  });

  it("trims surrounding whitespace", () => {
    assert.equal(canonicalHostname("  api.example.com  "), "api.example.com");
  });

  it("preserves non-default ports? no — only hostname is relevant for pools", () => {
    // The pool PDA seed is provider_hostname only; ports are intentionally
    // ignored so :443, :80, and bare form collapse.
    assert.equal(
      canonicalHostname("https://api.example.com:8443/admin"),
      "api.example.com",
    );
  });

  it("throws on empty or whitespace-only input", () => {
    assert.throws(() => canonicalHostname(""));
    assert.throws(() => canonicalHostname("   "));
  });

  it("throws on unparseable input", () => {
    assert.throws(() => canonicalHostname("http://"));
  });
});
