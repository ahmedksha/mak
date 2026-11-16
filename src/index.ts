#!/usr/bin/env node
import readline from "node:readline";
import { parseArgs } from "node:util";
import { EFFORTS, type Effort } from "./agent.js";
import { Session, type Answer } from "./session.js";
import { TerminalSink } from "./terminal.js";
import { banner, c, NAME, VERSION } from "./ui.js";
import { startWeb } from "./web.js";

const USAGE = `${NAME} v${VERSION}

Uso:
  mak                      sessione interattiva nella cartella corrente
  mak --ui                 interfaccia grafica nel browser
  mak -p "richiesta"       esegue una richiesta ed esce
  mak -c                   riprende l'ultima conversazione di questa cartella

Opzioni:
  -p, --print <testo>      modalità non interattiva
  -c, --continue           riprende l'ultima conversazione
  -m, --model <id>         modello (default: claude-opus-5-5, o $MAK_MODEL)
  -e, --effort <livello>   low | medium | high | xhigh | max (default: high)
      --yolo               approva automaticamente modifiche e comandi
      --no-web             disattiva ricerca e lettura di pagine web
      --ui                 apre l'interfaccia grafica (solo su questo computer)
      --port <numero>      porta per --ui (default: 4625)
      --no-open            con --ui, non aprire il browser da solo
  -v, --version            versione
  -h, --help               questo aiuto
`;

async function main() {
  const { values } = parseArgs({
    options: {
      print: { type: "string", short: "p" },
      continue: { type: "boolean", short: "c", default: false },
      model: { type: "string", short: "m" },
      effort: { type: "string", short: "e" },
      yolo: { type: "boolean", default: false },
      "no-web": { type: "boolean", default: false },
      ui: { type: "boolean", default: false },
      port: { type: "string" },
      "no-open": { type: "boolean", default: false },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return void console.log(USAGE);
  if (values.version) return void console.log(VERSION);

  const effort = (values.effort ?? "high") as Effort;
  if (!EFFORTS.includes(effort)) {
    console.error(`Livello non valido: ${values.effort}. Usa uno tra: ${EFFORTS.join(", ")}`);
    process.exit(2);
  }
  const options = {
    root: process.cwd(),
    model: values.model ?? process.env.MAK_MODEL ?? "claude-opus-5-5",
    effort,
    web: !values["no-web"],
    yolo: values.yolo,
    resume: values.continue,
  };

  if (values.ui) {
    const port = values.port === undefined ? 4625 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error(`Porta non valida: ${values.port}`);
      process.exit(2);
    }
    await startWeb({ ...options, surface: "web" }, port, !values["no-open"]);
    return;
  }

  const interactive = values.print === undefined;
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;

  // Lines are queued so none are lost when input arrives faster than it is
  // read (piped stdin, pasted text). ask() resolves null once stdin closes.
  const queue: string[] = [];
  let waiter: ((line: string | null) => void) | null = null;
  let closed = false;
  rl?.on("line", (line) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(line);
    } else queue.push(line);
  });
  rl?.on("close", () => {
    closed = true;
    waiter?.(null);
  });
  const ask = (prompt: string): Promise<string | null> => {
    process.stdout.write(prompt);
    if (queue.length) return Promise.resolve(queue.shift()!);
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => (waiter = resolve));
  };

  const session = new Session(
    { ...options, surface: "terminal" },
    {
      sink: new TerminalSink(),
      interactive,
      async confirm(): Promise<Answer> {
        const answer = ((await ask(c.yellow("  Consentire? [s]ì / [n]o / [t] sempre per questo strumento: "))) ?? "")
          .trim()
          .toLowerCase();
        if (answer.startsWith("t") || answer === "a") return "always";
        return answer.startsWith("s") || answer.startsWith("y") ? "yes" : "no";
      },
    },
  );

  if (!rl) {
    await session.input(values.print!);
    return;
  }

  console.log(banner(options.model, options.root, options.yolo ? "automatici (yolo)" : "chiedi conferma"));
  if (session.resumed) console.log(c.dim("  Conversazione precedente ripresa.\n"));
  else if (values.continue) console.log(c.dim("  Nessuna conversazione precedente da riprendere.\n"));
  rl.on("SIGINT", () => {
    if (!session.interrupt()) {
      console.log("\nCiao!");
      process.exit(0);
    }
  });

  for (;;) {
    const raw = await ask(c.magenta("\n› "));
    if (raw === null) break; // stdin closed
    const line = raw.trim();
    if (line && !(await session.input(line))) break;
  }
  rl.close();
  console.log("Ciao!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
