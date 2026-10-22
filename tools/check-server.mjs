// Smoke-check the diff-ask MCP server over real stdio (no app needed):
// initialize → resources/list → tools/call get_diff → resources/read
// diff://workspace → resources/subscribe, then print a verdict.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "diff-ask",
  "server",
  "server.mjs",
);
const WS = process.argv[2] ?? "/Users/lattenero/Projects/bot";

const child = spawn("node", [SERVER], {
  env: { ...process.env, ZCODE_WORKSPACE_ROOT: WS },
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const pending = new Map();
let nextId = 1;
child.stdout.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      // partial line — wait for more
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

const fail = (m) => {
  console.error(`FAIL: ${m}`);
  child.kill();
  process.exit(1);
};

const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "check", version: "0" },
});
if (init.serverInfo?.name !== "diff-ask") fail("initialize returned wrong serverInfo");
if (!init.capabilities?.resources?.subscribe) fail("resources.subscribe capability missing");
console.log("✓ initialize:", init.serverInfo.name, init.serverInfo.version);

const list = await rpc("resources/list", {});
const uris = list.resources.map((r) => r.uri);
if (!uris.includes("ui://diff-ask/panel.html")) fail("panel resource missing from list");
if (!uris.includes("diff://workspace")) fail("diff resource missing from list");
console.log("✓ resources/list:", uris.join(", "));

const tool = await rpc("tools/call", { name: "get_diff", arguments: {} });
const data = tool.structuredContent;
if (!data) fail("get_diff has no structuredContent");
if (data.error) {
  console.log("ℹ get_diff:", data.message);
} else {
  if (!Array.isArray(data.files)) fail("get_diff files is not an array");
  const withPatch = data.files.filter((f) => f.patch);
  console.log(`✓ get_diff: branch=${data.branch} head=${data.head} files=${data.fileCount} withPatch=${withPatch.length}`);
}

const read = await rpc("resources/read", { uri: "diff://workspace" });
const parsed = JSON.parse(read.contents[0].text);
if (parsed.workspace !== WS) fail("diff://workspace returned a different workspace");
console.log(`✓ resources/read diff://workspace (dirty=${parsed.dirty})`);

await rpc("resources/subscribe", { uri: "diff://workspace" });
console.log("✓ resources/subscribe accepted");

child.stdin.end();
setTimeout(() => {
  console.log("PASS — server contract OK");
  child.kill();
  process.exit(0);
}, 300);
