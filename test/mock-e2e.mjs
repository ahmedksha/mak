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
const home = fs.mkdtempSync(path.join(os.tmpdir(), "mak-home-"));

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
const say = (text) => [
  start,
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  ...stop("end_turn"),
];

// The fake model picks its reply from the last message it was sent.
const requests = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const request = JSON.parse(body);
    requests.push(request);
    const last = request.messages.at(-1).content;
    if (Array.isArray(last)) return sse(res, say("Fatto tutto."));
    if (last.startsWith("Do not call any tools")) return sse(res, say("RIASSUNTO"));
    if (last.includes("conta i file")) return sse(res, say("Rapporto: 3 file."));
    if (last.includes("delega")) {
      return sse(res, [start, ...toolCall(0, "tu_9", "task", { description: "Conta file", prompt: "conta i file" }), ...stop("tool_use")]);
    }
    if (last.includes("test")) {
      return sse(res, [
        start,
        ...toolCall(0, "tu_5", "bash", { command: "echo test ok" }),
        ...toolCall(1, "tu_6", "bash", { command: "echo test; touch pwned.txt" }),
        ...toolCall(2, "tu_7", "todo_write", { todos: [{ content: "uno", status: "completed" }] }),
        ...stop("tool_use"),
      ]);
    }
    sse(res, [
      start,
      ...toolCall(0, "tu_1", "write_file", { path: "hello.txt", content: "ciao\n" }),
      ...toolCall(1, "tu_2", "bash", { command: "cat hello.txt" }),
      ...toolCall(2, "tu_3", "write_file", { path: "../escape.txt", content: "x" }),
      ...toolCall(3, "tu_4", "edit_file", { path: "hello.txt" }),
      ...stop("tool_use"),
    ]);
  });
});

const run = (args, stdin) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: work,
      env: { ...process.env, HOME: home, ANTHROPIC_API_KEY: "test", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}` },
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
const lastResults = () => requests.at(-1).messages.at(-1).content;

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
    assert.deepEqual(
      requests[0].tools.map((t) => t.name),
      ["read_file", "write_file", "edit_file", "bash", "glob", "grep", "todo_write", "task", "web_search", "web_fetch"],
    );
    let results = lastResults();
    assert.deepEqual(results.map((r) => r.tool_use_id), ["tu_1", "tu_2", "tu_3", "tu_4"]);
    assert.ok(!results[0].is_error);
    assert.match(results[1].content, /ciao[\s\S]*exit code: 0/);
    assert.ok(results[2].is_error && /outside the project/.test(results[2].content));
    assert.ok(results[3].is_error && /INVALID_JSON/.test(results[3].content));

    // 2. --continue resumes the saved conversation; --no-web drops the web tools.
    requests.length = 0;
    const b = await run(["-p", "delega", "-c", "--no-web"]);
    assert.equal(b.code, 0, b.out);
    assert.ok(requests[0].messages.length >= 4, "previous conversation was not resumed");
    assert.equal(requests[0].tools.length, 8);
    // ...and the task tool runs a sub-agent with a fresh context and no task tool.
    const sub = requests.find((r) => r.messages[0].content === "conta i file");
    assert.ok(sub, "sub-agent was not started");
    assert.ok(!sub.tools.some((t) => t.name === "task"));
    assert.match(lastResults()[0].content, /Rapporto: 3 file\./);

    // 3. Without --yolo, non-interactive mode denies anything that changes state,
    //    except what .mak/settings.json allows. A chained command is not covered.
    requests.length = 0;
    fs.rmSync(path.join(work, "hello.txt"));
    const d = await run(["-p", "crea hello.txt"]);
    assert.equal(d.code, 0, d.out);
    assert.ok(!fs.existsSync(path.join(work, "hello.txt")), "write ran without approval");
    assert.ok(lastResults().every((r) => r.is_error));

    fs.mkdirSync(path.join(work, ".mak", "commands"), { recursive: true });
    fs.writeFileSync(path.join(work, ".mak", "settings.json"), JSON.stringify({ allow: ["bash:echo test"] }));
    fs.writeFileSync(path.join(work, ".mak", "commands", "prova.md"), "esegui i test su $ARGUMENTS");
    requests.length = 0;
    const e = await run(["-p", "lancia i test"]);
    assert.equal(e.code, 0, e.out);
    results = lastResults();
    assert.match(results[0].content, /test ok/);
    assert.ok(results[1].is_error, "chained command slipped through a prefix rule");
    assert.ok(!fs.existsSync(path.join(work, "pwned.txt")));
    assert.match(results[2].content, /☑ uno/);

    // 4. Interactive: permission answers, custom commands, /compact, /cost.
    requests.length = 0;
    const f = await run([], "crea hello.txt\ns\nn\ns\n/compact\n/prova auth\nn\n/cost\n/exit\n");
    assert.equal(f.code, 0, f.out);
    assert.match(f.out, /MAK VIBE CODING/);
    assert.match(f.out, /Fatto tutto\./);
    assert.match(f.out, /Conversazione riassunta/);
    assert.match(f.out, /Costo stimato/);
    assert.ok(fs.existsSync(path.join(work, "hello.txt")), "approved write did not run");
    const first = requests[1].messages.at(-1).content;
    assert.ok(!first[0].is_error, "approved tool reported an error");
    assert.match(first[1].content, /denied permission/);
    const custom = requests.find((r) => r.messages.at(-1).content === "esegui i test su auth");
    assert.ok(custom, "custom command was not expanded");
    assert.match(custom.messages[0].content, /RIASSUNTO/);
    assert.equal(custom.messages.length, 2, "history was not replaced by the summary");

    // 5. Browser UI: token-protected local server, live events, approval from the page.
    requests.length = 0;
    fs.rmSync(path.join(work, "hello.txt"));
    fs.rmSync(path.join(work, ".mak"), { recursive: true });
    const ui = spawn(process.execPath, [cli, "--ui", "--port", "0", "--no-open", "--no-web"], {
      cwd: work,
      env: { ...process.env, HOME: home, ANTHROPIC_API_KEY: "test", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}` },
    });
    try {
      const link = await new Promise((resolve, reject) => {
        let out = "";
        ui.stdout.on("data", (d) => {
          out += d;
          const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+/);
          if (m) resolve(new URL(m[0]));
        });
        ui.on("close", () => reject(new Error("UI server exited: " + out)));
      });
      const t = link.searchParams.get("t");
      const api = (p, body, token = t) =>
        fetch(link.origin + p, { method: "POST", headers: { "content-type": "application/json", "x-mak-token": token }, body: JSON.stringify(body) });

      assert.equal((await fetch(link.origin + "/")).status, 403, "page served without the token");
      assert.equal((await fetch(link.origin + "/?t=" + "0".repeat(32))).status, 403);
      assert.equal((await api("/api/input", { text: "ciao" }, "wrong")).status, 403, "API accepted a bad token");
      const page = await fetch(link);
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-security-policy"), /script-src 'nonce-/);
      assert.match(await page.text(), /MAK VIBE CODING/);

      const events = [];
      const stream = await fetch(link.origin + "/events?t=" + t);
      (async () => {
        let buffer = "";
        for await (const chunk of stream.body) {
          buffer += Buffer.from(chunk).toString();
          let cut;
          while ((cut = buffer.indexOf("\n\n")) !== -1) {
            events.push(JSON.parse(buffer.slice(6, cut)));
            buffer = buffer.slice(cut + 2);
          }
        }
      })().catch(() => {});
      const seen = async (test) => {
        for (let i = 0; i < 200; i++) {
          const hit = events.findLast(test);
          if (hit) return hit;
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error("event not received; got: " + events.map((e) => e.type).join(","));
      };

      assert.equal((await api("/api/input", { text: "crea hello.txt" })).status, 202);
      assert.equal((await api("/api/input", { text: "altra richiesta" })).status, 409, "second turn accepted while busy");
      assert.equal((await api("/api/input", { text: "/effort low", silent: true })).status, 200);
      const ask1 = await seen((e) => e.type === "approval" && e.id === "tu_1");
      assert.ok(events.find((e) => e.type === "tool_start" && e.id === "tu_1").detail.includes("+ ciao"));
      assert.equal((await api("/api/approve", { id: ask1.id, answer: "yes" })).status, 200);
      const ask2 = await seen((e) => e.type === "approval" && e.id === "tu_2");
      assert.equal((await api("/api/approve", { id: ask2.id, answer: "no" })).status, 200);
      const ask3 = await seen((e) => e.type === "approval" && e.id === "tu_3");
      assert.equal((await api("/api/approve", { id: ask3.id, answer: "yes" })).status, 200);
      await seen((e) => e.type === "text" && e.delta === "Fatto tutto.");
      const idle = await seen((e) => e.type === "state" && e.busy === false && events.some((x) => x.type === "text"));
      assert.equal(idle.effort, "low");
      assert.ok(fs.existsSync(path.join(work, "hello.txt")), "approved write did not run from the UI");
      assert.equal(events.find((e) => e.type === "tool_end" && e.id === "tu_2").status, "denied");
      assert.equal(events.find((e) => e.type === "tool_end" && e.id === "tu_3").status, "error");
      assert.ok(!fs.existsSync(path.join(work, "..", "escape.txt")));
    } finally {
      ui.kill();
    }

    console.log("mock e2e: OK");
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
