import Anthropic from "@anthropic-ai/sdk";
import { TOOLS, TOOL_BY_NAME, type ToolDef } from "./tools.js";
import { c } from "./ui.js";

type Msg = Anthropic.Beta.BetaMessageParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** USD per million tokens: [input, output, cache read, cache write]. */
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5],
  "claude-fable-5-2": [8, 40, 0.2, 10],
};

export interface AgentOptions {
  model: string;
  effort: Effort;
  root: string;
  system: string;
  /** Asked before any tool that changes files or runs commands. */
  approve(tool: ToolDef, input: unknown): Promise<boolean>;
}

export class Agent {
  private client = new Anthropic();
  private messages: Msg[] = [];
  private abort: AbortController | null = null;
  usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  constructor(public opts: AgentOptions) {}

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

  async runTurn(userText: string): Promise<void> {
    this.abort = new AbortController();
    const { signal } = this.abort;
    this.messages.push({ role: "user", content: userText });
    try {
      await this.loop(signal);
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
    } finally {
      this.abort = null;
    }
  }

  private async loop(signal: AbortSignal): Promise<void> {
    let jsonRetries = 0;
    for (;;) {
      const stream = this.client.beta.messages.stream(
        {
          model: this.opts.model,
          max_tokens: 64000,
          system: this.opts.system,
          tools: TOOLS.map((t) => t.spec),
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

      if (message.stop_reason === "refusal") {
        console.log(c.yellow("Il modello ha rifiutato la richiesta."));
        return;
      }

      const calls = message.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
      );

      if (message.stop_reason === "max_tokens") {
        // A tool input cut off here would parse as a valid partial object: never run it.
        console.log(c.yellow("Risposta troncata (limite di token). Chiedi di continuare."));
        if (calls.length === 0 && message.content.length) {
          this.messages.push({ role: "assistant", content: message.content });
        }
        return;
      }

      if (message.content.length) this.messages.push({ role: "assistant", content: message.content });
      if (message.stop_reason === "pause_turn") continue;
      if (calls.length === 0) return;

      const results: ToolResult[] = [];
      for (const call of calls) {
        results.push(await this.runTool(call, signal));
      }
      this.messages.push({ role: "user", content: results });
      if (signal.aborted) {
        console.log(c.yellow("\n⏹ Interrotto."));
        return;
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

    const tool = TOOL_BY_NAME.get(call.name);
    if (!tool) return fail(`Unknown tool: ${call.name}`);

    // Eager streaming skips server-side validation, so validate here.
    const parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) return fail(JSON.stringify({ INVALID_JSON: JSON.stringify(call.input) }));
    const input = parsed.data;

    console.log(`\n${c.cyan("●")} ${c.bold(call.name)} ${c.dim(oneLine(tool.summarize(input)))}`);

    if (!tool.readOnly && !(await this.opts.approve(tool, input))) {
      console.log(c.yellow("  ✗ negato"));
      return fail("The user denied permission for this action. Ask them how to proceed.");
    }
    if (signal.aborted) return fail("Interrupted by the user before this tool ran.");

    try {
      const output = await tool.run(input, { root: this.opts.root, signal });
      console.log(c.dim(preview(output)));
      return { type: "tool_result", tool_use_id: call.id, content: output };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(c.red(`  ✗ ${msg}`));
      return fail(msg);
    }
  }
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ");
  return flat.length > 120 ? flat.slice(0, 117) + "..." : flat;
}

function preview(output: string): string {
  const lines = output.trimEnd().split("\n");
  const shown = lines.slice(0, 6).map((l) => `  ⎿ ${l.slice(0, 160)}`);
  if (lines.length > 6) shown.push(`  ⎿ … +${lines.length - 6} righe`);
  return shown.join("\n");
}
