import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import net from "node:net";
import test from "node:test";

async function cannotAccess(path) {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

function cannotConnect(host, port = 80) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (blocked) => {
      socket.destroy();
      resolve(blocked);
    };
    socket.setTimeout(500, () => finish(true));
    socket.once("error", () => finish(true));
    socket.once("connect", () => finish(false));
  });
}

test("container exposes no host cwd, pi home, workspace mount or Docker socket", async () => {
  const paths = ["/host-workspace", "/workspace-host-marker", "/var/run/docker.sock", "/root/.pi", "/home/node/.pi"];
  for (const path of paths) assert.equal(await cannotAccess(path), true, path);
});

test("network-none blocks loopback, private, metadata and public targets", async () => {
  const targets = ["127.0.0.1", "10.0.0.1", "169.254.169.254", "1.1.1.1"];
  for (const host of targets) assert.equal(await cannotConnect(host), true, host);
});
