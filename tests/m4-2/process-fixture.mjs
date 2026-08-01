const mode = process.argv[2];
for await (const _chunk of process.stdin) { /* drain */ }
if (mode === "normal") {
  process.stdout.write('{"status":"completed"}\n');
} else if (mode === "environment") {
  process.stdout.write(`${JSON.stringify(process.env)}\n`);
} else if (mode === "large-output") {
  process.stdout.write("x".repeat(1024 * 1024));
} else {
  setInterval(() => {}, 1_000);
}
