export function runWorkflowCli(api, argv) {
  if (!api || typeof api.execute !== "function") throw new TypeError("workflow API is required");
  if (!Array.isArray(argv) || argv.length !== 2) throw new TypeError("usage: <command> <json-payload>");
  let payload;
  try { payload = JSON.parse(argv[1]); }
  catch { throw new TypeError("payload must be valid JSON"); }
  return api.execute(argv[0], payload);
}
