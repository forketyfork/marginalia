import { describe, expect, test } from "bun:test";
import { renderJson, renderJsonOrPlain, tryParseJson } from "../../src/client/json";

/** What a reader sees and what quotes anchor to: the rendered text without markup. */
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

describe("tryParseJson", () => {
  test("accepts objects and arrays only", () => {
    expect(tryParseJson('{"a": 1}')).toEqual({ a: 1 });
    expect(tryParseJson("  [1, 2]\n")).toEqual([1, 2]);
    expect(tryParseJson('"just a string"')).toBeUndefined();
    expect(tryParseJson("42")).toBeUndefined();
    expect(tryParseJson("{not json")).toBeUndefined();
    expect(tryParseJson("plain text")).toBeUndefined();
  });
});

describe("renderJson", () => {
  test("lays out scalars, arrays and objects like a pretty-printer", () => {
    const html = renderJson({ a: 1, b: [true, null, "x"], c: {}, d: [], e: 'it\'s "quoted"' });
    expect(textOf(html)).toBe(
      [
        "{",
        '  "a": 1,',
        '  "b": [',
        "    true,",
        "    null,",
        '    "x"',
        "  ],",
        '  "c": {},',
        '  "d": [],',
        '  "e": "it\'s \\"quoted\\""',
        "}",
      ].join("\n"),
    );
    expect(html).toContain('<span class="hljs-attr">&quot;a&quot;</span>');
    expect(html).toContain('<span class="hljs-number">1</span>');
    expect(html).toContain('<span class="hljs-literal">null</span>');
  });

  test("shows multi-line and long strings as indented triple-quoted blocks with real line breaks", () => {
    const html = renderJson({ markdown: '### Header\ntext with "quotes" and \\ backslash', n: 2 });
    expect(textOf(html)).toBe(
      [
        "{",
        '  "markdown": """',
        "    ### Header",
        '    text with "quotes" and \\ backslash',
        '  """,',
        '  "n": 2',
        "}",
      ].join("\n"),
    );
    const long = "x".repeat(80);
    expect(textOf(renderJson([long]))).toBe(`[\n  """\n    ${long}\n  """\n]`);
    expect(textOf(renderJson(["short"]))).toBe('[\n  "short"\n]');
  });

  test("unfolds JSON that arrives encoded inside a string", () => {
    const inner = JSON.stringify({ results: "# Search\n\n1. hit", count: 1 });
    const html = renderJson([{ type: "text", text: inner }]);
    expect(textOf(html)).toBe(
      [
        "[",
        "  {",
        '    "type": "text",',
        '    "text": """',
        "      {",
        '        "results": """',
        "          # Search",
        "          ",
        "          1. hit",
        '        """,',
        '        "count": 1',
        "      }",
        '    """',
        "  }",
        "]",
      ].join("\n"),
    );
  });

  test("stops unfolding after three levels", () => {
    let value: unknown = { leaf: 1 };
    for (let i = 0; i < 4; i += 1) value = { wrapped: JSON.stringify(value) };
    const text = textOf(renderJson(value));
    expect(text.split('"""').length - 1).toBe(6);
    expect(text).toContain('{\\"leaf\\":1}');
  });

  test("escapes markup in keys and values", () => {
    const html = renderJson({ "<k>": "<b>bold</b>", block: "<i>\n</i>" });
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(textOf(html)).toContain('"<k>": "<b>bold</b>"');
  });
});

describe("renderJsonOrPlain", () => {
  test("falls through to a plain block for text that is not JSON", () => {
    expect(renderJsonOrPlain("hello <world>")).toBe('<pre class="plain">hello &lt;world&gt;</pre>');
    expect(renderJsonOrPlain('{"a": 1}')).toContain('class="plain code json"');
  });
});
