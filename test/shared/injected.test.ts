import { describe, expect, test } from "bun:test";
import { segmentInjected } from "../../src/shared/injected";

describe("segmentInjected", () => {
  test("splits injected tags out of user text", () => {
    const text =
      "<system-reminder>\nnoise\n</system-reminder>\nReal question here\n<task-notification>done</task-notification>";
    expect(segmentInjected(text)).toEqual([
      { kind: "tag", tag: "system-reminder", text: "\nnoise\n" },
      { kind: "text", text: "\nReal question here\n" },
      { kind: "tag", tag: "task-notification", text: "done" },
    ]);
  });

  test("keeps plain text and unknown tags intact", () => {
    expect(segmentInjected("just <b>text</b>")).toEqual([{ kind: "text", text: "just <b>text</b>" }]);
    expect(segmentInjected("")).toEqual([]);
  });

  test("handles slash command envelopes", () => {
    const segments = segmentInjected(
      "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>",
    );
    expect(segments.map((s) => (s.kind === "tag" ? s.tag : "text"))).toEqual([
      "command-name",
      "command-message",
      "command-args",
    ]);
  });
});
