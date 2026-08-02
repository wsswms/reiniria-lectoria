import assert from "node:assert/strict";
import test from "node:test";
import { createPinnedHttpsTransport, createRobotsPolicy, parseRobots } from "../../src/pilot/restricted-https-transport.mjs";

test("robots policy honors the named agent, wildcard fallback and disallow rules", () => {
  const policy = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/public\n", "ReiniriaLectoriaPilot");
  assert.equal(policy(new URL("https://example.com/public")), true);
  assert.equal(policy(new URL("https://example.com/private/page")), false);
  assert.equal(policy(new URL("https://example.com/private/public/page")), true);
});

test("pinned HTTPS transport passes only approved public addresses to its requester", async () => {
  let observed;
  const transport = createPinnedHttpsTransport({ requestImpl: async (input) => {
    observed = input;
    return new Response("public body", { status: 200, headers: { "content-type": "text/plain" } });
  } });
  const response = await transport({ url: "https://example.com/reference", approvedAddresses: ["93.184.216.34"], method: "GET", headers: { accept: "text/plain" } });
  assert.equal(await response.text(), "public body");
  assert.equal(observed.address, "93.184.216.34");
  assert.equal(observed.servername, "example.com");
  await assert.rejects(() => transport({ url: "https://example.com/", approvedAddresses: ["127.0.0.1"], method: "GET", headers: {} }), /public/);
});

test("robots fetch uses the same pinned transport and fails closed", async () => {
  const calls = [];
  const robotsAllowed = createRobotsPolicy({ resolver: async () => ["93.184.216.34"], transport: async (input) => {
    calls.push(input.url); return new Response("User-agent: *\nDisallow: /blocked\n", { status: 200, headers: { "content-type": "text/plain" } });
  } });
  assert.equal(await robotsAllowed(new URL("https://example.com/open")), true);
  assert.equal(await robotsAllowed(new URL("https://example.com/blocked")), false);
  assert.deepEqual(calls, ["https://example.com/robots.txt"]);
  const deny = createRobotsPolicy({ resolver: async () => [], transport: async () => { throw new Error(); } });
  assert.equal(await deny(new URL("https://example.com/open")), false);
});
