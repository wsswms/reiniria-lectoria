import { readFile } from "node:fs/promises";
import { ListenerConfigManager } from "../src/m1-4/config.mjs";

const root = new URL("../tests/fixtures/m1-4/", import.meta.url);
const cert = await readFile(new URL("server-cert.fixture", root), "utf8");
const key = await readFile(new URL("server-key.fixture", root), "utf8");
const mismatchKey = await readFile(new URL("mismatch-key.fixture", root), "utf8");
const good = {
  mode: "http",
  bindAddress: "127.0.0.1",
  port: 0,
  allowedHosts: ["localhost"],
  allowedOrigins: ["http://localhost"],
  trustedProxies: [],
};
const manager = new ListenerConfigManager(good);
const invalid = [
  { ...good, mode: "https-direct", cert: undefined, key },
  { ...good, mode: "https-direct", cert, key: undefined },
  { ...good, mode: "https-direct", cert, key: mismatchKey },
  { ...good, mode: "https-direct", cert: "not a certificate", key },
  { ...good, mode: "https-direct", cert, key: "not a key" },
  { ...good, bindAddress: "0.0.0.0" },
  { ...good, mode: "invalid" },
  { ...good, mode: "https-proxy", trustedProxies: [] },
  { ...good, port: 70_000 },
  { ...good, allowedHosts: [] },
];
let rejected = 0;
for (const candidate of invalid) {
  for (let index = 0; index < 10; index += 1) if (!manager.apply(candidate).applied) rejected += 1;
}
process.stdout.write(`${JSON.stringify({
  stage: "M1.4",
  modes: ["http", "https-direct", "https-proxy"],
  default_bind: good.bindAddress,
  invalid_config_attempts: invalid.length * 10,
  invalid_config_rejected: rejected,
  last_known_good_preserved: JSON.stringify(manager.current) === JSON.stringify(good),
  public_ports_published_by_test_runner: 0,
}, null, 2)}\n`);
