const { decideNotification, collectReviewers, hasUrgentLabel } = require("../src/urgent");

const NOW = Date.parse("2026-01-01T00:10:00Z");
const FRESH_CREATED_AT = "2026-01-01T00:09:30Z";
const OLD_CREATED_AT = "2025-12-31T00:00:00Z";

function pr(overrides = {}) {
  return {
    created_at: OLD_CREATED_AT,
    labels: [],
    requested_reviewers: [],
    ...overrides,
  };
}

function decide(overrides = {}) {
  return decideNotification({
    urgentLabel: "urgent",
    freshWindowSeconds: 60,
    now: NOW,
    pullRequest: pr(),
    ...overrides,
  });
}

describe("collectReviewers", () => {
  test("cleans and filters reviewer logins", () => {
    expect(collectReviewers([{ login: " alice " }, { login: "" }, {}, { login: "bob" }])).toEqual(["alice", "bob"]);
  });

  test("returns an empty list for missing reviewers", () => {
    expect(collectReviewers(undefined)).toEqual([]);
  });
});

describe("hasUrgentLabel", () => {
  test("matches case-insensitively", () => {
    expect(hasUrgentLabel([{ name: "URGENT" }], "urgent")).toBe(true);
  });

  test("returns false when the label is absent", () => {
    expect(hasUrgentLabel([{ name: "bug" }], "urgent")).toBe(false);
    expect(hasUrgentLabel(undefined, "urgent")).toBe(false);
  });
});

describe("decideNotification - labeled", () => {
  test("fresh PR without reviewers posts to the channel only", async () => {
    const result = await decide({
      action: "labeled",
      label: { name: "urgent" },
      pullRequest: pr({ created_at: FRESH_CREATED_AT }),
    });
    expect(result).toMatchObject({ urgent: true, targetUsers: [], sendChannel: true, sendDm: false });
  });

  test("fresh PR with reviewers requested with the label defers to review_requested events", async () => {
    const result = await decide({
      action: "labeled",
      label: { name: "urgent" },
      pullRequest: pr({ created_at: FRESH_CREATED_AT, requested_reviewers: [{ login: "alice" }] }),
      loadTimeline: async () => ({
        labeled: [{ name: "urgent", createdAt: FRESH_CREATED_AT }],
        reviewRequests: [{ login: "alice", createdAt: FRESH_CREATED_AT }],
      }),
    });
    expect(result).toMatchObject({ urgent: true, targetUsers: [], sendChannel: false, sendDm: false });
  });

  test("fresh PR with reviewers requested before the label notifies them", async () => {
    const result = await decide({
      action: "labeled",
      label: { name: "urgent" },
      pullRequest: pr({ created_at: FRESH_CREATED_AT, requested_reviewers: [{ login: "alice" }] }),
      loadTimeline: async () => ({
        labeled: [{ name: "urgent", createdAt: "2026-01-01T00:09:38Z" }],
        reviewRequests: [{ login: "alice", createdAt: FRESH_CREATED_AT }],
      }),
    });
    expect(result).toMatchObject({ urgent: true, targetUsers: ["alice"], sendChannel: true, sendDm: true });
  });

  test("existing PR notifies all requested reviewers", async () => {
    const result = await decide({
      action: "labeled",
      label: { name: "Urgent" },
      pullRequest: pr({ requested_reviewers: [{ login: "alice" }, { login: "bob" }] }),
    });
    expect(result).toMatchObject({
      urgent: true,
      targetUsers: ["alice", "bob"],
      sendChannel: true,
      sendDm: true,
    });
  });

  test("existing PR without reviewers posts to the channel only", async () => {
    const result = await decide({ action: "labeled", label: { name: "urgent" } });
    expect(result).toMatchObject({ urgent: true, targetUsers: [], sendChannel: true, sendDm: false });
  });

  test("ignores other labels", async () => {
    const result = await decide({ action: "labeled", label: { name: "bug" } });
    expect(result).toMatchObject({ urgent: false, sendChannel: false, sendDm: false });
  });

  test("supports a custom urgent label", async () => {
    const result = await decide({ action: "labeled", label: { name: "P0" }, urgentLabel: "p0" });
    expect(result.urgent).toBe(true);
  });
});

describe("decideNotification - review_requested", () => {
  test("notifies the new reviewer on an urgent PR", async () => {
    const result = await decide({
      action: "review_requested",
      requestedReviewer: { login: "carol" },
      pullRequest: pr({ labels: [{ name: "urgent" }], requested_reviewers: [{ login: "carol" }] }),
    });
    expect(result).toMatchObject({
      urgent: true,
      targetUsers: ["carol"],
      sendChannel: true,
      sendDm: true,
    });
  });

  test("ignores PRs without the urgent label", async () => {
    const result = await decide({ action: "review_requested", requestedReviewer: { login: "carol" } });
    expect(result.urgent).toBe(false);
  });

  test("ignores team review requests without a user login", async () => {
    const result = await decide({
      action: "review_requested",
      pullRequest: pr({ labels: [{ name: "urgent" }] }),
    });
    expect(result.urgent).toBe(false);
  });
});

describe("decideNotification - other events", () => {
  test("returns no notification for unrelated actions", async () => {
    expect((await decide({ action: "opened" })).urgent).toBe(false);
  });

  test("returns no notification without a pull request payload", async () => {
    expect(
      (await decideNotification({ action: "labeled", urgentLabel: "urgent", freshWindowSeconds: 60 })).urgent,
    ).toBe(false);
  });

  test("treats an unparsable creation date as not fresh", async () => {
    const result = await decide({
      action: "labeled",
      label: { name: "urgent" },
      pullRequest: pr({ created_at: "not-a-date", requested_reviewers: [{ login: "alice" }] }),
    });
    expect(result).toMatchObject({ targetUsers: ["alice"], sendChannel: true, sendDm: true });
  });
});
