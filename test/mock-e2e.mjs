// End-to-end check against a fake Messages API: the agent must stream a reply,
// run the requested tools, send the results back, and enforce its guards.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "mak-test-"));

const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
};
const usage = { input_tokens: 10, output_tokens: 5 };
const start = { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "mock", content: [], stop_reason: null, stop_sequence: null, usage } };
const stop = (reason) => [
  { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
];
const toolCall = (index, id, name, input) => {
  const json = JSON.stringify(input);
  const mid = Math.floor(json.length / 2);
  return [
    { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } },
    { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(0, mid) } },
    { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(mid) } },
    { type: "content_block_stop", index },
  ];
};

const requests = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    requests.push(JSON.parse(body));
    if (requests.length === 1) {
      sse(res, [
        start,
        ...toolCall(0, "tu_1", "write_file", { path: "hello.txt", content: "ciao\n" }),
        ...toolCall(1, "tu_2", "bash", { command: "cat hello.txt" }),
        ...toolCall(2, "tu_3", "write_file", { path: "../escape.txt", content: "x" }),
        ...toolCall(3, "tu_4", "edit_file", { path: "hello.txt" }),
        ...stop("tool_use"),
      ]);
    } else {
      sse(res, [
        start,
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Fatto tutto." } },
        { type: "content_block_stop", index: 0 },
        ...stop("end_turn"),
      ]);
    }
  });
});

const run = (args, stdin) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: work,
      env: { ...process.env, ANTHROPIC_API_KEY: "test", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}` },
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });

server.listen(0, "127.0.0.1", async () => {
  try {
    // 1. With --yolo the tools run and their results go back to the model.
    const a = await run(["-p", "crea hello.txt", "--yolo"]);
    assert.equal(a.code, 0, a.out);
    assert.match(a.out, /Fatto tutto\./);
    assert.equal(fs.readFileSync(path.join(work, "hello.txt"), "utf8"), "ciao\n");
    assert.ok(!fs.existsSync(path.join(work, "..", "escape.txt")), "path escape was not blocked");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].model, "claude-opus-5-5");
    assert.equal(requests[0].tools.length, 6);
    const results = requests[1].messages.at(-1).content;
    assert.deepEqual(results.map((r) => r.tool_use_id), ["tu_1", "tu_2", "tu_3", "tu_4"]);
    assert.ok(!results[0].is_error);
    assert.match(results[1].content, /ciao[\s\S]*exit code: 0/);
    assert.ok(results[2].is_error && /outside the project/.test(results[2].content));
    assert.ok(results[3].is_error && /INVALID_JSON/.test(results[3].content));

    // 2. Without --yolo, non-interactive mode denies anything that changes state.
    requests.length = 0;
    fs.rmSync(path.join(work, "hello.txt"));
    const b = await run(["-p", "crea hello.txt"]);
    assert.equal(b.code, 0, b.out);
    assert.ok(!fs.existsSync(path.join(work, "hello.txt")), "write ran without approval");
    assert.ok(requests[1].messages.at(-1).content.every((r) => r.is_error));

    // 3. Interactive: answers to the permission prompt decide what runs.
    requests.length = 0;
    const d = await run([], "crea hello.txt\ns\nn\ns\n/cost\n/exit\n");
    assert.equal(d.code, 0, d.out);
    assert.match(d.out, /MAK VIBE CODING/);
    assert.match(d.out, /Fatto tutto\./);
    assert.match(d.out, /Costo stimato/);
    assert.ok(fs.existsSync(path.join(work, "hello.txt")), "approved write did not run");
    const r = requests[1].messages.at(-1).content;
    assert.ok(!r[0].is_error, "approved tool reported an error");
    assert.match(r[1].content, /denied permission/);

    console.log("mock e2e: OK");
  } finally {
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
});
