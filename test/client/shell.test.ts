import { describe, expect, test } from "bun:test";
import { findHeredocs, layoutShell, renderShellCommand, shellScript } from "../../src/client/shell";
import { textOf } from "../helpers";

const laidOut = (command: string) => {
  const lines = layoutShell(command);
  return lines === null ? null : lines.map((l) => `${"  ".repeat(l.indent)}${l.code}${l.sep}`).join("\n");
};

describe("layoutShell", () => {
  test("puts each top-level statement on its own line and indents loop bodies", () => {
    const command = `cd ..; for d in org-service vault-connections; do for env in preprod prod; do f=$(fd -p "application-$env.conf" $d/src 2>/dev/null | head -1); [ -n "$f" ] && echo "$f: $(rg -o 'issuer\\s*=\\s*"[^"]+"' $f | tr '\\n' ' ')"; done; done`;
    expect(laidOut(command)).toBe(
      [
        "cd ..;",
        "for d in org-service vault-connections;",
        "do",
        "  for env in preprod prod;",
        "  do",
        '    f=$(fd -p "application-$env.conf" $d/src 2>/dev/null | head -1);',
        `    [ -n "$f" ] && echo "$f: $(rg -o 'issuer\\s*=\\s*"[^"]+"' $f | tr '\\n' ' ')";`,
        "  done;",
        "done",
      ].join("\n"),
    );
  });

  test("gives if/then/elif/else/fi their own lines", () => {
    expect(laidOut("if [ -f x ]; then echo yes; elif [ -d x ]; then echo dir; else echo no; fi")).toBe(
      [
        "if [ -f x ];",
        "then",
        "  echo yes;",
        "elif [ -d x ];",
        "then",
        "  echo dir;",
        "else",
        "  echo no;",
        "fi",
      ].join("\n"),
    );
  });

  test("leaves separators inside quotes, substitutions, expansions, subshells and comments alone", () => {
    const command =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template
      "echo \"a; b\"; echo 'c; d'; echo $(a; b); x=${y//;/,}; find . -exec rm {} \\;; (cd a; make); echo `a; b`; echo $'x;y' # trailing; comment";
    expect(laidOut(command)).toBe(
      [
        'echo "a; b";',
        "echo 'c; d';",
        "echo $(a; b);",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template
        "x=${y//;/,};",
        "find . -exec rm {} \\;;",
        "(cd a; make);",
        "echo `a; b`;",
        "echo $'x;y' # trailing; comment",
      ].join("\n"),
    );
  });

  test("tracks quotes nested inside a double-quoted command substitution", () => {
    expect(laidOut("{ a; b; } > out; echo \"x $(y 'p;q'; z) w\"")).toBe(
      ["{", "  a;", "  b;", "} > out;", "echo \"x $(y 'p;q'; z) w\""].join("\n"),
    );
  });

  test("lays out case arms under the case head", () => {
    expect(laidOut('case "$1" in start) run;; stop) halt;; *) echo "usage";; esac')).toBe(
      ['case "$1" in', "  start) run;;", "  stop) halt;;", '  *) echo "usage";;', "esac"].join("\n"),
    );
  });

  test("leaves single statements and multi-line commands as they are", () => {
    expect(layoutShell("git commit -m 'a; b'")).toBeNull();
    expect(layoutShell("ls -la; ")).toBeNull();
    expect(layoutShell("cd a\nmake; make test")).toBeNull();
  });
});

describe("renderShellCommand", () => {
  test("highlights each line and dims the separators", () => {
    const html = renderShellCommand("cd x; for f in *.txt; do echo $f; done");
    expect(html).toContain('<span class="sep">;</span>');
    expect(html).toContain('<span class="hljs-keyword">for</span>');
    expect(textOf(html)).toBe("cd x;\nfor f in *.txt;\ndo\n  echo $f;\ndone");
  });

  test("renders a single statement as ordinary highlighted code", () => {
    expect(renderShellCommand("echo hi")).toBe(
      '<pre class="plain code lang-bash"><span class="hljs-built_in">echo</span> hi</pre>',
    );
  });
});

describe("shellScript", () => {
  test("shows the script of a shell -c argv and joins anything else", () => {
    expect(shellScript(["bash", "-lc", "cd a; ls"])).toBe("cd a; ls");
    expect(shellScript(["/bin/zsh", "-c", "pwd"])).toBe("pwd");
    expect(shellScript(["cat", "README.md"])).toBe("cat README.md");
    expect(shellScript(["bash", "-lc", "x", "extra"])).toBe("bash -lc x extra");
  });
});

describe("findHeredocs", () => {
  test("locates bodies and terminators, with <<- tabs and several documents on one line", () => {
    const command = [
      "cat <<-EOF > a.py",
      "\tx = 1",
      "\tEOF",
      "diff <(cat <<A) <(cat <<B)",
      "1",
      "A",
      "2",
      "B",
      "echo done",
    ].join("\n");
    const docs = findHeredocs(command);
    expect(
      docs.map((d) => [d.line, d.start, d.delimiter, d.bodyFrom, d.bodyTo, d.terminator, d.language]),
    ).toEqual([
      [0, 4, "EOF", 1, 2, 2, "python"],
      [3, 11, "A", 4, 5, 5, null],
      [3, 22, "B", 6, 7, 7, null],
    ]);
  });

  test("ignores here-strings, arithmetic shifts, quoted text and an operator nothing follows", () => {
    expect(findHeredocs('python3 - <<< "print(1)"\necho $((1<<2))\necho "a <<EOF"\nEOF')).toEqual([]);
    expect(findHeredocs("cat <<EOF")).toEqual([]);
  });

  test("runs an unterminated body to the end of the command", () => {
    const docs = findHeredocs("python3 - <<'EOF'\nprint(1)\nprint(2)");
    expect(docs.map((d) => [d.bodyFrom, d.bodyTo, d.terminator])).toEqual([[1, 3, null]]);
  });
});

describe("heredoc language", () => {
  const language = (line: string) => findHeredocs(`${line}\nx\nEOF`)[0]?.language ?? null;

  test("comes from the interpreter that reads its program from stdin", () => {
    expect(language("python3 - <<'EOF'")).toBe("python");
    expect(language("python3.12 <<EOF 2>&1 | tail -5")).toBe("python");
    expect(language("FOO=1 uv run python - <<EOF")).toBe("python");
    expect(language("node --input-type=module - <<EOF")).toBe("javascript");
    expect(language("deno run - <<EOF")).toBe("typescript");
    expect(language("ruby <<EOF")).toBe("ruby");
    expect(language("bash -s <<EOF")).toBe("bash");
    expect(language("bash -e <<EOF")).toBe("bash");
    expect(language("result=$(python3 - <<EOF")).toBe("python");
  });

  test("is unknown when the program comes from a file or the command line", () => {
    expect(language("python3 script.py <<EOF")).toBeNull();
    expect(language("python3 -c 'import sys' <<EOF")).toBeNull();
    expect(language("node -e 'x' <<EOF")).toBeNull();
    expect(language("bash -c 'read x' <<EOF")).toBeNull();
    expect(language("git commit -m \"$(cat <<'EOF'")).toBeNull();
  });

  test("comes from database clients, kubectl manifests and jq input", () => {
    expect(language("sudo -u postgres psql mydb <<EOF")).toBe("sql");
    expect(language("sqlite3 app.db <<EOF")).toBe("sql");
    expect(language("kubectl apply -f - <<EOF")).toBe("yaml");
    expect(language("kubectl get pods <<EOF")).toBeNull();
    expect(language("jq . <<EOF")).toBe("json");
  });

  test("comes from the name of the file cat or tee writes, directly or through a pipe", () => {
    expect(language("cat > src/app.py <<'EOF'")).toBe("python");
    expect(language("cat <<EOF >> ~/.zshrc")).toBe("bash");
    expect(language('cat <<EOF > "$HOME/.config/x/config.toml"')).toBe("ini");
    expect(language("cat <<'EOF' | sudo tee /etc/nginx/nginx.conf")).toBe("ini");
    expect(language("tee -a notes.md <<EOF")).toBe("markdown");
    expect(language("cat <<EOF | python3 -")).toBe("python");
    expect(language("cat <<EOF | python3 -c 'x'")).toBeNull();
    expect(language("cat <<EOF")).toBeNull();
  });
});

describe("renderShellCommand with here-documents", () => {
  test("highlights the body in the language of the command reading it and dims the frame", () => {
    const command = [
      "python3 - <<'EOF'",
      "import pathlib",
      'p = pathlib.Path("x")',
      "EOF",
      'echo "exit=$?"',
    ].join("\n");
    const html = renderShellCommand(command);
    expect(html).toContain('<span class="hljs-keyword">import</span>');
    expect(html).toContain(`<span class="sep">&lt;&lt;'EOF'</span>`);
    expect(html).toContain('<span class="sep">EOF</span>');
    expect(html).toContain('<span class="hljs-built_in">echo</span>');
    expect(textOf(html)).toBe(command);
  });

  test("keeps quoting context across a body and leaves a body of unknown language plain", () => {
    const command = ["git commit -m \"$(cat <<'EOF'", "Add thing", "", "import nothing", "EOF", ')"'].join(
      "\n",
    );
    const html = renderShellCommand(command);
    const lines = html.replace(/^<pre[^>]*>|<\/pre>$/g, "").split("\n");
    expect(lines[1]).toBe("Add thing");
    expect(lines[3]).toBe("import nothing");
    expect(lines[5]).toContain("hljs-string");
    expect(textOf(html)).toBe(command);
  });

  test("does not let an unquoted delimiter swallow the rest of the command as a string", () => {
    const html = renderShellCommand(["cat <<EOF > out.py", "print(1)", "EOF", "echo done"].join("\n"));
    expect(html).toContain('<span class="hljs-built_in">print</span>');
    expect(html).toContain('<span class="hljs-built_in">echo</span>');
  });
});
