#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { Agent, EFFORTS, type Effort } from "./agent.js";
import type { ToolDef } from "./tools.js";
import { banner, c, HELP, NAME, VERSION } from "./ui.js";

const USAGE = `${NAME} v${VERSION}

Uso:
  mak                      sessione interattiva nella cartella corrente
  mak -p "richiesta"       esegue una richiesta ed esce

Opzioni:
  -p, --print <testo>      modalità non interattiva
  -m, --model <id>         modello (default: claude-opus-5-5, o $MAK_MODEL)
  -e, --effort <livello>   low | medium | high | xhigh | max (default: high)
      --yolo               approva automaticamente modifiche e comandi
  -v, --version            versione
  -h, --help               questo aiuto
`;

const INIT_PROMPT =
  "Explore this project and write a concise MAK.md at the project root: what the project is, how to build, test and run it, the layout of the code, and conventions a new contributor needs. If MAK.md already exists, improve it instead of replacing it.";

function buildSystem(root: string): string {
  let system = `You are ${NAME}, an AI coding agent that works in the user's terminal. You are built on Claude, made by Anthropic.

You help with software engineering: understanding code, fixing bugs, adding features, refactoring, running tests and builds. You act through tools: read_file, write_file, edit_file, glob, grep and bash. File tools are confined to the project directory; changes and commands are shown to the user for approval.

How to work:
- Read the relevant code before changing it, and match the style and conventions already there.
- Prefer edit_file for existing files; use write_file for new files.
- After a change, verify it when there is a way to (run the tests, the build, or the code itself) and report what actually happened.
- Keep changes scoped to what was asked. Ask before anything destructive or hard to undo.
- If the user denies a tool call, do not retry it; ask how they want to proceed.
- Reply in the language the user writes in. Output goes to a plain terminal, so keep answers short and skip heavy markdown.

Environment:
- Project directory: ${root}
- Platform: ${process.platform}`;
  try {
    const memory = fs.readFileSync(path.join(root, "MAK.md"), "utf8").trim();
    if (memory) system += `\n\nProject instructions from MAK.md:\n\n${memory}`;
  } catch {
    // no MAK.md
  }
  return system;
}

async function main() {
  const { values } = parseArgs({
    options: {
      print: { type: "string", short: "p" },
      model: { type: "string", short: "m" },
      effort: { type: "string", short: "e" },
      yolo: { type: "boolean", default: false },
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

  const root = process.cwd();
  let yolo = values.yolo;
  const always = new Set<string>();
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

  const approve = async (tool: ToolDef): Promise<boolean> => {
    if (yolo || always.has(tool.spec.name)) return true;
    if (!rl) return false; // non-interactive: nobody to ask
    const answer = ((await ask(c.yellow("  Consentire? [s]ì / [n]o / [t] sempre per questo strumento: "))) ?? "")
      .trim()
      .toLowerCase();
    if (answer.startsWith("t") || answer === "a") {
      always.add(tool.spec.name);
      return true;
    }
    return answer.startsWith("s") || answer.startsWith("y");
  };

  const agent = new Agent({
    model: values.model ?? process.env.MAK_MODEL ?? "claude-opus-5-5",
    effort,
    root,
    system: buildSystem(root),
    approve,
  });

  if (!rl) {
    await agent.runTurn(values.print!);
    return;
  }

  console.log(banner(agent.opts.model, root, yolo ? "automatici (yolo)" : "chiedi conferma"));
  rl.on("SIGINT", () => {
    if (!agent.interrupt()) {
      console.log("\nCiao!");
      process.exit(0);
    }
  });

  for (;;) {
    const raw = await ask(c.magenta("\n› "));
    if (raw === null) break; // stdin closed
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("/")) {
      const [cmd, arg] = line.split(/\s+/, 2);
      if (cmd === "/exit" || cmd === "/quit") break;
      else if (cmd === "/help") console.log(HELP);
      else if (cmd === "/clear") {
        agent.clear();
        console.log(c.dim("Conversazione azzerata."));
      } else if (cmd === "/model") {
        if (arg) agent.opts.model = arg;
        console.log(c.dim(`Modello: ${agent.opts.model}`));
      } else if (cmd === "/effort") {
        if (arg && !EFFORTS.includes(arg as Effort)) console.log(`Usa uno tra: ${EFFORTS.join(", ")}`);
        else {
          if (arg) agent.opts.effort = arg as Effort;
          console.log(c.dim(`Impegno: ${agent.opts.effort}`));
        }
      } else if (cmd === "/yolo") {
        yolo = !yolo;
        console.log(c.dim(`Approvazione automatica: ${yolo ? "attiva" : "disattivata"}`));
      } else if (cmd === "/cost") console.log(agent.costSummary());
      else if (cmd === "/init") {
        await agent.runTurn(INIT_PROMPT);
        agent.opts.system = buildSystem(root);
      } else console.log(`Comando sconosciuto: ${cmd}. Prova /help`);
      continue;
    }

    await agent.runTurn(line);
  }
  rl.close();
  console.log("Ciao!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
