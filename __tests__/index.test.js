const core = require("@actions/core");
jest.mock("@actions/github", () => ({ context: { payload: {} } }));
const github = require("@actions/github");
const { run } = require("../index");

function mockInputs(overrides = {}) {
  const inputs = {
    "urgent-label": "",
    "message-template": "",
    "fresh-pr-window-seconds": "",
    ...overrides,
  };
  jest.spyOn(core, "getInput").mockImplementation((name) => inputs[name] ?? "");
}

function outputsOf(spy) {
  return Object.fromEntries(spy.mock.calls);
}

describe("run", () => {
  let setFailedSpy;
  let setOutputSpy;

  beforeEach(() => {
    setFailedSpy = jest.spyOn(core, "setFailed").mockImplementation(() => {});
    setOutputSpy = jest.spyOn(core, "setOutput").mockImplementation(() => {});
    jest.spyOn(core, "info").mockImplementation(() => {});
    github.context.payload = {};
  });

  afterEach(() => jest.restoreAllMocks());

  test("emits reviewer targets when an older PR is labeled urgent", async () => {
    mockInputs();
    github.context.payload = {
      action: "labeled",
      label: { name: "urgent" },
      pull_request: {
        created_at: "2020-01-01T00:00:00Z",
        title: "Fix login",
        html_url: "https://github.com/o/r/pull/7",
        labels: [{ name: "urgent" }],
        requested_reviewers: [{ login: "alice" }, { login: "bob" }],
      },
    };

    await run();

    expect(setFailedSpy).not.toHaveBeenCalled();
    expect(outputsOf(setOutputSpy)).toEqual({
      urgent: "true",
      "target-users": "alice,bob",
      "send-channel": "true",
      "send-dm": "true",
      message: "🚨 Urgent PR: <https://github.com/o/r/pull/7|Fix login> needs review ASAP!",
    });
  });

  test("emits the new reviewer on review_requested for an urgent PR", async () => {
    mockInputs({ "message-template": "PR #{{number}} needs {{author}} reviewed" });
    github.context.payload = {
      action: "review_requested",
      requested_reviewer: { login: "carol" },
      pull_request: {
        created_at: "2020-01-01T00:00:00Z",
        number: 42,
        user: { login: "dave" },
        labels: [{ name: "Urgent" }],
        requested_reviewers: [{ login: "carol" }],
      },
    };

    await run();

    expect(outputsOf(setOutputSpy)).toEqual({
      urgent: "true",
      "target-users": "carol",
      "send-channel": "true",
      "send-dm": "true",
      message: "PR #42 needs dave reviewed",
    });
  });

  test("emits no notification for non-urgent events", async () => {
    mockInputs();
    github.context.payload = {
      action: "labeled",
      label: { name: "bug" },
      pull_request: { created_at: "2020-01-01T00:00:00Z", labels: [], requested_reviewers: [] },
    };

    await run();

    expect(outputsOf(setOutputSpy)).toEqual({
      urgent: "false",
      "target-users": "",
      "send-channel": "false",
      "send-dm": "false",
      message: "",
    });
  });

  test("skips when there is no pull request payload", async () => {
    mockInputs();
    github.context.payload = { action: "labeled" };

    await run();

    expect(setFailedSpy).not.toHaveBeenCalled();
    expect(setOutputSpy).toHaveBeenCalledWith("urgent", "false");
  });

  test("supports a custom urgent label", async () => {
    mockInputs({ "urgent-label": "P0" });
    github.context.payload = {
      action: "labeled",
      label: { name: "p0" },
      pull_request: { created_at: "2020-01-01T00:00:00Z", labels: [], requested_reviewers: [] },
    };

    await run();

    expect(setOutputSpy).toHaveBeenCalledWith("urgent", "true");
    expect(setOutputSpy).toHaveBeenCalledWith("send-channel", "true");
  });

  test("honours a custom fresh window", async () => {
    mockInputs({ "fresh-pr-window-seconds": "86400" });
    github.context.payload = {
      action: "labeled",
      label: { name: "urgent" },
      pull_request: {
        created_at: new Date(Date.now() - 60_000).toISOString(),
        labels: [],
        requested_reviewers: [{ login: "alice" }],
      },
    };

    await run();

    expect(setOutputSpy).toHaveBeenCalledWith("target-users", "");
    expect(setOutputSpy).toHaveBeenCalledWith("send-channel", "false");
  });

  test("fails on an invalid fresh window input", async () => {
    mockInputs({ "fresh-pr-window-seconds": "soon" });

    await run();

    expect(setFailedSpy).toHaveBeenCalledWith(expect.stringMatching(/non-negative number/));
  });
});
