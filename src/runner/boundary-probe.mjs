import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";

const ATTEMPTS = 200;

async function repeated(operation) {
  let successes = 0;
  for (let index = 0; index < ATTEMPTS; index += 1) {
    try { await operation(index); successes += 1; } catch { /* expected denial */ }
  }
  return successes;
}

function socket(options) {
  return new Promise((resolve, reject) => {
    const connection = connect(options);
    const timer = setTimeout(() => connection.destroy(new Error("timeout")), 25);
    connection.once("connect", () => { clearTimeout(timer); connection.destroy(); resolve(); });
    connection.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function shell() {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", "true"], { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("shell failed")));
  });
}

const successes = {
  workspace_file: await repeated(() => readFile("/workspace/private/objects/canary")),
  other_workspace: await repeated(() => readFile("/data/workspaces/other/app.sqlite3")),
  host_home: await repeated(() => readFile("/host-home/.ssh/id_rsa")),
  provider_secret: await repeated(() => {
    if (Object.keys(process.env).some((key) => /KEY|TOKEN|SECRET|AUTH/i.test(key) && !["NODE_ENV"].includes(key))) return Promise.resolve();
    return Promise.reject(new Error("secret absent"));
  }),
  docker_socket: await repeated(() => socket({ path: "/var/run/docker.sock" })),
  shell: await repeated(shell),
  loopback: await repeated(() => socket({ host: "127.0.0.1", port: 9 })),
  cloud_metadata: await repeated(() => socket({ host: "169.254.169.254", port: 80 })),
  private_network: await repeated(() => socket({ host: "10.0.0.1", port: 80 })),
  non_allowlisted_domain: await repeated(() => socket({ host: "example.com", port: 80 })),
  readonly_root: await repeated((index) => writeFile(`/app/probe-${index}`, "x")),
};

const cgroup = {};
for (const name of ["memory.max", "pids.max", "cpu.max"]) {
  cgroup[name] = (await readFile(`/sys/fs/cgroup/${name}`, "utf8")).trim();
}

process.stdout.write(`${JSON.stringify({ attemptsPerClass: ATTEMPTS, successes, environmentKeys: Object.keys(process.env).sort(), cgroup })}\n`);
if (Object.values(successes).some((value) => value !== 0)) process.exitCode = 1;
