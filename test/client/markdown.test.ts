import { describe, expect, test } from "bun:test";
import { parseMarkdown } from "../../src/client/markdown";

describe("parseMarkdown", () => {
  test("marks emphasis pseudo-tags inline, including names CommonMark does not treat as tags", () => {
    const html = parseMarkdown(
      "after <EXTREMELY_IMPORTANT>x</EXTREMELY_IMPORTANT> and <IMPORTANT>y</IMPORTANT>",
    );
    expect(html).toContain(
      '<span class="ptag">&lt;EXTREMELY_IMPORTANT&gt;</span>x<span class="ptag">&lt;/EXTREMELY_IMPORTANT&gt;</span>',
    );
    expect(html).toContain(
      '<span class="ptag">&lt;IMPORTANT&gt;</span>y<span class="ptag">&lt;/IMPORTANT&gt;</span>',
    );
  });

  test("renders a block that opens with a pseudo-tag as Markdown with its line breaks", () => {
    const html = parseMarkdown("<IMPORTANT>\nDo not do **X**.\n</IMPORTANT>\n\nafter");
    expect(html).toContain(
      '<span class="ptag">&lt;IMPORTANT&gt;</span><br>Do not do <strong>X</strong>.<br><span class="ptag">&lt;/IMPORTANT&gt;</span>',
    );
    expect(html).toContain("<p>after</p>");
  });

  test("still escapes ordinary HTML and leaves code spans and generics alone", () => {
    expect(parseMarkdown("text <span>a</span> and `<IMPORTANT>` and List<T>")).toBe(
      "<p>text &lt;span&gt;a&lt;/span&gt; and <code>&lt;IMPORTANT&gt;</code> and List&lt;T&gt;</p>\n",
    );
    expect(parseMarkdown("<div>\n<IMPORTANT>x</IMPORTANT>\n</div>")).toBe(
      '&lt;div&gt;\n<span class="ptag">&lt;IMPORTANT&gt;</span>x<span class="ptag">&lt;/IMPORTANT&gt;</span>\n&lt;/div&gt;',
    );
  });
});
