import { describe, expect, test } from "bun:test";
import { parseGemini } from "../../src/parsers/gemini";
import { loadGeminiProjects } from "../../src/server/catalog";
import { FIXTURES, GEMINI_PATH } from "../helpers";

describe("parseGemini", () => {
  test("maps the project hash to a directory and converts thoughts to thinking blocks", async () => {
    const projects = await loadGeminiProjects(`${FIXTURES}/gemini/projects.json`);
    const t = parseGemini(await Bun.file(GEMINI_PATH).text(), {
      path: GEMINI_PATH,
      fallbackId: "x",
      projects,
    });
    expect(t.id).toBe("77677bcc-aacf-4707-a24c-f9aa1a7a645a");
    expect(t.cwd).toBe("/Users/alice/dev/demo");
    expect(t.entries.map((e) => e.kind)).toEqual(["system", "user", "assistant"]);
    const assistant = t.entries[2];
    expect(assistant?.blocks.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(assistant?.blocks[0]).toMatchObject({ text: "**Assessing**\n\nFormulating a greeting." });
    expect(assistant?.model).toBe("gemini-3-flash-preview");
    expect(assistant?.usage).toEqual({
      input: 12216,
      output: 21,
      cacheRead: 0,
      cacheCreation: 0,
      thinking: 122,
    });
    expect(t.title).toBe("Hello!");
    expect(t.endedAt).toBe(Date.parse("2026-05-04T05:37:55.968Z"));
  });

  test("leaves cwd unknown when the project hash is unmapped", async () => {
    const t = parseGemini(await Bun.file(GEMINI_PATH).text(), {
      path: GEMINI_PATH,
      fallbackId: "x",
      projects: new Map(),
    });
    expect(t.cwd).toBeNull();
    expect(t.info.extra.projectHash).toHaveLength(64);
  });
});
