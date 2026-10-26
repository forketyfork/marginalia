import { highlightCode, renderCode } from "./code";

/**
 * One-line shell commands with several statements (`cd x; for f in ...; do ...; done`) are shown one
 * statement per line: the command is split at its top-level `;` and `;;` separators, compound-command
 * keywords (`do`, `then`, `else`, `{`, `case ... in`) take their own line, and bodies are indented.
 * Separators are never recognised inside quotes, `$(...)`, backticks, `${...}`, subshells or
 * comments. The separators stay in the text, dimmed, so what you read is still the command.
 */

export type ShellLine = { indent: number; code: string; sep: string };

type Statement = { code: string; sep: string };

type Context = "sq" | "dq" | "ansi" | "backtick" | "paren" | "brace";

function splitStatements(command: string): Statement[] {
  const stack: Context[] = [];
  const statements: Statement[] = [];
  let start = 0;
  let i = 0;
  while (i < command.length) {
    const ch = command.charAt(i);
    const next = command.charAt(i + 1);
    const ctx = stack[stack.length - 1];
    if (ctx === "sq" || ctx === "ansi") {
      if (ctx === "ansi" && ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "'") stack.pop();
      i += 1;
      continue;
    }
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ctx === "dq") {
      if (ch === '"') stack.pop();
      else if (ch === "`") stack.push("backtick");
      else if (ch === "$" && next === "(") {
        stack.push("paren");
        i += 1;
      } else if (ch === "$" && next === "{") {
        stack.push("brace");
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "'") stack.push("sq");
    else if (ch === '"') stack.push("dq");
    else if (ch === "`") {
      if (ctx === "backtick") stack.pop();
      else stack.push("backtick");
    } else if (ch === "$" && next === "'") {
      stack.push("ansi");
      i += 1;
    } else if (ch === "$" && next === "{") {
      stack.push("brace");
      i += 1;
    } else if (ch === "(") stack.push("paren");
    else if (ch === ")") {
      if (ctx === "paren") stack.pop();
    } else if (ch === "}") {
      if (ctx === "brace") stack.pop();
    } else if (ctx === undefined) {
      if (ch === "#" && (i === 0 || /\s/.test(command.charAt(i - 1)))) break;
      if (ch === ";") {
        const sep = next === ";" ? ";;" : ";";
        statements.push({ code: command.slice(start, i), sep });
        i += sep.length;
        start = i;
        continue;
      }
    }
    i += 1;
  }
  statements.push({ code: command.slice(start), sep: "" });
  return statements;
}

const OPENERS = new Set(["do", "then", "else", "{"]);
const CLOSERS = new Set(["done", "fi", "esac", "else", "elif", "}"]);
const CASE_HEAD = /^case\s+(?:"[^"]*"|'[^']*'|\S)+\s+in(?=\s|$)/;

function firstWord(text: string): string {
  return /^\S+/.exec(text)?.[0] ?? "";
}

/** The leading part of a statement that opens a compound body and takes its own line; null if none. */
function openingHead(text: string): string | null {
  const word = firstWord(text);
  if (OPENERS.has(word)) return word;
  if (word === "case") return CASE_HEAD.exec(text)?.[0] ?? null;
  return null;
}

/** Lines of the laid-out command, or null when the command is multi-line or a single statement. */
export function layoutShell(command: string): ShellLine[] | null {
  if (command.includes("\n")) return null;
  const statements = splitStatements(command);
  const last = statements[statements.length - 1];
  if (last && last.code.trim() === "" && last.sep === "") statements.pop();
  if (statements.length < 2) return null;
  const lines: ShellLine[] = [];
  let indent = 0;
  for (const statement of statements) {
    const code = statement.code.trim();
    if (CLOSERS.has(firstWord(code))) indent = Math.max(0, indent - 1);
    const head = openingHead(code);
    if (head === null) {
      lines.push({ indent, code, sep: statement.sep });
      continue;
    }
    const body = code.slice(head.length).trim();
    if (body.length === 0) {
      lines.push({ indent, code, sep: statement.sep });
    } else {
      lines.push({ indent, code: head, sep: "" });
      lines.push({ indent: indent + 1, code: body, sep: statement.sep });
    }
    indent += 1;
  }
  return lines;
}

/** `<shell> -c <script>` argv forms (Codex's `shell` tool) are shown as the script itself. */
export function shellScript(argv: readonly unknown[]): string {
  const [shell, flag, script, ...rest] = argv;
  if (
    typeof shell === "string" &&
    /^(?:\/\S*\/)?(?:ba|z|da)?sh$/.test(shell) &&
    (flag === "-c" || flag === "-lc") &&
    typeof script === "string" &&
    rest.length === 0
  ) {
    return script;
  }
  return argv.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
}

export function renderShellCommand(command: string): string {
  const lines = layoutShell(command);
  if (lines === null) return renderCode(command, "bash");
  const html = lines
    .map((line) => {
      const sep = line.sep ? `<span class="sep">${line.sep}</span>` : "";
      return `${"  ".repeat(line.indent)}${highlightCode(line.code, "bash")}${sep}`;
    })
    .join("\n");
  return `<pre class="plain code lang-bash">${html}</pre>`;
}
