const { createPullRequestStateLoader, createTimelineLoader, isRetryableError } = require("../src/pull-request-state");

function httpError(status, message = `HTTP ${status}`) {
  return Object.assign(new Error(message), { status });
}

function octokitWith(get) {
  return { rest: { pulls: { get } } };
}

const PR_DATA = {
  labels: [{ name: "urgent" }],
  requested_reviewers: [{ login: "alice" }, { login: "Bob" }, {}],
  requested_teams: [{ slug: "core" }],
};

describe("createPullRequestStateLoader", () => {
  test("reads the pull request from the context repository and maps users and teams", async () => {
    const get = jest.fn().mockResolvedValue({ data: PR_DATA });
    const load = createPullRequestStateLoader({ octokit: octokitWith(get), owner: "o", repo: "r", pullNumber: 7 });

    await expect(load()).resolves.toEqual({
      labels: [{ name: "urgent" }],
      requestedUsers: ["alice", "Bob"],
      requestedTeams: ["core"],
    });
    expect(get).toHaveBeenCalledWith({ owner: "o", repo: "r", pull_number: 7 });
  });

  test("memoizes the read within a run", async () => {
    const get = jest.fn().mockResolvedValue({ data: PR_DATA });
    const load = createPullRequestStateLoader({ octokit: octokitWith(get), owner: "o", repo: "r", pullNumber: 7 });

    await load();
    await load();
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("retries transient errors with bounded, injected delays and warnings", async () => {
    const get = jest
      .fn()
      .mockRejectedValueOnce(httpError(502))
      .mockRejectedValueOnce(httpError(500, "socket hang up"))
      .mockResolvedValue({ data: PR_DATA });
    const sleep = jest.fn().mockResolvedValue();
    const warn = jest.fn();
    const load = createPullRequestStateLoader({
      octokit: octokitWith(get),
      owner: "o",
      repo: "r",
      pullNumber: 7,
      sleep,
      warn,
    });

    await expect(load()).resolves.toMatchObject({ requestedUsers: ["alice", "Bob"] });
    expect(get).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[1000], [3000]]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/attempt 1\/3: HTTP 502/));
  });

  test("gives up after the last attempt", async () => {
    const get = jest.fn().mockRejectedValue(httpError(503));
    const sleep = jest.fn().mockResolvedValue();
    const load = createPullRequestStateLoader({
      octokit: octokitWith(get),
      owner: "o",
      repo: "r",
      pullNumber: 7,
      retryDelaysMs: [5, 10],
      sleep,
    });

    await expect(load()).rejects.toThrow("HTTP 503");
    expect(get).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[5], [10]]);
  });

  test("does not retry permission errors", async () => {
    const get = jest.fn().mockRejectedValue(httpError(403, "Resource not accessible by integration"));
    const sleep = jest.fn();
    const load = createPullRequestStateLoader({
      octokit: octokitWith(get),
      owner: "o",
      repo: "r",
      pullNumber: 7,
      sleep,
    });

    await expect(load()).rejects.toThrow("Resource not accessible by integration");
    expect(get).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test("rejects without calling the API when the pull request number is missing", async () => {
    const get = jest.fn();
    const load = createPullRequestStateLoader({
      octokit: octokitWith(get),
      owner: "o",
      repo: "r",
      pullNumber: undefined,
    });

    await expect(load()).rejects.toThrow(/pull request number/);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("createTimelineLoader", () => {
  const listEventsForTimeline = jest.fn();
  const octokitWithTimeline = (paginate) => ({ paginate, rest: { issues: { listEventsForTimeline } } });
  const EVENTS = [
    { event: "labeled", label: { name: "urgent" }, created_at: "2026-01-01T00:00:08Z" },
    { event: "review_requested", requested_reviewer: { login: "alice" }, created_at: "2026-01-01T00:00:00Z" },
    { event: "review_requested", requested_team: { slug: "core" }, created_at: "2026-01-01T00:00:00Z" },
    { event: "unlabeled", label: { name: "urgent" }, created_at: "2026-01-01T00:00:05Z" },
    { event: "commented", created_at: "2026-01-01T00:00:06Z" },
    { event: "labeled", label: { name: "bug" } },
  ];

  test("reads every timeline page from the context repository and keeps labeled and user review requests", async () => {
    const paginate = jest.fn().mockResolvedValue(EVENTS);
    const load = createTimelineLoader({ octokit: octokitWithTimeline(paginate), owner: "o", repo: "r", pullNumber: 7 });

    await expect(load()).resolves.toEqual({
      labeled: [{ name: "urgent", createdAt: "2026-01-01T00:00:08Z" }],
      reviewRequests: [{ login: "alice", createdAt: "2026-01-01T00:00:00Z" }],
    });
    await load();
    expect(paginate).toHaveBeenCalledTimes(1);
    expect(paginate).toHaveBeenCalledWith(listEventsForTimeline, {
      owner: "o",
      repo: "r",
      issue_number: 7,
      per_page: 100,
    });
  });

  test("retries transient errors and does not retry permission errors", async () => {
    const sleep = jest.fn().mockResolvedValue();
    const warn = jest.fn();
    const flaky = jest.fn().mockRejectedValueOnce(httpError(502)).mockResolvedValue(EVENTS);
    await createTimelineLoader({
      octokit: octokitWithTimeline(flaky),
      owner: "o",
      repo: "r",
      pullNumber: 7,
      sleep,
      warn,
    })();
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/timeline of pull request #7 failed \(attempt 1\/3: HTTP 502/),
    );

    const denied = jest.fn().mockRejectedValue(httpError(403));
    const load = createTimelineLoader({
      octokit: octokitWithTimeline(denied),
      owner: "o",
      repo: "r",
      pullNumber: 7,
      sleep,
    });
    await expect(load()).rejects.toThrow("HTTP 403");
    expect(denied).toHaveBeenCalledTimes(1);
  });

  test("rejects without calling the API when the pull request number is missing", async () => {
    const paginate = jest.fn();
    const load = createTimelineLoader({ octokit: octokitWithTimeline(paginate), owner: "o", repo: "r", pullNumber: 0 });
    await expect(load()).rejects.toThrow(/pull request number/);
    expect(paginate).not.toHaveBeenCalled();
  });
});

describe("isRetryableError", () => {
  test.each([
    [httpError(500), true],
    [httpError(429), true],
    [new Error("not a request error"), false],
    [httpError(403), false],
    [httpError(404), false],
  ])("%p -> %p", (error, expected) => {
    expect(isRetryableError(error)).toBe(expected);
  });
});
