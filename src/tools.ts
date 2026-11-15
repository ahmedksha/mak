import type Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const MAX_OUTPUT = 30_000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".venv", "__pycache__"]);

export interface ToolContext {
  root: string;
  signal: AbortSignal;
}

export interface ToolDef {
  spec: Anthropic.Beta.BetaTool;
  schema: z.ZodType;
  /** Read-only tools run without asking the user. */
  readOnly: boolean;
  summarize(input: any): string;
  /** Optional preview of the change, shown before the user approves it. */
  detail?(input: any): string;
  /** Show the whole output instead of the first few lines. */
  fullOutput?: boolean;
  run(input: any, ctx: ToolContext): Promise<string>;
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  const half = MAX_OUTPUT / 2;
  return `${s.slice(0, half)}\n\n[... ${s.length - MAX_OUTPUT} characters truncated ...]\n\n${s.slice(-half)}`;
}

/**
 * Paths come from the model and are untrusted: resolve them against the
 * project root (following symlinks) and refuse anything that escapes it.
 */
async function resolveInRoot(root: string, p: string): Promise<string> {
  const target = path.resolve(root, p);
  // Canonicalize the deepest existing ancestor so a symlink cannot lead outside.
  let existing = target;
  const tail: string[] = [];
  for (;;) {
    try {
      existing = await fs.realpath(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const real = path.join(existing, ...tail);
  const rel = path.relative(await fs.realpath(root), real);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Path is outside the project directory: ${p}`);
  }
  return real;
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(full);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if (ch === "{") re += "(?:";
    else if (ch === "}") re += ")";
    else if (ch === ",") re += "|";
    else re += ch.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const str = { type: "string" } as const;

function diffLines(sign: "+" | "-", text: string, max = 12): string {
  const lines = text.split("\n");
  const shown = lines.slice(0, max).map((l) => `    ${sign} ${l.slice(0, 160)}`);
  if (lines.length > max) shown.push(`    ${sign} … +${lines.length - max} righe`);
  return shown.join("\n");
}

const readFile: ToolDef = {
  readOnly: true,
  schema: z.object({
    path: z.string(),
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).optional(),
  }),
  spec: {
    name: "read_file",
    description:
      "Read a text file from the project. Returns lines prefixed with line numbers. Use offset/limit (1-based line numbers) for large files.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        path: { ...str, description: "File path, relative to the project root" },
        offset: { type: "integer", description: "First line to read (1-based)" },
        limit: { type: "integer", description: "Maximum number of lines (default 2000)" },
      },
      required: ["path"],
    },
  },
  summarize: (i) => i.path,
  async run(i, ctx) {
    const file = await resolveInRoot(ctx.root, i.path);
    const lines = (await fs.readFile(file, "utf8")).split("\n");
    const start = (i.offset ?? 1) - 1;
    const slice = lines.slice(start, start + (i.limit ?? 2000));
    const body = slice.map((l, n) => `${String(start + n + 1).padStart(6)}\t${l}`).join("\n");
    const more = start + slice.length < lines.length ? `\n[file has ${lines.length} lines]` : "";
    return truncate(body + more) || "[empty file]";
  },
};

const writeFile: ToolDef = {
  readOnly: false,
  schema: z.object({ path: z.string(), content: z.string() }),
  spec: {
    name: "write_file",
    description:
      "Create a file or overwrite it entirely with the given content. Parent directories are created. Prefer edit_file for changes to existing files.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        path: { ...str, description: "File path, relative to the project root" },
        content: { ...str, description: "Full file contents" },
      },
      required: ["path", "content"],
    },
  },
  summarize: (i) => `${i.path} (${i.content.split("\n").length} righe)`,
  detail: (i) => diffLines("+", i.content),
  async run(i, ctx) {
    const file = await resolveInRoot(ctx.root, i.path);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, i.content);
    return `Wrote ${i.content.length} characters to ${i.path}`;
  },
};

const editFile: ToolDef = {
  readOnly: false,
  schema: z.object({
    path: z.string(),
    old_string: z.string().min(1),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  }),
  spec: {
    name: "edit_file",
    description:
      "Replace an exact string in a file. old_string must match the file exactly (including whitespace) and be unique unless replace_all is true.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        path: { ...str, description: "File path, relative to the project root" },
        old_string: { ...str, description: "Exact text to replace" },
        new_string: { ...str, description: "Replacement text" },
        replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  summarize: (i) => i.path,
  detail: (i) => `${diffLines("-", i.old_string)}\n${diffLines("+", i.new_string)}`,
  async run(i, ctx) {
    const file = await resolveInRoot(ctx.root, i.path);
    const text = await fs.readFile(file, "utf8");
    const count = text.split(i.old_string).length - 1;
    if (count === 0) throw new Error("old_string was not found in the file");
    if (count > 1 && !i.replace_all) {
      throw new Error(`old_string matches ${count} times; add context to make it unique or set replace_all`);
    }
    const next = i.replace_all
      ? text.split(i.old_string).join(i.new_string)
      : text.replace(i.old_string, () => i.new_string);
    await fs.writeFile(file, next);
    return `Edited ${i.path} (${i.replace_all ? count : 1} replacement${count > 1 && i.replace_all ? "s" : ""})`;
  },
};

const bash: ToolDef = {
  readOnly: false,
  schema: z.object({ command: z.string().min(1), timeout_ms: z.number().int().min(1).max(600_000).optional() }),
  spec: {
    name: "bash",
    description:
      "Run a shell command in the project directory and return its combined stdout/stderr and exit code. Use for tests, builds, git, and anything the file tools don't cover. Default timeout 120s.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        command: { ...str, description: "The command to run" },
        timeout_ms: { type: "integer", description: "Timeout in milliseconds (max 600000)" },
      },
      required: ["command"],
    },
  },
  summarize: (i) => i.command,
  run(i, ctx) {
    return new Promise((resolve) => {
      const child = spawn("bash", ["-c", i.command], { cwd: ctx.root, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let note = "";
      const onData = (d: Buffer) => {
        if (out.length < MAX_OUTPUT * 4) out += d.toString();
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      const timer = setTimeout(() => {
        note = "\n[command timed out]";
        child.kill("SIGKILL");
      }, i.timeout_ms ?? 120_000);
      const onAbort = () => {
        note = "\n[interrupted by user]";
        child.kill("SIGKILL");
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      const done = (tail: string) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        resolve(truncate(out) + note + tail);
      };
      child.on("error", (e) => done(`\n[failed to start: ${e.message}]`));
      child.on("close", (code) => done(`\n[exit code: ${code ?? "killed"}]`));
    });
  },
};

const glob: ToolDef = {
  readOnly: true,
  schema: z.object({ pattern: z.string().min(1) }),
  spec: {
    name: "glob",
    description:
      'Find files by glob pattern (e.g. "src/**/*.ts", "**/*.{js,jsx}"). Returns paths relative to the project root. node_modules, .git and build output are skipped.',
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: { pattern: { ...str, description: "Glob pattern" } },
      required: ["pattern"],
    },
  },
  summarize: (i) => i.pattern,
  async run(i, ctx) {
    const re = globToRegExp(i.pattern);
    const hits: string[] = [];
    for await (const file of walk(ctx.root)) {
      const rel = path.relative(ctx.root, file).split(path.sep).join("/");
      if (re.test(rel)) hits.push(rel);
      if (hits.length >= 500) break;
    }
    return hits.length ? hits.sort().join("\n") : "No files matched";
  },
};

const grep: ToolDef = {
  readOnly: true,
  schema: z.object({
    pattern: z.string().min(1),
    path: z.string().optional(),
    glob: z.string().optional(),
    ignore_case: z.boolean().optional(),
  }),
  spec: {
    name: "grep",
    description:
      "Search file contents with a JavaScript regular expression. Returns matching lines as path:line:text. Optionally limit to a subdirectory (path) or to files matching a glob.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        pattern: { ...str, description: "Regular expression" },
        path: { ...str, description: "Directory or file to search (default: project root)" },
        glob: { ...str, description: 'Only search files matching this glob, e.g. "**/*.ts"' },
        ignore_case: { type: "boolean" },
      },
      required: ["pattern"],
    },
  },
  summarize: (i) => `${i.pattern}${i.path ? ` in ${i.path}` : ""}`,
  async run(i, ctx) {
    const re = new RegExp(i.pattern, i.ignore_case ? "i" : "");
    const filter = i.glob ? globToRegExp(i.glob) : null;
    const base = await resolveInRoot(ctx.root, i.path ?? ".");
    const files = (await fs.stat(base)).isFile() ? [base] : walk(base);
    const hits: string[] = [];
    for await (const file of files) {
      if (ctx.signal.aborted) break;
      const rel = path.relative(ctx.root, file).split(path.sep).join("/");
      if (filter && !filter.test(rel)) continue;
      let text: string;
      try {
        if ((await fs.stat(file)).size > 2_000_000) continue;
        text = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\0")) continue; // binary
      const lines = text.split("\n");
      for (let n = 0; n < lines.length; n++) {
        if (re.test(lines[n])) hits.push(`${rel}:${n + 1}:${lines[n].slice(0, 300)}`);
        if (hits.length >= 300) break;
      }
      if (hits.length >= 300) {
        hits.push("[results capped at 300 matches]");
        break;
      }
    }
    return hits.length ? truncate(hits.join("\n")) : "No matches";
  },
};

const todoWrite: ToolDef = {
  readOnly: true,
  fullOutput: true,
  schema: z.object({
    todos: z.array(
      z.object({ content: z.string().min(1), status: z.enum(["pending", "in_progress", "completed"]) }),
    ),
  }),
  spec: {
    name: "todo_write",
    description:
      "Show the user a task list for multi-step work and keep it current. Send the full list every time; mark one item in_progress while you work on it and completed as soon as it is done. Skip it for simple tasks.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { ...str, description: "What needs doing" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
  summarize: (i) => `${i.todos.filter((t: any) => t.status === "completed").length}/${i.todos.length} completate`,
  async run(i) {
    const mark = { pending: "☐", in_progress: "◐", completed: "☑" } as const;
    return i.todos.map((t: { content: string; status: keyof typeof mark }) => `${mark[t.status]} ${t.content}`).join("\n") || "[empty list]";
  },
};

export const TOOLS: ToolDef[] = [readFile, writeFile, editFile, bash, glob, grep, todoWrite];
export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.spec.name, t]));
