// A stand-in MCP server for the end-to-end tests: newline-delimited JSON-RPC
// on stdio, a few tools that exercise what the bridge maps.
//   whoami  → pid, how many `initialize` it has seen, its argv, env and cwd
//   save    → asks the client for roots, writes a file under the first root's
//             out/, and names it the way playwright-mcp does (relative)
//   read    → the contents of arguments.paths[0]
//   write   → writes "SAVED" to arguments.filePath and names it (absolute)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let inits = 0;
let initParams;
let nextId = 1;
const waiting = new Map();
let buf = "";
let saved = 0;

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const ask = (method) =>
  new Promise((resolve) => {
    const id = `srv-${nextId++}`;
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method });
  });
const text = (t) => ({ content: [{ type: "text", text: t }] });

async function call(name, args) {
  switch (name) {
    case "whoami":
      return text(
        JSON.stringify({
          pid: process.pid,
          inits,
          initParams,
          argv: process.argv.slice(2),
          cwd: process.cwd(),
          env: { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH, TMPDIR: process.env.TMPDIR },
        }),
      );
    case "save": {
      const { roots } = await ask("roots/list");
      const root = fileURLToPath(roots[0].uri);
      mkdirSync(join(root, "out"), { recursive: true });
      const rel = `out/shot-${++saved}.png`;
      writeFileSync(join(root, rel), "PNG-BYTES");
      return text(`- [Screenshot of viewport](${rel})`);
    }
    case "read":
      return text(readFileSync(args.paths[0], "utf8"));
    case "write":
      writeFileSync(args.filePath, "SAVED");
      return text(`Saved to ${args.filePath}`);
    default:
      throw new Error(`no tool ${name}`);
  }
}

process.stdin.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === undefined && waiting.has(m.id)) {
      waiting.get(m.id)(m.result);
      waiting.delete(m.id);
      continue;
    }
    if (m.method === "initialize") {
      inits++;
      initParams = m.params;
      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
    } else if (m.method === "tools/call") {
      call(m.params.name, m.params.arguments ?? {}).then(
        (result) => send({ jsonrpc: "2.0", id: m.id, result }),
        (err) => send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: String(err.message ?? err) } }),
      );
    } else if (m.id !== undefined) {
      send({ jsonrpc: "2.0", id: m.id, result: {} });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
