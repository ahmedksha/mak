import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { Session, type Answer, type SessionOptions } from "./session.js";
import type { Sink } from "./sink.js";
import { c, NAME } from "./ui.js";

type Event = { type: string; [key: string]: unknown };

/** Commands that only change a setting, so they are safe while a turn is running. */
const SETTING = /^\/(yolo|model|effort|cost|help)(\s|$)/;
const stripAnsi = (s: string) => s.replace(/\x1b\[\d+m/g, "");

/**
 * Serves the browser UI on this computer only. Every request must carry the
 * random token printed at startup, so other programs and web pages can't
 * drive the agent.
 */
export async function startWeb(options: SessionOptions, port: number, open: boolean): Promise<void> {
  const token = randomBytes(16).toString("hex");
  const page = fs.readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
  const clients = new Set<http.ServerResponse>();
  const pending = new Map<string, (answer: Answer) => void>();
  let log: Event[] = [];
  let busy = false;

  const emit = (event: Event) => {
    log.push(event);
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(data);
  };

  const sink: Sink = {
    text: (delta) => emit({ type: "text", delta }),
    thinking: (delta) => emit({ type: "thinking", delta }),
    messageEnd: () => emit({ type: "message_end" }),
    toolStart: (e) => emit({ type: "tool_start", ...e }),
    toolEnd: (e) => emit({ type: "tool_end", ...e, output: e.output.slice(0, 20_000) }),
    say: (text) => emit({ type: "notice", level: "say", text: stripAnsi(text) }),
    info: (text) => emit({ type: "notice", level: "info", text }),
    warn: (text) => emit({ type: "notice", level: "warn", text }),
    error: (text) => emit({ type: "notice", level: "error", text }),
  };

  const session = new Session(options, {
    sink,
    interactive: true,
    confirm(id, tool) {
      emit({ type: "approval", id, tool });
      return new Promise((resolve) => pending.set(id, resolve));
    },
  });
  const answer = (id: string, value: Answer) => {
    const resolve = pending.get(id);
    if (!resolve) return false;
    pending.delete(id);
    emit({ type: "approval_done", id, answer: value });
    resolve(value);
    return true;
  };
  const sendState = () => emit({ type: "state", busy, ...session.state() });

  const handleInput = async (text: string, silent: boolean): Promise<number> => {
    if (SETTING.test(text)) {
      await session.input(text);
      sendState();
      return 200;
    }
    if (busy) return 409;
    if (/^\/(exit|quit)(\s|$)/.test(text)) {
      sink.info("Per chiudere MAK VIBE CODING premi Ctrl+C nel terminale da cui l'hai avviato.");
      return 200;
    }
    busy = true;
    if (!silent) emit({ type: "user", text });
    sendState();
    void session
      .input(text)
      .catch((err) => sink.error(String(err)))
      .finally(() => {
        busy = false;
        if (/^\/clear(\s|$)/.test(text)) {
          log = [];
          emit({ type: "reset" });
        }
        sendState();
      });
    return 202;
  };

  const tokenOk = (given: unknown) =>
    typeof given === "string" && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));

  const server = http.createServer(async (req, res) => {
    const reply = (status: number, body = "") => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
    };
    try {
      const address = server.address() as { port: number };
      // Reject requests addressed to another name: blocks DNS-rebinding from a web page.
      const host = req.headers.host ?? "";
      if (host !== `127.0.0.1:${address.port}` && host !== `localhost:${address.port}`) return reply(403);
      const url = new URL(req.url ?? "/", `http://${host}`);

      if (req.method === "GET") {
        if (!tokenOk(url.searchParams.get("t"))) return reply(403, "Link non valido: usa quello mostrato nel terminale.");
        if (url.pathname === "/") {
          const nonce = randomBytes(12).toString("base64");
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
            "content-security-policy": `default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
          });
          return void res.end(page.replaceAll("__NONCE__", nonce).replace("__TOKEN__", token));
        }
        if (url.pathname === "/events") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            connection: "keep-alive",
          });
          res.write(`data: ${JSON.stringify({ type: "reset" })}\n\n`);
          for (const event of log) res.write(`data: ${JSON.stringify(event)}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "state", busy, ...session.state() })}\n\n`);
          for (const id of pending.keys()) res.write(`data: ${JSON.stringify({ type: "approval", id })}\n\n`);
          clients.add(res);
          req.on("close", () => clients.delete(res));
          return;
        }
        return reply(404);
      }

      if (req.method !== "POST") return reply(405);
      // A custom header can't be sent cross-site without a preflight we never grant.
      if (!tokenOk(req.headers["x-mak-token"])) return reply(403);
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 1_000_000) return reply(413);
      }
      const body = raw ? JSON.parse(raw) : {};

      if (url.pathname === "/api/input") {
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) return reply(400);
        return reply(await handleInput(text, body.silent === true));
      }
      if (url.pathname === "/api/approve") {
        const value: Answer = body.answer === "yes" || body.answer === "always" ? body.answer : "no";
        return reply(answer(String(body.id), value) ? 200 : 404);
      }
      if (url.pathname === "/api/interrupt") {
        for (const id of [...pending.keys()]) answer(id, "no");
        session.interrupt();
        return reply(200);
      }
      return reply(404);
    } catch {
      reply(400);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  }).catch((err: NodeJS.ErrnoException) => {
    console.error(
      err.code === "EADDRINUSE" ? `La porta ${port} è occupata. Scegline un'altra con --port.` : `Errore: ${err.message}`,
    );
    process.exit(1);
  });

  const link = `http://127.0.0.1:${(server.address() as { port: number }).port}/?t=${token}`;
  if (session.resumed) sink.info("Conversazione precedente ripresa.");
  console.log(`\n${c.bold(NAME)} è in ascolto solo su questo computer.\n\n  ${c.cyan(link)}\n`);
  console.log(c.dim("Apri il link nel browser. Ctrl+C per chiudere.\n"));
  if (open) {
    const [cmd, args] =
      process.platform === "darwin"
        ? ["open", [link]]
        : process.platform === "win32"
          ? ["cmd", ["/c", "start", "", link]]
          : ["xdg-open", [link]];
    spawn(cmd, args as string[], { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  }
}
