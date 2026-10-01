const core = require("@actions/core");
jest.mock("@actions/github", () => ({
  context: { payload: {}, repo: { owner: "o", repo: "r" } },
  getOctokit: jest.fn(),
}));
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
    jest.spyOn(core, "warning").mockImplementation(() => {});
    github.context.payload = {};
    github.getOctokit.mockReset();
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
      "mention-users": "alice,bob",
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
      "mention-users": "carol",
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
      "mention-users": "",
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

  test("wires mention-users for an initial review request using the context repository", async () => {
    const token = "fake-test-token-value";
    mockInputs({ "github-token": token });
    const get = jest.fn().mockResolvedValue({
      data: {
        labels: [{ name: "urgent" }],
        requested_reviewers: [{ login: "carol" }, { login: "Alice" }, { login: "bob" }],
        requested_teams: [{ slug: "core" }],
      },
    });
    github.getOctokit.mockReturnValue({ rest: { pulls: { get } } });
    github.context.payload = {
      action: "review_requested",
      requested_reviewer: { login: "bob" },
      pull_request: {
        number: 42,
        url: "https://attacker.example/repos/x/y/pulls/1",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:01Z",
        html_url: "https://github.com/o/r/pull/42",
        title: "Fix",
        labels: [{ name: "urgent" }],
        requested_reviewers: [{ login: "bob" }],
      },
    };

    await run();

    expect(setFailedSpy).not.toHaveBeenCalled();
    expect(github.getOctokit).toHaveBeenCalledWith(token);
    expect(get).toHaveBeenCalledWith({ owner: "o", repo: "r", pull_number: 42 });
    expect(outputsOf(setOutputSpy)).toEqual({
      urgent: "true",
      "target-users": "bob",
      "mention-users": "Alice,bob,carol",
      "send-channel": "false",
      "send-dm": "true",
      message: "🚨 Urgent PR: <https://github.com/o/r/pull/42|Fix> needs review ASAP!",
    });
    const logged = [...core.info.mock.calls, ...core.warning.mock.calls].flat().join("\n");
    expect(logged).not.toContain(token);
  });

  test("warns and keeps the DM when the API read fails", async () => {
    mockInputs({ "github-token": "token" });
    const get = jest.fn().mockRejectedValue(Object.assign(new Error("Resource not accessible"), { status: 403 }));
    github.getOctokit.mockReturnValue({ rest: { pulls: { get } } });
    github.context.payload = {
      action: "review_requested",
      requested_reviewer: { login: "alice" },
      pull_request: {
        number: 42,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:01Z",
        labels: [{ name: "urgent" }],
        requested_reviewers: [{ login: "alice" }],
      },
    };

    await run();

    expect(setFailedSpy).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/Resource not accessible/));
    expect(setOutputSpy).toHaveBeenCalledWith("target-users", "alice");
    expect(setOutputSpy).toHaveBeenCalledWith("mention-users", "alice");
    expect(setOutputSpy).toHaveBeenCalledWith("send-dm", "true");
  });

  test("skips team review requests without reading the API", async () => {
    mockInputs({ "github-token": "token" });
    const get = jest.fn();
    github.getOctokit.mockReturnValue({ rest: { pulls: { get } } });
    github.context.payload = {
      action: "review_requested",
      requested_team: { slug: "core" },
      pull_request: {
        number: 42,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:01Z",
        labels: [{ name: "urgent" }],
        requested_reviewers: [],
      },
    };

    await run();

    expect(get).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(expect.stringMatching(/Team review requests are not expanded/));
    expect(setOutputSpy).toHaveBeenCalledWith("urgent", "false");
    expect(setOutputSpy).toHaveBeenCalledWith("mention-users", "");
  });

  test("fails on an invalid fresh window input", async () => {
    mockInputs({ "fresh-pr-window-seconds": "soon" });

    await run();

    expect(setFailedSpy).toHaveBeenCalledWith(expect.stringMatching(/non-negative number/));
  });
});
