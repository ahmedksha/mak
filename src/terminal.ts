import type { Sink, ToolEnd, ToolStart } from "./sink.js";
import { c } from "./ui.js";

const pad = (sub: boolean) => (sub ? "    " : "");

function colorDiff(detail: string, p: string): string {
  return detail
    .split("\n")
    .map((l) => p + (l.trimStart().startsWith("-") ? c.red(l) : c.green(l)))
    .join("\n");
}

function preview(output: string, p: string, max: number): string {
  const lines = output.trimEnd().split("\n");
  const shown = lines.slice(0, max).map((l) => `${p}  ⎿ ${l.slice(0, 160)}`);
  if (lines.length > max) shown.push(`${p}  ⎿ … +${lines.length - max} righe`);
  return shown.join("\n");
}

export class TerminalSink implements Sink {
  private mode: "none" | "thinking" | "text" = "none";

  private breakLine() {
    if (this.mode !== "none") process.stdout.write("\n");
    this.mode = "none";
  }
  text(delta: string) {
    if (this.mode !== "text") process.stdout.write("\n");
    this.mode = "text";
    process.stdout.write(delta);
  }
  thinking(delta: string) {
    if (this.mode !== "thinking") process.stdout.write(c.dim("\n✻ "));
    this.mode = "thinking";
    process.stdout.write(c.dim(delta));
  }
  messageEnd() {
    this.breakLine();
  }
  toolStart(e: ToolStart) {
    this.breakLine();
    console.log(`\n${pad(e.sub)}${c.cyan("●")} ${c.bold(e.name)} ${c.dim(e.summary)}`);
    if (e.detail) console.log(colorDiff(e.detail, pad(e.sub)));
  }
  toolEnd(e: ToolEnd) {
    if (e.server) return;
    const p = pad(e.sub);
    if (e.status === "denied") console.log(c.yellow(`${p}  ✗ negato`));
    else if (e.status === "error") console.log(c.red(`${p}  ✗ ${e.output}`));
    else console.log(c.dim(preview(e.output, p, e.full ? 40 : 6)));
  }
  say(msg: string) {
    this.breakLine();
    console.log(msg);
  }
  info(msg: string) {
    this.breakLine();
    console.log(c.dim(msg));
  }
  warn(msg: string) {
    this.breakLine();
    console.log(c.yellow(msg));
  }
  error(msg: string) {
    this.breakLine();
    console.error(c.red(msg));
  }
}
