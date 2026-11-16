import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent, EFFORTS, type Effort, type Msg } from "./agent.js";
import type { Sink } from "./sink.js";
import type { ToolDef } from "./tools.js";
import { HELP, NAME, VERSION } from "./ui.js";

const INIT_PROMPT =
  "Explore this project and write a concise MAK.md at the project root: what the project is, how to build, test and run it, the layout of the code, and conventions a new contributor needs. If MAK.md already exists, improve it instead of replacing it.";

export type Surface = "terminal" | "web";
export type Answer = "yes" | "no" | "always";

/** The terminal or the browser UI: where output goes and who answers permission prompts. */
export interface Frontend {
  sink: Sink;
  /** False when nobody can answer a prompt (one-shot mode): unapproved actions are denied. */
  interactive: boolean;
  confirm(id: string, tool: string): Promise<Answer>;
}

export interface SessionOptions {
  root: string;
  model: string;
  effort: Effort;
  web: boolean;
  yolo: boolean;
  resume: boolean;
  surface: Surface;
}

function buildSystem(root: string, web: boolean, surface: Surface): string {
  const output =
    surface === "web"
      ? "Output is shown in a chat window that renders basic Markdown (bold, inline code, fenced code blocks, lists). Keep answers short."
      : "Output goes to a plain terminal, so keep answers short and skip heavy markdown.";
  let system = `You are ${NAME}, an AI coding agent that works on the user's computer. You are built on Claude, made by Anthropic.

You help with software engineering: understanding code, fixing bugs, adding features, refactoring, running tests and builds. You act through tools: read_file, write_file, edit_file, glob, grep, bash, todo_write and task${web ? ", plus web_search and web_fetch for documentation and current information" : ""}. File tools are confined to the project directory; changes and commands are shown to the user for approval.

How to work:
- Read the relevant code before changing it, and match the style and conventions already there.
- Prefer edit_file for existing files; use write_file for new files.
- For work with several steps, keep a task list with todo_write so the user can follow along.
- Use task to hand a broad search or side investigation to a sub-agent when its intermediate output would only clutter this conversation.
- After a change, verify it when there is a way to (run the tests, the build, or the code itself) and report what actually happened.
- Keep changes scoped to what was asked. Ask before anything destructive or hard to undo.
- If the user denies a tool call, do not retry it; ask how they want to proceed.
- Reply in the language the user writes in. ${output}

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

/** One conversation: the agent plus slash commands, permissions and saving. */
export class Session {
  readonly agent: Agent;
  readonly commands: Map<string, string>;
  readonly resumed: boolean;
  yolo: boolean;
  private always = new Set<string>();
  private rules: string[];
  private store: SessionStore;

  constructor(
    private opts: SessionOptions,
    private frontend: Frontend,
  ) {
    this.yolo = opts.yolo;
    this.rules = loadAllowRules(opts.root);
    this.commands = loadCommands(opts.root);
    this.store = new SessionStore(opts.root);
    this.agent = new Agent({
      model: opts.model,
      effort: opts.effort,
      root: opts.root,
      system: buildSystem(opts.root, opts.web, opts.surface),
      web: opts.web,
      sink: frontend.sink,
      approve: (tool, input, id) => this.approve(tool, input, id),
    });
    this.resumed = opts.resume && this.resume();
  }

  state() {
    return {
      name: NAME,
      version: VERSION,
      root: this.opts.root,
      model: this.agent.opts.model,
      effort: this.agent.opts.effort,
      yolo: this.yolo,
      web: this.opts.web,
      cost: this.agent.costSummary(),
      commands: [...this.commands.keys()],
    };
  }

  interrupt(): boolean {
    return this.agent.interrupt();
  }

  private resume(): boolean {
    const previous = this.store.loadLatest();
    if (previous) this.agent.messages = previous;
    return !!previous;
  }

  private async approve(tool: ToolDef, input: unknown, id: string): Promise<boolean> {
    if (this.yolo || this.always.has(tool.spec.name) || allowedByRule(this.rules, tool, input)) return true;
    if (!this.frontend.interactive) return false;
    const answer = await this.frontend.confirm(id, tool.spec.name);
    if (answer === "always") this.always.add(tool.spec.name);
    return answer !== "no";
  }

  private async turn(text: string) {
    await this.agent.runTurn(text);
    this.store.save(this.agent.messages);
  }

  /** Handles one line from the user: a slash command or a request. Returns false on /exit. */
  async input(line: string): Promise<boolean> {
    const { sink } = this.frontend;
    const { agent } = this;
    if (!line.startsWith("/")) {
      await this.turn(line);
      return true;
    }
    const space = line.search(/\s/);
    const cmd = space === -1 ? line : line.slice(0, space);
    const arg = space === -1 ? "" : line.slice(space).trim();

    if (cmd === "/exit" || cmd === "/quit") return false;
    else if (cmd === "/help") {
      sink.say(HELP);
      if (this.commands.size) sink.say(`Comandi del progetto\n  ${[...this.commands.keys()].join("  ")}\n`);
    } else if (cmd === "/clear") {
      agent.clear();
      sink.info("Conversazione azzerata.");
    } else if (cmd === "/model") {
      if (arg) agent.opts.model = arg;
      sink.info(`Modello: ${agent.opts.model}`);
    } else if (cmd === "/effort") {
      if (arg && !EFFORTS.includes(arg as Effort)) sink.say(`Usa uno tra: ${EFFORTS.join(", ")}`);
      else {
        if (arg) agent.opts.effort = arg as Effort;
        sink.info(`Impegno: ${agent.opts.effort}`);
      }
    } else if (cmd === "/yolo") {
      this.yolo = arg === "on" ? true : arg === "off" ? false : !this.yolo;
      sink.info(`Approvazione automatica: ${this.yolo ? "attiva" : "disattivata"}`);
    } else if (cmd === "/cost") sink.say(agent.costSummary());
    else if (cmd === "/compact") {
      const ok = await agent.compact();
      this.store.save(agent.messages);
      sink.info(ok ? "Conversazione riassunta: il contesto ora è più leggero." : "Niente da riassumere.");
    } else if (cmd === "/resume") {
      sink.info(this.resume() ? "Conversazione precedente ripresa." : "Nessuna conversazione precedente.");
    } else if (cmd === "/init") {
      await this.turn(INIT_PROMPT);
      agent.opts.system = buildSystem(this.opts.root, this.opts.web, this.opts.surface);
    } else if (this.commands.has(cmd)) {
      await this.turn(this.commands.get(cmd)!.replaceAll("$ARGUMENTS", arg));
    } else sink.say(`Comando sconosciuto: ${cmd}. Prova /help`);
    return true;
  }
}
