import { describe, expect, test } from "bun:test";
import { layoutShell, renderShellCommand, shellScript } from "../../src/client/shell";
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
      "echo \"a; b\"; echo 'c; d'; echo $(a; b); x=${y//;/,}; find . -exec rm {} \\;; (cd a; make); echo `a; b`; echo $'x;y' # trailing; comment";
    expect(laidOut(command)).toBe(
      [
        'echo "a; b";',
        "echo 'c; d';",
        "echo $(a; b);",
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
