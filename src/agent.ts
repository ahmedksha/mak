import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { TOOLS, type ToolDef } from "./tools.js";
import { c } from "./ui.js";

export type Msg = Anthropic.Beta.BetaMessageParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** USD per million tokens: [input, output, cache read, cache write]. */
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5],
  "claude-fable-5-2": [8, 40, 0.2, 10],
};

const WEB_TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  { type: "web_search_20260209", name: "web_search", max_uses: 8 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 8 },
];

const SUBAGENT_NOTE =
  "\n\nYou are running as a sub-agent with a fresh context. Complete the task you are given, then finish with a concise report of what you found or did. That report is all the main agent will see.";

const COMPACT_PROMPT =
  "Do not call any tools. Write a summary of this conversation that lets the work continue without the earlier messages: the user's goals and preferences, what was done and where (files, commands, results), decisions made, and what remains open.";

export interface AgentOptions {
  model: string;
  effort: Effort;
  root: string;
  system: string;
  /** Give the model web search and web fetch. */
  web: boolean;
  /** Sub-agents don't stream their text and can't spawn further sub-agents. */
  sub?: boolean;
  /** Asked before any tool that changes files or runs commands. */
  approve(tool: ToolDef, input: unknown): Promise<boolean>;
}

export class Agent {
  private client = new Anthropic();
  private abort: AbortController | null = null;
  private tools: Map<string, ToolDef>;
  private quiet: boolean;
  messages: Msg[] = [];
  usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  constructor(public opts: AgentOptions) {
    const defs = opts.sub ? TOOLS : [...TOOLS, taskTool(this)];
    this.tools = new Map(defs.map((t) => [t.spec.name, t]));
    this.quiet = !!opts.sub;
  }

  clear() {
    this.messages = [];
  }

  /** Stop the turn in progress, if any. Returns false when idle. */
  interrupt(): boolean {
    if (!this.abort) return false;
    this.abort.abort();
    return true;
  }

  costSummary(): string {
    const u = this.usage;
    const p = PRICES[this.opts.model];
    const tokens = `input ${u.input} · output ${u.output} · cache letta ${u.cacheRead} · cache scritta ${u.cacheWrite}`;
    if (!p) return `Token: ${tokens}`;
    const usd = (u.input * p[0] + u.output * p[1] + u.cacheRead * p[2] + u.cacheWrite * p[3]) / 1e6;
    return `Token: ${tokens}\nCosto stimato: $${usd.toFixed(4)}`;
  }

  /** Replace the history with a summary of it. Returns false if nothing changed. */
  async compact(): Promise<boolean> {
    if (!this.messages.length) return false;
    const saved = this.messages.slice();
    this.quiet = true;
    const summary = await this.runTurn(COMPACT_PROMPT);
    this.quiet = !!this.opts.sub;
    if (!summary) {
      this.messages = saved;
      return false;
    }
    this.messages = [
      { role: "user", content: `Summary of the conversation so far (earlier messages were compacted):\n\n${summary}` },
    ];
    return true;
  }

  /** Runs one user turn to completion. Returns the final text, or null if it failed or was interrupted. */
  async runTurn(userText: string): Promise<string | null> {
    this.abort = new AbortController();
    const { signal } = this.abort;
    this.messages.push({ role: "user", content: userText });
    try {
      return await this.loop(signal);
    } catch (err) {
      if (signal.aborted) {
        console.log(c.yellow("\n⏹ Interrotto."));
      } else if (err instanceof Anthropic.AuthenticationError) {
        console.error(c.red("\nCredenziali non valide. Imposta ANTHROPIC_API_KEY e riprova."));
      } else if (err instanceof Anthropic.RateLimitError) {
        console.error(c.red("\nLimite di richieste raggiunto. Riprova tra poco."));
      } else if (err instanceof Anthropic.APIConnectionError) {
        console.error(c.red(`\nErrore di connessione: ${err.message}`));
      } else if (err instanceof Anthropic.APIError) {
        console.error(c.red(`\nErrore API ${err.status ?? ""}: ${err.message}`));
      } else {
        console.error(c.red(`\nErrore: ${err instanceof Error ? err.message : String(err)}`));
      }
      return null;
    } finally {
      this.abort = null;
    }
  }

  private get pad(): string {
    return this.opts.sub ? "    " : "";
  }

  private async loop(signal: AbortSignal): Promise<string | null> {
    let jsonRetries = 0;
    const clientTools: Anthropic.Beta.BetaToolUnion[] = [...this.tools.values()].map((t) => t.spec);
    const tools = this.opts.web ? [...clientTools, ...WEB_TOOLS] : clientTools;
    for (;;) {
      const stream = this.client.beta.messages.stream(
        {
          model: this.opts.model,
          max_tokens: 64000,
          system: this.opts.system + (this.opts.sub ? SUBAGENT_NOTE : ""),
          tools,
          messages: this.messages,
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: this.opts.effort },
          cache_control: { type: "ephemeral" },
          // If the model declines a request, the API retries it on a fallback model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal },
      );

      let mode: "none" | "thinking" | "text" = "none";
      if (!this.quiet) {
        stream.on("thinking", (delta) => {
          if (mode !== "thinking") process.stdout.write(c.dim("\n✻ "));
          mode = "thinking";
          process.stdout.write(c.dim(delta));
        });
        stream.on("text", (delta) => {
          if (mode !== "text") process.stdout.write("\n");
          mode = "text";
          process.stdout.write(delta);
        });
      }
      stream.on("contentBlock", (block) => {
        if (block.type !== "server_tool_use") return;
        const input = block.input as { query?: string; url?: string };
        const what = input.query ?? input.url;
        if (!what) return;
        if (mode !== "none") process.stdout.write("\n");
        mode = "none";
        console.log(`\n${this.pad}${c.cyan("●")} ${c.bold(block.name)} ${c.dim(oneLine(what))}`);
      });

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        // With eager input streaming a tool input that isn't parseable JSON
        // rejects here; re-issue the turn. API errors and aborts propagate.
        if (signal.aborted || err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
        continue;
      }
      if (mode !== "none") process.stdout.write("\n");

      const u = message.usage;
      this.usage.input += u.input_tokens;
      this.usage.output += u.output_tokens;
      this.usage.cacheRead += u.cache_read_input_tokens ?? 0;
      this.usage.cacheWrite += u.cache_creation_input_tokens ?? 0;

      const text = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();

      if (message.stop_reason === "refusal") {
        console.log(c.yellow(`${this.pad}Il modello ha rifiutato la richiesta.`));
        return null;
      }

      const calls = message.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
      );

      if (message.stop_reason === "max_tokens") {
        // A tool input cut off here would parse as a valid partial object: never run it.
        console.log(c.yellow(`${this.pad}Risposta troncata (limite di token). Chiedi di continuare.`));
        if (calls.length === 0 && message.content.length) {
          this.messages.push({ role: "assistant", content: message.content });
        }
        return text || null;
      }

      if (message.content.length) this.messages.push({ role: "assistant", content: message.content });
      if (message.stop_reason === "pause_turn") continue;
      if (calls.length === 0) return text;

      const results: ToolResult[] = [];
      for (const call of calls) {
        results.push(await this.runTool(call, signal));
      }
      this.messages.push({ role: "user", content: results });
      if (signal.aborted) {
        console.log(c.yellow("\n⏹ Interrotto."));
        return null;
      }
    }
  }

  private async runTool(call: Anthropic.Beta.BetaToolUseBlock, signal: AbortSignal): Promise<ToolResult> {
    const fail = (content: string): ToolResult => ({
      type: "tool_result",
      tool_use_id: call.id,
      is_error: true,
      content,
    });
    if (signal.aborted) return fail("Interrupted by the user before this tool ran.");

    const tool = this.tools.get(call.name);
    if (!tool) return fail(`Unknown tool: ${call.name}`);

    // Eager streaming skips server-side validation, so validate here.
    const parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) return fail(JSON.stringify({ INVALID_JSON: JSON.stringify(call.input) }));
    const input = parsed.data;
    const pad = this.pad;

    console.log(`\n${pad}${c.cyan("●")} ${c.bold(call.name)} ${c.dim(oneLine(tool.summarize(input)))}`);

    if (!tool.readOnly) {
      if (tool.detail) console.log(colorDiff(tool.detail(input), pad));
      if (!(await this.opts.approve(tool, input))) {
        console.log(c.yellow(`${pad}  ✗ negato`));
        return fail("The user denied permission for this action. Ask them how to proceed.");
      }
    }
    if (signal.aborted) return fail("Interrupted by the user before this tool ran.");

    try {
      const output = await tool.run(input, { root: this.opts.root, signal });
      console.log(c.dim(preview(output, pad, tool.fullOutput ? 40 : 6)));
      return { type: "tool_result", tool_use_id: call.id, content: output };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(c.red(`${pad}  ✗ ${msg}`));
      return fail(msg);
    }
  }
}

function taskTool(parent: Agent): ToolDef {
  return {
    readOnly: true, // the sub-agent's own tools still ask for approval
    schema: z.object({ description: z.string().min(1), prompt: z.string().min(1) }),
    spec: {
      name: "task",
      description:
        "Delegate a self-contained subtask to a sub-agent that has the same tools but a fresh context, and get back its final report. Useful for broad searches or investigations whose intermediate output you don't need. The sub-agent cannot see this conversation, so put everything it needs in the prompt.",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: {
          description: { type: "string", description: "Short label for the subtask (3-6 words)" },
          prompt: { type: "string", description: "Complete instructions for the sub-agent" },
        },
        required: ["description", "prompt"],
      },
    },
    summarize: (i) => i.description,
    async run(i, ctx) {
      const sub = new Agent({ ...parent.opts, sub: true });
      const onAbort = () => sub.interrupt();
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const report = await sub.runTurn(i.prompt);
        return report || "[the sub-agent failed or was interrupted and produced no report]";
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
        for (const k of Object.keys(sub.usage) as (keyof typeof sub.usage)[]) parent.usage[k] += sub.usage[k];
      }
    },
  };
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ");
  return flat.length > 120 ? flat.slice(0, 117) + "..." : flat;
}

function colorDiff(detail: string, pad: string): string {
  return detail
    .split("\n")
    .map((l) => pad + (l.trimStart().startsWith("-") ? c.red(l) : c.green(l)))
    .join("\n");
}

function preview(output: string, pad: string, max: number): string {
  const lines = output.trimEnd().split("\n");
  const shown = lines.slice(0, max).map((l) => `${pad}  ⎿ ${l.slice(0, 160)}`);
  if (lines.length > max) shown.push(`${pad}  ⎿ … +${lines.length - max} righe`);
  return shown.join("\n");
}
