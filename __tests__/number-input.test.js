const { parseNumberInput } = require("../src/number-input");

describe("parseNumberInput", () => {
  test("returns the default for empty input", () => {
    expect(parseNumberInput("fresh-pr-window-seconds", "", 60)).toBe(60);
    expect(parseNumberInput("fresh-pr-window-seconds", "   ", 60)).toBe(60);
  });

  test("parses numeric values", () => {
    expect(parseNumberInput("fresh-pr-window-seconds", " 120 ", 60)).toBe(120);
    expect(parseNumberInput("fresh-pr-window-seconds", "0", 60)).toBe(0);
  });

  test("rejects invalid values", () => {
    expect(() => parseNumberInput("fresh-pr-window-seconds", "abc", 60)).toThrow(/non-negative number/);
    expect(() => parseNumberInput("fresh-pr-window-seconds", "-1", 60)).toThrow(/non-negative number/);
  });
});
