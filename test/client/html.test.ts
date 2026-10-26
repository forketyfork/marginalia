import { describe, expect, test } from "bun:test";
import { markPseudoTags, renderPlain } from "../../src/client/html";
import { textOf } from "../helpers";

describe("renderPlain", () => {
  test("marks pseudo-tags without changing the text", () => {
    const html = renderPlain("<IMPORTANT> a <b> & <SUBAGENT-STOP/> </IMPORTANT> <T>");
    expect(html).toBe(
      '<pre class="plain"><span class="ptag">&lt;IMPORTANT&gt;</span> a &lt;b&gt; &amp; &lt;SUBAGENT-STOP/&gt; <span class="ptag">&lt;/IMPORTANT&gt;</span> &lt;T&gt;</pre>',
    );
    expect(textOf(html)).toBe("<IMPORTANT> a <b> & <SUBAGENT-STOP/> </IMPORTANT> <T>");
  });

  test("only touches escaped tags", () => {
    expect(markPseudoTags("<IMPORTANT>")).toBe("<IMPORTANT>");
  });
});
