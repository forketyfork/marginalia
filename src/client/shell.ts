import { highlightCode, languageForPath, splitHighlightedLines } from "./code";
import { escapeHtml } from "./html";

/**
 * Shell commands get two kinds of help beyond plain highlighting.
 *
 * One-line commands with several statements (`cd x; for f in ...; do ...; done`) are shown one
 * statement per line: the command is split at its top-level `;` and `;;` separators, compound-command
 * keywords (`do`, `then`, `else`, `{`, `case ... in`) take their own line, and bodies are indented.
 * The separators stay in the text, dimmed, so what you read is still the command.
 *
 * Here-documents (`python3 - <<'EOF' ... EOF`) are highlighted in the language of the command that
 * reads them: an interpreter taking its program from stdin, a database client, or the file that a
 * `cat` or `tee` writes. The operator and the terminator line are dimmed like separators, and a body
 * whose language is unknown (a commit message, say) is left plain rather than read as shell.
 *
 * Both rest on one scanner that tracks quotes, `$(...)`, backticks, `${...}`, `$((...))` and
 * subshells, so nothing inside them is ever taken for a separator, a redirection or a comment.
 */

type Context = "sq" | "dq" | "ansi" | "backtick" | "paren" | "brace" | "arith";

type Scan = { text: string; stack: Context[]; i: number };

/** Groupings whose contents are commands again, unlike quotes and expansions. */
const GROUPS: ReadonlySet<Context> = new Set<Context>(["paren", "backtick"]);

/** Whether the scanner is in command text, where separators, redirections and comments count. */
function inCommandText(stack: readonly Context[]): boolean {
  const ctx = stack[stack.length - 1];
  return ctx === undefined || GROUPS.has(ctx);
}

function isCommentStart(text: string, i: number): boolean {
  return text.charAt(i) === "#" && (i === 0 || /\s/.test(text.charAt(i - 1)));
}

/** Moves past the quote, escape or grouping construct at the current position, or past one plain character. */
function advance(s: Scan): void {
  const { text, stack } = s;
  const ch = text.charAt(s.i);
  const ctx = stack[stack.length - 1];
  if (ctx === "sq" || ctx === "ansi") {
    if (ctx === "ansi" && ch === "\\") s.i += 2;
    else {
      if (ch === "'") stack.pop();
      s.i += 1;
    }
    return;
  }
  if (ctx === "arith") {
    if (text.startsWith("))", s.i)) {
      stack.pop();
      s.i += 2;
    } else s.i += 1;
    return;
  }
  if (ch === "\\") {
    s.i += 2;
    return;
  }
  if (ch === "$") {
    if (text.startsWith("$((", s.i)) {
      stack.push("arith");
      s.i += 3;
      return;
    }
    if (text.startsWith("$(", s.i)) {
      stack.push("paren");
      s.i += 2;
      return;
    }
    if (text.startsWith("${", s.i)) {
      stack.push("brace");
      s.i += 2;
      return;
    }
    if (ctx !== "dq" && text.startsWith("$'", s.i)) {
      stack.push("ansi");
      s.i += 2;
      return;
    }
  }
  if (ctx === "dq") {
    if (ch === '"') stack.pop();
    else if (ch === "`") stack.push("backtick");
    s.i += 1;
    return;
  }
  if (ch === "'") stack.push("sq");
  else if (ch === '"') stack.push("dq");
  else if (ch === "`") {
    if (ctx === "backtick") stack.pop();
    else stack.push("backtick");
  } else if (ch === "(") stack.push("paren");
  else if (ch === ")" && ctx === "paren") stack.pop();
  else if (ch === "}" && ctx === "brace") stack.pop();
  s.i += 1;
}

export type ShellLine = { indent: number; code: string; sep: string };

type Statement = { code: string; sep: string };

function splitStatements(command: string): Statement[] {
  const s: Scan = { text: command, stack: [], i: 0 };
  const statements: Statement[] = [];
  let start = 0;
  while (s.i < command.length) {
    if (s.stack.length === 0) {
      if (isCommentStart(command, s.i)) break;
      if (command.charAt(s.i) === ";") {
        const sep = command.charAt(s.i + 1) === ";" ? ";;" : ";";
        statements.push({ code: command.slice(start, s.i), sep });
        s.i += sep.length;
        start = s.i;
        continue;
      }
    }
    advance(s);
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

export type Heredoc = {
  /** Line holding the operator and the operator's column range on it. */
  line: number;
  start: number;
  end: number;
  delimiter: string;
  /** Body lines `[bodyFrom, bodyTo)`; the terminator line follows, or is null when the body runs to the end. */
  bodyFrom: number;
  bodyTo: number;
  terminator: number | null;
  language: string | null;
};

const HEREDOC_OPERATOR = /<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s;|&<>()]+))/y;

/**
 * Here-documents of a command in operator order. A body starts on the line after its operator (after
 * the bodies of earlier operators on the same line) and ends before the line equal to the delimiter,
 * leading tabs ignored for `<<-`. Operators are recognised in command text only, so here-strings,
 * arithmetic shifts and quoted text never start one.
 */
export function findHeredocs(command: string): Heredoc[] {
  const lines = command.split("\n");
  const lineStarts = [0];
  for (let k = 0; k < lines.length - 1; k += 1)
    lineStarts.push((lineStarts[k] ?? 0) + (lines[k]?.length ?? 0) + 1);
  let line = 0;
  const lineOf = (offset: number): number => {
    while ((lineStarts[line + 1] ?? Number.POSITIVE_INFINITY) <= offset) line += 1;
    return line;
  };
  const docs: Heredoc[] = [];
  const pending: Array<{ doc: Heredoc; stripTabs: boolean }> = [];
  const s: Scan = { text: command, stack: [], i: 0 };
  while (s.i < command.length) {
    const ch = command.charAt(s.i);
    if (ch === "\n") {
      s.i += 1;
      if (pending.length === 0) continue;
      let next = lineOf(s.i);
      for (const { doc, stripTabs } of pending) {
        doc.bodyFrom = next;
        const terminator = terminatorLine(lines, next, doc.delimiter, stripTabs);
        doc.bodyTo = terminator ?? lines.length;
        doc.terminator = terminator;
        next = terminator === null ? lines.length : terminator + 1;
      }
      pending.length = 0;
      s.i = lineStarts[next] ?? command.length;
      continue;
    }
    if (inCommandText(s.stack)) {
      if (isCommentStart(command, s.i)) {
        const newline = command.indexOf("\n", s.i);
        s.i = newline < 0 ? command.length : newline;
        continue;
      }
      if (ch === "<" && command.charAt(s.i - 1) !== "<") {
        HEREDOC_OPERATOR.lastIndex = s.i;
        const match = HEREDOC_OPERATOR.exec(command);
        if (match !== null) {
          const opLine = lineOf(s.i);
          const text = lines[opLine] ?? "";
          const start = s.i - (lineStarts[opLine] ?? 0);
          const end = start + match[0].length;
          const doc: Heredoc = {
            line: opLine,
            start,
            end,
            delimiter: match[2] ?? match[3] ?? match[4] ?? "",
            bodyFrom: lines.length,
            bodyTo: lines.length,
            terminator: null,
            language: heredocLanguage(text, start, end),
          };
          docs.push(doc);
          pending.push({ doc, stripTabs: match[1] === "-" });
          s.i += match[0].length;
          continue;
        }
      }
    }
    advance(s);
  }
  const unfed = new Set(pending.map((p) => p.doc));
  return docs.filter((doc) => !unfed.has(doc));
}

function terminatorLine(lines: string[], from: number, delimiter: string, stripTabs: boolean): number | null {
  for (let k = from; k < lines.length; k += 1) {
    const text = lines[k] ?? "";
    if ((stripTabs ? text.replace(/^\t+/, "") : text) === delimiter) return k;
  }
  return null;
}

type Segment = { start: number; end: number; depth: number; piped: boolean };

/** The simple commands of one line, each with its grouping depth and whether a pipe follows it. */
function simpleCommands(line: string): Segment[] {
  const s: Scan = { text: line, stack: [], i: 0 };
  const starts = [0];
  const segments: Segment[] = [];
  const close = (end: number, depth: number, piped: boolean) => {
    segments.push({ start: starts[depth] ?? 0, end, depth, piped });
  };
  while (s.i < line.length) {
    const depth = s.stack.length;
    if (inCommandText(s.stack)) {
      if (isCommentStart(line, s.i)) break;
      const sep = /^(?:;;|&&|\|\||\|&|[;&|])/.exec(line.slice(s.i))?.[0];
      // `&` is also part of the redirections `2>&1` and `&>file`.
      const redirect = sep === "&" && (/[<>]/.test(line.charAt(s.i - 1)) || line.charAt(s.i + 1) === ">");
      if (sep !== undefined && !redirect) {
        close(s.i, depth, sep.startsWith("|") && sep !== "||");
        s.i += sep.length;
        starts[depth] = s.i;
        continue;
      }
    }
    const before = s.stack[s.stack.length - 1];
    advance(s);
    const after = s.stack[s.stack.length - 1];
    if (s.stack.length > depth && after !== undefined && GROUPS.has(after)) starts[depth + 1] = s.i;
    else if (s.stack.length < depth && before !== undefined && GROUPS.has(before))
      close(s.i - 1, depth, false);
  }
  close(line.length, s.stack.length, false);
  return segments;
}

/** Whitespace-separated words of a simple command, with quoted and substituted text kept whole. */
function words(text: string): string[] {
  const s: Scan = { text, stack: [], i: 0 };
  const out: string[] = [];
  let start = -1;
  while (s.i < text.length) {
    if (s.stack.length === 0 && /\s/.test(text.charAt(s.i))) {
      if (start >= 0) out.push(text.slice(start, s.i));
      start = -1;
      s.i += 1;
      continue;
    }
    if (start < 0) start = s.i;
    advance(s);
  }
  if (start >= 0) out.push(text.slice(start));
  return out;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(["sudo", "env", "exec", "command", "nohup", "time", "npx", "bunx"]);
/** Package runners invoked as `<runner> run <program>`. */
const RUNNERS = new Set(["uv", "poetry", "pipenv"]);

/** Interpreters that take their program from stdin when given `-` or no script argument. */
const INTERPRETERS: Record<string, string> = {
  python: "python",
  pypy: "python",
  node: "javascript",
  nodejs: "javascript",
  bun: "typescript",
  deno: "typescript",
  tsx: "typescript",
  "ts-node": "typescript",
  ruby: "ruby",
  bash: "bash",
  sh: "bash",
  zsh: "bash",
  dash: "bash",
  ksh: "bash",
  swift: "swift",
};
/** Options that put the program on the command line, leaving stdin for data. */
const INLINE_PROGRAM = new Set(["-c", "-m", "-e", "--eval", "-p", "--print"]);
/** Commands whose stdin is always one language. */
const STDIN_LANGUAGES: Record<string, string> = {
  sqlite3: "sql",
  psql: "sql",
  mysql: "sql",
  mariadb: "sql",
  duckdb: "sql",
  sqlcmd: "sql",
  "clickhouse-client": "sql",
  jq: "json",
  gojq: "json",
  yq: "yaml",
};

const REDIRECT = /^(?:\d*>>?|\d*<|&>>?|\d*>&|\d*<&)(.*)$/;
const STDOUT_REDIRECT = /^(?:1?>>?|&>>?)(.*)$/;

function unquote(word: string): string {
  return word.replace(/^(['"])(.*)\1$/, "$2");
}

/** Strips `VAR=x` assignments and wrappers such as `sudo -u user`, `env` or `uv run` from a command's words. */
function programWords(input: string[]): string[] {
  const rest = [...input];
  for (;;) {
    const word = rest[0];
    if (word === undefined) return rest;
    if (ASSIGNMENT.test(word)) rest.shift();
    else if (WRAPPERS.has(word)) {
      rest.shift();
      while (rest[0]?.startsWith("-")) rest.splice(0, rest[0] === "-u" ? 2 : 1);
    } else if (RUNNERS.has(word) && rest[1] === "run") rest.splice(0, 2);
    else return rest;
  }
}

/** The program's own arguments: redirections and their targets are dropped. */
function argumentWords(args: string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k += 1) {
    const word = args[k] ?? "";
    const match = REDIRECT.exec(word);
    if (match === null) out.push(word);
    else if (match[1] === "") k += 1;
  }
  return out;
}

function stdoutTarget(args: string[]): string | undefined {
  for (let k = 0; k < args.length; k += 1) {
    const match = STDOUT_REDIRECT.exec(args[k] ?? "");
    if (match === null) continue;
    const target = match[1] === "" ? args[k + 1] : match[1];
    if (target !== undefined && !target.startsWith("&")) return target;
  }
  return undefined;
}

/** Grammar of what a command reads on stdin; `piped` holds the words of the command its output flows into. */
function stdinLanguage(input: string[], piped: string[] | null): string | null {
  const [program, ...args] = programWords(input);
  if (program === undefined) return null;
  const name = unquote(program).split("/").pop() ?? "";
  if (name === "cat" || name === "tee") {
    const target = name === "tee" ? argumentWords(args).find((a) => !a.startsWith("-")) : stdoutTarget(args);
    if (target !== undefined) return languageForPath(unquote(target));
    return piped === null ? null : stdinLanguage(piped, null);
  }
  const fixed = STDIN_LANGUAGES[name];
  if (fixed !== undefined) return fixed;
  if (name === "kubectl" || name === "oc") return args.includes("-") ? "yaml" : null;
  const language = INTERPRETERS[name] ?? INTERPRETERS[name.replace(/[\d.]+$/, "")];
  if (language === undefined) return null;
  const own = argumentWords(args);
  const script = (name === "deno" || name === "bun") && own[0] === "run" ? own.slice(1) : own;
  if (script.includes("-")) return language;
  const inline = language === "bash" ? script.includes("-c") : script.some((a) => INLINE_PROGRAM.has(a));
  return !inline && script.every((a) => a.startsWith("-")) ? language : null;
}

/** Grammar for the body of the here-document whose operator spans `[start, end)` on `line`; null when unknown. */
function heredocLanguage(line: string, start: number, end: number): string | null {
  const segments = simpleCommands(line);
  const own = segments.find((seg) => seg.start <= start && end <= seg.end);
  if (own === undefined) return null;
  const command = words(`${line.slice(own.start, start)} ${line.slice(end, own.end)}`);
  const target = own.piped
    ? segments.slice(segments.indexOf(own) + 1).find((seg) => seg.depth === own.depth)
    : undefined;
  return stdinLanguage(command, target === undefined ? null : words(line.slice(target.start, target.end)));
}

/** A private-use character standing in for the k-th heredoc operator while highlight.js sees the shell text. */
const placeholder = (k: number): string => String.fromCharCode(0xe000 + k);

function dimmed(text: string): string {
  return `<span class="sep">${escapeHtml(text)}</span>`;
}

/**
 * Highlighted HTML of a shell command whose here-document bodies are highlighted in their own
 * languages. The shell lines are highlighted in one pass with each operator replaced by a
 * placeholder, so quoting that spans a body (`"$(cat <<'EOF' ... EOF\n)"`) keeps its context and
 * highlight.js never takes an unquoted delimiter for the start of a string.
 */
export function highlightShell(command: string): string {
  const docs = findHeredocs(command);
  if (docs.length === 0) return highlightCode(command, "bash");
  const lines = command.split("\n");
  const taken = new Set<number>();
  for (const doc of docs) {
    for (let k = doc.bodyFrom; k < doc.bodyTo; k += 1) taken.add(k);
    if (doc.terminator !== null) taken.add(doc.terminator);
  }
  const shellIndices: number[] = [];
  const shellText: string[] = [];
  lines.forEach((text, index) => {
    if (taken.has(index)) return;
    let masked = text;
    for (let k = docs.length - 1; k >= 0; k -= 1) {
      const doc = docs[k];
      if (doc?.line === index) masked = masked.slice(0, doc.start) + placeholder(k) + masked.slice(doc.end);
    }
    shellIndices.push(index);
    shellText.push(masked);
  });
  const shellHtml = splitHighlightedLines(highlightCode(shellText.join("\n"), "bash"));
  const out: string[] = lines.map(() => "");
  shellIndices.forEach((index, n) => {
    out[index] = shellHtml[n] ?? "";
  });
  docs.forEach((doc, k) => {
    const operator = (lines[doc.line] ?? "").slice(doc.start, doc.end);
    out[doc.line] = (out[doc.line] ?? "").replace(placeholder(k), () => dimmed(operator));
    if (doc.bodyTo > doc.bodyFrom) {
      const body = lines.slice(doc.bodyFrom, doc.bodyTo).join("\n");
      const html = doc.language === "bash" ? highlightShell(body) : highlightCode(body, doc.language);
      splitHighlightedLines(html).forEach((lineHtml, j) => {
        out[doc.bodyFrom + j] = lineHtml;
      });
    }
    if (doc.terminator !== null) out[doc.terminator] = dimmed(lines[doc.terminator] ?? "");
  });
  return out.join("\n");
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
  const html =
    lines === null
      ? highlightShell(command)
      : lines
          .map((line) => {
            const sep = line.sep ? dimmed(line.sep) : "";
            return `${"  ".repeat(line.indent)}${highlightCode(line.code, "bash")}${sep}`;
          })
          .join("\n");
  return `<pre class="plain code lang-bash">${html}</pre>`;
}
