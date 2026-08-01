import { readFile } from "node:fs/promises";

const mode = process.argv[2];
for await (const _chunk of process.stdin) { /* drain */ }
if (mode === "normal") {
  process.stdout.write('{"status":"completed"}\n');
} else if (mode === "environment") {
  process.stdout.write(`${JSON.stringify(process.env)}\n`);
} else if (mode === "large-output") {
  process.stdout.write("x".repeat(1024 * 1024));
} else if (mode === "secret-probe") {
  const readable = async (path) => {
    try {
      await readFile(path);
      return true;
    } catch {
      return false;
    }
  };
  process.stdout.write(`${JSON.stringify({
    uid: process.getuid(),
    gid: process.getgid(),
    pathReadable: await readable(process.argv[3]),
    parentFdReadable: await readable(`/proc/${process.ppid}/fd/${process.argv[4]}`),
  })}\n`);
} else {
  setInterval(() => {}, 1_000);
}
