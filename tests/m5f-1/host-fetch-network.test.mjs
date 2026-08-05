import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createPinnedHttpsTransport, robotsAllows } from "../../src/search/node-https-transport.mjs";

test("pinned HTTPS transport uses only an approved address and returns a bounded Response", async () => {
  const observations = [];
  const requestImpl = (options, callback) => {
    observations.push(options);
    options.lookup("official.example", {}, (error, address, family) => observations.push({ error, address, family }));
    options.lookup("official.example", { all: true }, (error, addresses) => observations.push({ error, addresses }));
    const response = new EventEmitter(); response.statusCode = 200;
    response.headers = { "content-type": "text/plain" };
    const request = new EventEmitter(); request.setTimeout = () => {}; request.end = () => {
      callback(response); response.emit("data", Buffer.from("public fixture")); response.emit("end");
    }; request.destroy = (error) => request.emit("error", error); return request;
  };
  const transport = createPinnedHttpsTransport({ requestImpl, timeoutMs: 1000, maxBytes: 1024 });
  const response = await transport({ url: "https://official.example/reference", approvedAddresses: ["93.184.216.34"],
    method: "GET", headers: { accept: "text/plain" } });
  assert.equal(await response.text(), "public fixture");
  assert.equal(observations[0].servername, "official.example");
  assert.equal(observations[0].headers["accept-encoding"], "identity");
  assert.deepEqual(observations[1], { error: null, address: "93.184.216.34", family: 4 });
  assert.deepEqual(observations[2], { error: null, addresses: [{ address: "93.184.216.34", family: 4 }] });
  assert.throws(() => transport({ url: "https://official.example/", approvedAddresses: ["127.0.0.1"], method: "GET", headers: {} }), /public/);
});

test("pinned HTTPS transport accepts a successful response that must not carry a body", async () => {
  const requestImpl = (_options, callback) => {
    const response = new EventEmitter(); response.statusCode = 204; response.headers = {};
    const request = new EventEmitter(); request.setTimeout = () => {}; request.end = () => { callback(response); response.emit("end"); };
    request.destroy = (error) => request.emit("error", error); return request;
  };
  const response = await createPinnedHttpsTransport({ requestImpl })({ url: "https://official.example/robots.txt",
    approvedAddresses: ["93.184.216.34"] });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
});

test("robots parser follows longest matching allow or disallow rule for the named agent", () => {
  const body = `User-agent: *\nDisallow: /private\nAllow: /private/public\n\nUser-agent: OtherBot\nDisallow: /`;
  assert.equal(robotsAllows(body, "/reference", "ReiniriaLectoriaBot"), true);
  assert.equal(robotsAllows(body, "/private/item", "ReiniriaLectoriaBot"), false);
  assert.equal(robotsAllows(body, "/private/public/item", "ReiniriaLectoriaBot"), true);
});
