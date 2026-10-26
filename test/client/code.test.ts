import { describe, expect, test } from "bun:test";
import {
  highlightCode,
  languageForFence,
  languageForPath,
  renderCode,
  renderNumberedLines,
  splitHighlightedLines,
} from "../../src/client/code";

import { textOf } from "../helpers";

describe("language detection", () => {
  test("maps file paths by extension and by well-known name", () => {
    expect(languageForPath("/a/b/main.ts")).toBe("typescript");
    expect(languageForPath("script.PY")).toBe("python");
    expect(languageForPath("/x/Dockerfile")).toBe("dockerfile");
    expect(languageForPath("/home/me/.zshrc")).toBe("bash");
    expect(languageForPath("Cargo.toml")).toBe("ini");
    expect(languageForPath("notes.unknown")).toBe(null);
    expect(languageForPath("README")).toBe(null);
  });

  test("maps fence info strings through aliases and ignores unknown ones", () => {
    expect(languageForFence("ts")).toBe("ts");
    expect(languageForFence("Shell")).toBe("bash");
    expect(languageForFence("python title=x.py")).toBe("python");
    expect(languageForFence("c++")).toBe("cpp");
    expect(languageForFence("")).toBe(null);
    expect(languageForFence("mermaid")).toBe(null);
  });
});

describe("highlightCode", () => {
  test("highlights known languages and escapes everything", () => {
    const html = highlightCode('ls -la "$HOME" | grep <x>', "bash");
    expect(html).toContain('<span class="hljs-built_in">ls</span>');
    expect(html).toContain("&lt;x&gt;");
    expect(textOf(html)).toBe('ls -la "$HOME" | grep <x>');
  });

  test("returns escaped text without spans for an unknown language", () => {
    expect(highlightCode("a < b", null)).toBe("a &lt; b");
    expect(highlightCode("a < b", "klingon")).toBe("a &lt; b");
    expect(renderCode("x", "bash")).toBe('<pre class="plain code lang-bash">x</pre>');
  });
});

describe("splitHighlightedLines", () => {
  test("keeps every line self-contained by closing and reopening open spans", () => {
    const html = highlightCode("const s = `line one\nline two`;\nconst n = 1;", "javascript");
    const lines = splitHighlightedLines(html);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/<span class="hljs-string">`line one<\/span>$/);
    expect(lines[1]).toMatch(/^<span class="hljs-string">line two`<\/span>/);
    expect(lines.map(textOf)).toEqual(["const s = `line one", "line two`;", "const n = 1;"]);
    for (const line of lines) {
      expect((line.match(/<span/g) ?? []).length).toBe((line.match(/<\/span>/g) ?? []).length);
    }
  });
});

describe("renderNumberedLines", () => {
  test("puts cat -n numbers into a gutter that is not part of the text", () => {
    const html = renderNumberedLines("     1→import x\n     2→\n    10→print(x)\n", "python");
    expect(html).not.toBeNull();
    expect(html).toContain('<span class="ln" data-n="1"></span>');
    expect(html).toContain('<span class="ln" data-n="10"></span>');
    expect(html).toContain('<span class="hljs-keyword">import</span>');
    expect(textOf(html ?? "")).toBe("import x\n\nprint(x)");
  });

  test("accepts the tab-separated form current Claude Code versions emit", () => {
    const html = renderNumberedLines("66\t        return false;\n67\t    }\n", "rust");
    expect(html).toContain('<span class="ln" data-n="66"></span>');
    expect(textOf(html ?? "")).toBe("        return false;\n    }");
  });

  test("rejects text that is not numbered throughout", () => {
    expect(renderNumberedLines("     1→ok\nplain line", "python")).toBeNull();
    expect(renderNumberedLines("no numbers here", null)).toBeNull();
    expect(renderNumberedLines("", null)).toBeNull();
  });
});
