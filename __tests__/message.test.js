const { renderMessage, buildPlaceholders } = require("../src/message");

const pullRequest = {
  title: "Fix login",
  html_url: "https://github.com/o/r/pull/7",
  number: 7,
  user: { login: "alice" },
  base: { ref: "main" },
  head: { ref: "fix-login" },
};

describe("buildPlaceholders", () => {
  test("maps pull request fields", () => {
    expect(buildPlaceholders(pullRequest)).toEqual({
      title: "Fix login",
      url: "https://github.com/o/r/pull/7",
      number: "7",
      author: "alice",
      base: "main",
      head: "fix-login",
    });
  });

  test("falls back to empty strings", () => {
    expect(buildPlaceholders({})).toEqual({ title: "", url: "", number: "", author: "", base: "", head: "" });
  });
});

describe("renderMessage", () => {
  test("replaces known placeholders", () => {
    expect(renderMessage("🚨 Urgent PR: <{{url}}|{{title}}> needs review ASAP!", pullRequest)).toBe(
      "🚨 Urgent PR: <https://github.com/o/r/pull/7|Fix login> needs review ASAP!",
    );
  });

  test("tolerates whitespace inside placeholders", () => {
    expect(renderMessage("#{{ number }} by {{ author }}", pullRequest)).toBe("#7 by alice");
  });

  test("leaves unknown placeholders untouched", () => {
    expect(renderMessage("{{unknown}} {{title}}", pullRequest)).toBe("{{unknown}} Fix login");
  });

  test("preserves newlines and special characters", () => {
    const template = 'line one\n"quoted" `code`\n{{title}}';
    expect(renderMessage(template, pullRequest)).toBe('line one\n"quoted" `code`\nFix login');
  });
});
