/** Where the agent's activity goes: the terminal, or the browser UI. */
export interface ToolStart {
  id: string;
  name: string;
  summary: string;
  /** Preview of the change (lines starting with - or +). */
  detail?: string;
  /** Raised by a sub-agent. */
  sub: boolean;
  /** Runs on Anthropic's servers (web search and fetch); no result is shown. */
  server?: boolean;
  todos?: { content: string; status: string }[];
}

export interface ToolEnd {
  id: string;
  status: "ok" | "error" | "denied";
  output: string;
  sub: boolean;
  /** Show the whole output instead of the first few lines. */
  full?: boolean;
  server?: boolean;
}

export interface Sink {
  text(delta: string): void;
  thinking(delta: string): void;
  messageEnd(): void;
  toolStart(e: ToolStart): void;
  toolEnd(e: ToolEnd): void;
  say(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}
