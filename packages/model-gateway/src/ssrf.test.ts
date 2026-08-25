import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertSafeProviderBaseUrl } from "./index";

describe("assertSafeProviderBaseUrl", () => {
  it("rejects IPv4-mapped localhost", () => {
    assert.throws(() => assertSafeProviderBaseUrl("https://[::ffff:127.0.0.1]"), /private or link-local/);
  });

  it("rejects unique-local IPv6", () => {
    assert.throws(() => assertSafeProviderBaseUrl("https://[fd12:3456:789a::1]"), /private or link-local/);
  });

  it("rejects decimal IPv4 localhost", () => {
    assert.throws(() => assertSafeProviderBaseUrl("https://2130706433"), /private or link-local/);
  });

  it("allows a public https host", () => {
    const url = assertSafeProviderBaseUrl("https://openrouter.ai/api/v1");
    assert.equal(url, "https://openrouter.ai/api/v1");
  });
});
