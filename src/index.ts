#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { Agent, EFFORTS, type Effort, type Msg } from "./agent.js";
import type { ToolDef } from "./tools.js";
import { banner, c, HELP, NAME, VERSION } from "./ui.js";

const USAGE = `${NAME} v${VERSION}

Uso:
  mak                      sessione interattiva nella cartella corrente
  mak -p "richiesta"       esegue una richiesta ed esce
  mak -c                   riprende l'ultima conversazione di questa cartella

Opzioni:
  -p, --print <testo>      modalità non interattiva
  -c, --continue           riprende l'ultima conversazione
  -m, --model <id>         modello (default: claude-opus-5-5, o $MAK_MODEL)
  -e, --effort <livello>   low | medium | high | xhigh | max (default: high)
      --yolo               approva automaticamente modifiche e comandi
      --no-web             disattiva ricerca e lettura di pagine web
  -v, --version            versione
  -h, --help               questo aiuto
`;

const INIT_PROMPT =
  "Explore this project and write a concise MAK.md at the project root: what the project is, how to build, test and run it, the layout of the code, and conventions a new contributor needs. If MAK.md already exists, improve it instead of replacing it.";

function buildSystem(root: string, web: boolean): string {
  let system = `You are ${NAME}, an AI coding agent that works in the user's terminal. You are built on Claude, made by Anthropic.

You help with software engineering: understanding code, fixing bugs, adding features, refactoring, running tests and builds. You act through tools: read_file, write_file, edit_file, glob, grep, bash, todo_write and task${web ? ", plus web_search and web_fetch for documentation and current information" : ""}. File tools are confined to the project directory; changes and commands are shown to the user for approval.

How to work:
- Read the relevant code before changing it, and match the style and conventions already there.
- Prefer edit_file for existing files; use write_file for new files.
- For work with several steps, keep a task list with todo_write so the user can follow along.
- Use task to hand a broad search or side investigation to a sub-agent when its intermediate output would only clutter this conversation.
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

/** Allow rules from .mak/settings.json: a tool name, or "bash:<command prefix>". */
function loadAllowRules(root: string): string[] {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(root, ".mak", "settings.json"), "utf8"));
    return Array.isArray(settings.allow) ? settings.allow.filter((r: unknown) => typeof r === "string") : [];
  } catch {
    return [];
  }
}

function allowedByRule(rules: string[], tool: ToolDef, input: any): boolean {
  for (const rule of rules) {
    if (rule === tool.spec.name) return true;
    if (tool.spec.name === "bash" && rule.startsWith("bash:")) {
      const prefix = rule.slice(5).trim();
      // A prefix rule must not cover a second command chained onto the first.
      if (prefix && input.command.startsWith(prefix) && !/[;&|`\n<>]|\$\(/.test(input.command)) return true;
    }
  }
  return false;
}

/** Custom slash commands: .mak/commands/<name>.md, with $ARGUMENTS replaced. */
function loadCommands(root: string): Map<string, string> {
  const commands = new Map<string, string>();
  const dir = path.join(root, ".mak", "commands");
  try {
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith(".md")) commands.set("/" + file.slice(0, -3), fs.readFileSync(path.join(dir, file), "utf8"));
    }
  } catch {
    // no custom commands
  }
  return commands;
}

/** Conversations are saved per project folder under ~/.mak/sessions. */
class SessionStore {
  private dir = path.join(os.homedir(), ".mak", "sessions");
  private key: string;
  private file: string;

  constructor(root: string) {
    this.key = createHash("sha1").update(root).digest("hex").slice(0, 12);
    this.file = path.join(this.dir, `${this.key}-${Date.now()}.json`);
  }

  save(messages: Msg[]) {
    try {
      if (!messages.length) return;
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ messages }));
    } catch {
      // saving is best-effort
    }
  }

  /** Loads the most recent other session for this folder and keeps writing to it. */
  loadLatest(): Msg[] | null {
    try {
      const files = fs
        .readdirSync(this.dir)
        .filter((f) => f.startsWith(this.key) && path.join(this.dir, f) !== this.file)
        .sort();
      const latest = files.at(-1);
      if (!latest) return null;
      const data = JSON.parse(fs.readFileSync(path.join(this.dir, latest), "utf8"));
      if (!Array.isArray(data.messages) || !data.messages.length) return null;
      this.file = path.join(this.dir, latest);
      return data.messages;
    } catch {
      return null;
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      print: { type: "string", short: "p" },
      continue: { type: "boolean", short: "c", default: false },
      model: { type: "string", short: "m" },
      effort: { type: "string", short: "e" },
      yolo: { type: "boolean", default: false },
      "no-web": { type: "boolean", default: false },
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
  const web = !values["no-web"];
  const rules = loadAllowRules(root);
  const commands = loadCommands(root);
  const store = new SessionStore(root);
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

  const approve = async (tool: ToolDef, input: unknown): Promise<boolean> => {
    if (yolo || always.has(tool.spec.name) || allowedByRule(rules, tool, input)) return true;
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
    system: buildSystem(root, web),
    web,
    approve,
  });

  const resume = (): boolean => {
    const previous = store.loadLatest();
    if (previous) agent.messages = previous;
    return !!previous;
  };
  const turn = async (text: string) => {
    await agent.runTurn(text);
    store.save(agent.messages);
  };

  if (values.continue && !resume() && interactive) console.log(c.dim("Nessuna conversazione precedente da riprendere."));

  if (!rl) {
    await turn(values.print!);
    return;
  }

  console.log(banner(agent.opts.model, root, yolo ? "automatici (yolo)" : "chiedi conferma"));
  if (agent.messages.length) console.log(c.dim("  Conversazione precedente ripresa.\n"));
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
      const space = line.search(/\s/);
      const cmd = space === -1 ? line : line.slice(0, space);
      const arg = space === -1 ? "" : line.slice(space).trim();
      if (cmd === "/exit" || cmd === "/quit") break;
      else if (cmd === "/help") {
        console.log(HELP);
        if (commands.size) console.log(`${c.bold("Comandi del progetto")}\n  ${[...commands.keys()].join("  ")}\n`);
      } else if (cmd === "/clear") {
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
      else if (cmd === "/compact") {
        const ok = await agent.compact();
        store.save(agent.messages);
        console.log(c.dim(ok ? "Conversazione riassunta: il contesto ora è più leggero." : "Niente da riassumere."));
      } else if (cmd === "/resume") {
        console.log(c.dim(resume() ? "Conversazione precedente ripresa." : "Nessuna conversazione precedente."));
      } else if (cmd === "/init") {
        await turn(INIT_PROMPT);
        agent.opts.system = buildSystem(root, web);
      } else if (commands.has(cmd)) {
        await turn(commands.get(cmd)!.replaceAll("$ARGUMENTS", arg));
      } else console.log(`Comando sconosciuto: ${cmd}. Prova /help`);
      continue;
    }

    await turn(line);
  }
  rl.close();
  console.log("Ciao!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
