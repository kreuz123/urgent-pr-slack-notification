const { decideNotification, normalizeReviewerList, computeEventAge, buildOwnership } = require("../src/urgent");

// Unit-level simulation only: every "run" below is a direct decideNotification
// call with mocked GitHub API state. None of these tests talk to GitHub or Slack.

const CREATED_AT = "2026-01-01T00:00:00Z";
const at = (seconds) => new Date(Date.parse(CREATED_AT) + seconds * 1000).toISOString();
const nowAt = (seconds) => Date.parse(CREATED_AT) + seconds * 1000;
const URGENT = [{ name: "urgent" }];

function liveState(users, { labels = URGENT, teams = [] } = {}) {
  return jest.fn().mockResolvedValue({ labels, requestedUsers: users, requestedTeams: teams });
}

function failingState(message = "Service Unavailable") {
  return jest.fn().mockRejectedValue(Object.assign(new Error(message), { status: 503 }));
}

// Timeline mock: `labeledAt` lists the seconds of urgent labeled events, `requests`
// maps each reviewer login to the second(s) of its review_requested events.
function timeline({ labeledAt = [], requests = {} } = {}) {
  return jest.fn().mockResolvedValue({
    labeled: labeledAt.map((seconds) => ({ name: "urgent", createdAt: at(seconds) })),
    reviewRequests: Object.entries(requests).flatMap(([login, seconds]) =>
      [].concat(seconds).map((second) => ({ login, createdAt: at(second) })),
    ),
  });
}

function reviewRun(login, { labels = URGENT, payloadReviewers = [login], updatedAt = 1, now = 10, ...rest } = {}) {
  return decideNotification({
    action: "review_requested",
    requestedReviewer: { login },
    pullRequest: {
      created_at: CREATED_AT,
      updated_at: updatedAt === null ? undefined : at(updatedAt),
      labels,
      requested_reviewers: payloadReviewers.map((name) => ({ login: name })),
    },
    urgentLabel: "urgent",
    freshWindowSeconds: 60,
    now: nowAt(now),
    ...rest,
  });
}

function labeledRun({ payloadReviewers = [], updatedAt = 1, now = 10, ...rest } = {}) {
  return decideNotification({
    action: "labeled",
    label: { name: "urgent" },
    pullRequest: {
      created_at: CREATED_AT,
      updated_at: at(updatedAt),
      labels: URGENT,
      requested_reviewers: payloadReviewers.map((name) => ({ login: name })),
    },
    urgentLabel: "urgent",
    freshWindowSeconds: 60,
    now: nowAt(now),
    ...rest,
  });
}

function summarize(decisions) {
  const urgent = decisions.filter((decision) => decision.urgent);
  return {
    channelMessages: urgent.filter((decision) => decision.sendChannel).map((decision) => decision.mentionUsers),
    dms: urgent.filter((decision) => decision.sendDm).flatMap((decision) => decision.targetUsers),
  };
}

function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  );
}

describe("normalizeReviewerList", () => {
  test("dedupes case-insensitively, keeps the first spelling and sorts deterministically", () => {
    expect(normalizeReviewerList(["Bob", " alice ", "ALICE", "carol", "", null, "bob"])).toEqual([
      "alice",
      "Bob",
      "carol",
    ]);
  });

  test("returns an empty list for non-arrays", () => {
    expect(normalizeReviewerList(undefined)).toEqual([]);
  });
});

describe("computeEventAge", () => {
  test("uses the payload updated_at, independent of execution time", () => {
    expect(computeEventAge({ created_at: CREATED_AT, updated_at: at(2) }, nowAt(500))).toEqual({
      eventAgeSeconds: 2,
      ageSource: "payload-updated-at",
    });
  });

  test("falls back to execution time without updated_at", () => {
    expect(computeEventAge({ created_at: CREATED_AT }, nowAt(500))).toEqual({
      eventAgeSeconds: 500,
      ageSource: "execution-time",
    });
  });
});

describe("initial review_requested batch with identical snapshots", () => {
  test("3 reviewers: exactly one channel decision mentioning all, each run DMs only its own reviewer", async () => {
    const state = liveState(["carol", "alice", "bob"]);
    const decisions = await Promise.all(
      ["alice", "bob", "carol"].map((login) => reviewRun(login, { loadPullRequestState: state })),
    );

    expect(decisions.map((decision) => decision.targetUsers)).toEqual([["alice"], ["bob"], ["carol"]]);
    for (const decision of decisions) {
      expect(decision).toMatchObject({
        urgent: true,
        sendDm: true,
        mentionUsers: ["alice", "bob", "carol"],
        initial: true,
        reviewerSource: "api",
      });
    }
    expect(summarize(decisions)).toEqual({
      channelMessages: [["alice", "bob", "carol"]],
      dms: ["alice", "bob", "carol"],
    });
  });

  test("leader is the same for every event order and API list order", async () => {
    for (const apiOrder of permutations(["carol", "alice", "bob"])) {
      for (const eventOrder of permutations(["carol", "alice", "bob"])) {
        const decisions = [];
        for (const login of eventOrder) {
          decisions.push(await reviewRun(login, { loadPullRequestState: liveState(apiOrder) }));
        }
        expect(summarize(decisions).channelMessages).toEqual([["alice", "bob", "carol"]]);
        expect(decisions.find((decision) => decision.sendChannel).targetUsers).toEqual(["alice"]);
      }
    }
  });

  test("handles case differences and duplicates between payload and API", async () => {
    const state = liveState(["Bob", "alice", "ALICE", "carol"]);
    const decisions = await Promise.all(
      ["ALICE", "BOB", "Carol"].map((login) => reviewRun(login, { loadPullRequestState: state })),
    );

    expect(summarize(decisions)).toEqual({
      channelMessages: [["alice", "Bob", "carol"]],
      dms: ["ALICE", "BOB", "Carol"],
    });
  });

  test("adds the triggering reviewer when the API list no longer contains it", async () => {
    const leader = await reviewRun("alice", { loadPullRequestState: liveState(["bob", "carol"]) });
    expect(leader).toMatchObject({
      targetUsers: ["alice"],
      mentionUsers: ["alice", "bob", "carol"],
      sendChannel: true,
    });

    const follower = await reviewRun("zed", { loadPullRequestState: liveState(["bob"]) });
    expect(follower).toMatchObject({
      targetUsers: ["zed"],
      mentionUsers: ["bob", "zed"],
      sendChannel: false,
      sendDm: true,
    });
  });

  test("single reviewer and empty API list both elect the triggering reviewer", async () => {
    expect(await reviewRun("alice", { loadPullRequestState: liveState(["alice"]) })).toMatchObject({
      mentionUsers: ["alice"],
      sendChannel: true,
      sendDm: true,
    });
    expect(await reviewRun("alice", { loadPullRequestState: liveState([]) })).toMatchObject({
      mentionUsers: ["alice"],
      sendChannel: true,
      sendDm: true,
    });
  });

  test("a run delayed past the old 60s execution-time boundary stays in the initial batch", async () => {
    const state = liveState(["alice", "bob", "carol"]);
    const decisions = [
      await reviewRun("alice", { now: 50, loadPullRequestState: state }),
      await reviewRun("bob", { now: 70, loadPullRequestState: state }),
      await reviewRun("carol", { now: 600, loadPullRequestState: state }),
    ];
    expect(decisions.every((decision) => decision.initial)).toBe(true);
    expect(summarize(decisions).channelMessages).toEqual([["alice", "bob", "carol"]]);
  });
});

describe("initial review_requested - teams", () => {
  test("team requests are ignored and do not read the API", async () => {
    const state = liveState(["alice"], { teams: ["core"] });
    const result = await decideNotification({
      action: "review_requested",
      pullRequest: { created_at: CREATED_AT, updated_at: at(1), labels: URGENT, requested_reviewers: [] },
      urgentLabel: "urgent",
      freshWindowSeconds: 60,
      now: nowAt(10),
      loadPullRequestState: state,
    });
    expect(result).toMatchObject({ urgent: false, sendChannel: false, sendDm: false, mentionUsers: [] });
    expect(state).not.toHaveBeenCalled();
  });

  test("requested teams are not expanded into mentions", async () => {
    const result = await reviewRun("alice", { loadPullRequestState: liveState(["alice"], { teams: ["core"] }) });
    expect(result).toMatchObject({ mentionUsers: ["alice"], targetUsers: ["alice"], sendChannel: true });
  });

  test("team-only urgent creation posts a channel message without mentions from the label run", async () => {
    const result = await labeledRun({ loadPullRequestState: liveState([], { teams: ["core"] }) });
    expect(result).toMatchObject({ urgent: true, sendChannel: true, sendDm: false, mentionUsers: [], targetUsers: [] });
  });
});

describe("unchanged behaviour outside the initial batch", () => {
  test("later review request on an urgent PR posts and DMs without reading the API", async () => {
    const state = liveState(["alice", "bob"]);
    const result = await reviewRun("bob", { updatedAt: 3600, now: 3605, loadPullRequestState: state });
    expect(result).toMatchObject({
      urgent: true,
      targetUsers: ["bob"],
      mentionUsers: ["bob"],
      sendChannel: true,
      sendDm: true,
      initial: false,
    });
    expect(state).not.toHaveBeenCalled();
  });

  test("later review request on a non-urgent PR does nothing", async () => {
    const state = liveState(["alice"]);
    const result = await reviewRun("alice", { labels: [], updatedAt: 3600, now: 3605, loadPullRequestState: state });
    expect(result.urgent).toBe(false);
    expect(state).not.toHaveBeenCalled();
  });

  test("initial review request on a PR that is not urgent anywhere does nothing", async () => {
    const result = await reviewRun("alice", { labels: [], loadPullRequestState: liveState(["alice"], { labels: [] }) });
    expect(result).toMatchObject({ urgent: false, sendChannel: false, sendDm: false, mentionUsers: [] });
  });

  test("later urgent labeling notifies all payload reviewers without reading the API", async () => {
    const state = liveState([]);
    const result = await labeledRun({
      payloadReviewers: ["bob", "alice"],
      updatedAt: 3600,
      now: 3605,
      loadPullRequestState: state,
    });
    expect(result).toMatchObject({
      targetUsers: ["bob", "alice"],
      mentionUsers: ["bob", "alice"],
      sendChannel: true,
      sendDm: true,
    });
    expect(state).not.toHaveBeenCalled();
  });
});

describe("initial labeled interactions", () => {
  test("label payload with reviewers requested in the same second defers to the review runs", async () => {
    const result = await labeledRun({
      payloadReviewers: ["alice"],
      loadPullRequestState: liveState(["alice"]),
      loadTimeline: timeline({ labeledAt: [0], requests: { alice: 0 } }),
    });
    expect(result).toMatchObject({
      urgent: true,
      sendChannel: false,
      sendDm: false,
      mentionUsers: [],
      ownership: "timeline",
    });
  });

  test("empty label payload defers when the API already shows individual reviewers", async () => {
    const result = await labeledRun({
      loadPullRequestState: liveState(["alice"]),
      loadTimeline: timeline({ labeledAt: [0], requests: { alice: 1 } }),
    });
    expect(result).toMatchObject({ urgent: true, sendChannel: false, sendDm: false, reviewerSource: "api" });
  });

  test("empty label payload posts channel-only when the API shows no reviewers", async () => {
    const result = await labeledRun({ loadPullRequestState: liveState([]) });
    expect(result).toMatchObject({ urgent: true, sendChannel: true, sendDm: false, mentionUsers: [] });
  });

  test("label-before-review: one channel message for the whole creation", async () => {
    const state = liveState(["alice", "bob", "carol"]);
    const loadTimeline = timeline({ labeledAt: [0], requests: { alice: 0, bob: 0, carol: 1 } });
    const decisions = [
      await labeledRun({ payloadReviewers: [], loadPullRequestState: state, loadTimeline }),
      ...(await Promise.all(
        ["carol", "bob", "alice"].map((login) => reviewRun(login, { loadPullRequestState: state, loadTimeline })),
      )),
    ];
    expect(summarize(decisions)).toEqual({
      channelMessages: [["alice", "bob", "carol"]],
      dms: ["carol", "bob", "alice"],
    });
  });

  test("review-before-label in the same second: review runs confirm the label via the API", async () => {
    const state = liveState(["alice", "bob", "carol"]);
    const loadTimeline = timeline({ labeledAt: [1], requests: { alice: 1, bob: 1, carol: 1 } });
    const decisions = [
      ...(await Promise.all(
        ["alice", "bob", "carol"].map((login) =>
          reviewRun(login, {
            labels: [],
            payloadReviewers: ["alice", "bob", "carol"],
            loadPullRequestState: state,
            loadTimeline,
          }),
        ),
      )),
      await labeledRun({ payloadReviewers: ["alice", "bob", "carol"], loadPullRequestState: state, loadTimeline }),
    ];
    expect(summarize(decisions)).toEqual({
      channelMessages: [["alice", "bob", "carol"]],
      dms: ["alice", "bob", "carol"],
    });
  });

  test("review-before-label in an earlier second: the label run owns the whole batch", async () => {
    const state = liveState(["alice", "bob", "carol"]);
    const loadTimeline = timeline({ labeledAt: [1], requests: { alice: 0, bob: 0, carol: 0 } });
    for (const labelFirst of [true, false]) {
      const label = () =>
        labeledRun({ payloadReviewers: ["alice", "bob", "carol"], loadPullRequestState: state, loadTimeline });
      const reviews = () =>
        Promise.all(
          ["alice", "bob", "carol"].map((login) => reviewRun(login, { loadPullRequestState: state, loadTimeline })),
        );
      const decisions = labelFirst ? [await label(), ...(await reviews())] : [...(await reviews()), await label()];
      expect(summarize(decisions)).toEqual({
        channelMessages: [["alice", "bob", "carol"]],
        dms: ["alice", "bob", "carol"],
      });
    }
  });
});

describe("timeline ownership: urgent added after the PR was created", () => {
  test.each([8, 20, 59])(
    "reviewers requested at creation, urgent added at second %i: the label run notifies everyone once",
    async (labelSecond) => {
      const notUrgent = liveState(["alice", "bob"], { labels: [] });
      const urgentNow = liveState(["alice", "bob"]);
      const loadTimeline = timeline({ labeledAt: [labelSecond], requests: { alice: 0, bob: 0 } });
      const decisions = [
        // Review runs finished before the label existed.
        await reviewRun("alice", {
          labels: [],
          payloadReviewers: ["alice", "bob"],
          now: 5,
          loadPullRequestState: notUrgent,
        }),
        await reviewRun("bob", {
          labels: [],
          payloadReviewers: ["alice", "bob"],
          now: 5,
          loadPullRequestState: notUrgent,
        }),
        await labeledRun({
          payloadReviewers: ["alice", "bob"],
          updatedAt: labelSecond,
          now: labelSecond + 3,
          loadPullRequestState: urgentNow,
          loadTimeline,
        }),
      ];
      expect(decisions[2]).toMatchObject({
        urgent: true,
        initial: true,
        targetUsers: ["alice", "bob"],
        mentionUsers: ["alice", "bob"],
        sendChannel: true,
        sendDm: true,
        ownership: "timeline",
      });
      expect(summarize(decisions)).toEqual({ channelMessages: [["alice", "bob"]], dms: ["alice", "bob"] });
    },
  );

  test("review runs delayed until after the label defer to the label run", async () => {
    const state = liveState(["alice", "bob"]);
    const loadTimeline = timeline({ labeledAt: [8], requests: { alice: 0, bob: 0 } });
    const decisions = [
      await labeledRun({
        payloadReviewers: ["alice", "bob"],
        updatedAt: 8,
        now: 9,
        loadPullRequestState: state,
        loadTimeline,
      }),
      await reviewRun("alice", { labels: [], now: 12, loadPullRequestState: state, loadTimeline }),
      await reviewRun("bob", { labels: [], now: 12, loadPullRequestState: state, loadTimeline }),
    ];
    expect(decisions[1]).toMatchObject({ urgent: true, sendChannel: false, sendDm: false, targetUsers: [] });
    expect(summarize(decisions)).toEqual({ channelMessages: [["alice", "bob"]], dms: ["alice", "bob"] });
  });

  test("mixed order: reviewers before the label go to the label run, the rest to a reviewer leader", async () => {
    // alice before the label, carol in the same second as the label, bob after it.
    const state = liveState(["alice", "bob", "carol"]);
    const loadTimeline = timeline({ labeledAt: [8], requests: { alice: 0, carol: 8, bob: 9 } });
    const runs = {
      label: () => labeledRun({ updatedAt: 8, now: 10, loadPullRequestState: state, loadTimeline }),
      alice: () => reviewRun("alice", { updatedAt: 0, now: 10, loadPullRequestState: state, loadTimeline }),
      bob: () => reviewRun("bob", { updatedAt: 9, now: 10, loadPullRequestState: state, loadTimeline }),
      carol: () => reviewRun("carol", { updatedAt: 8, now: 10, loadPullRequestState: state, loadTimeline }),
    };
    for (const order of permutations(Object.keys(runs))) {
      const decisions = [];
      for (const name of order) decisions.push(await runs[name]());
      const result = summarize(decisions);
      expect(result.channelMessages.sort()).toEqual([["alice"], ["bob", "carol"]]);
      expect(result.dms.sort()).toEqual(["alice", "bob", "carol"]);
    }
  });

  test("label removed and re-added: the latest urgent labeled event counts", async () => {
    const state = liveState(["alice"]);
    const loadTimeline = timeline({ labeledAt: [0, 20], requests: { alice: 5 } });
    const decisions = [
      await labeledRun({ updatedAt: 20, now: 21, loadPullRequestState: state, loadTimeline }),
      await reviewRun("alice", { updatedAt: 5, now: 22, loadPullRequestState: state, loadTimeline }),
    ];
    expect(summarize(decisions)).toEqual({ channelMessages: [["alice"]], dms: ["alice"] });
  });

  test("only reviewers still pending are notified by the label run", async () => {
    const result = await labeledRun({
      loadPullRequestState: liveState(["bob"]),
      loadTimeline: timeline({ labeledAt: [8], requests: { alice: 0, bob: 0 } }),
    });
    expect(result).toMatchObject({ targetUsers: ["bob"], mentionUsers: ["bob"], sendChannel: true, sendDm: true });
  });

  test("a reviewer without a timeline request event belongs to its own review run", async () => {
    const state = liveState(["alice", "bob"]);
    const loadTimeline = timeline({ labeledAt: [8], requests: { alice: 0 } });
    const decisions = [
      await labeledRun({ updatedAt: 8, loadPullRequestState: state, loadTimeline }),
      await reviewRun("bob", { loadPullRequestState: state, loadTimeline }),
    ];
    expect(summarize(decisions)).toEqual({ channelMessages: [["alice"], ["bob"]], dms: ["alice", "bob"] });
  });
});

describe("buildOwnership", () => {
  test("matches labels and logins case-insensitively and uses the latest times", () => {
    const ownership = buildOwnership(
      {
        labeled: [
          { name: "URGENT", createdAt: at(10) },
          { name: "bug", createdAt: at(30) },
          { name: "urgent", createdAt: "not-a-date" },
        ],
        reviewRequests: [
          { login: "Alice", createdAt: at(5) },
          { login: "bob", createdAt: at(5) },
          { login: "BOB", createdAt: at(12) },
          { login: "carol", createdAt: at(10) },
        ],
      },
      "Urgent",
    );
    expect(ownership.urgentLabeledAt).toBe(nowAt(10));
    expect(ownership.ownedByLabel("alice")).toBe(true);
    expect(ownership.ownedByLabel("Bob")).toBe(false);
    expect(ownership.ownedByLabel("carol")).toBe(false);
    expect(ownership.ownedByLabel("dave")).toBe(false);
  });

  test("owns nothing without an urgent labeled event", () => {
    const ownership = buildOwnership({ labeled: [], reviewRequests: [{ login: "alice", createdAt: at(0) }] }, "urgent");
    expect(ownership.urgentLabeledAt).toBeNull();
    expect(ownership.ownedByLabel("alice")).toBe(false);
  });
});

describe("timeline fallback behaviour", () => {
  test("label run notifies every pending reviewer with a warning when the timeline fails", async () => {
    const warn = jest.fn();
    const result = await labeledRun({
      loadPullRequestState: liveState(["bob", "alice"]),
      loadTimeline: failingState("Timeline down"),
      warn,
    });
    expect(result).toMatchObject({
      targetUsers: ["alice", "bob"],
      mentionUsers: ["alice", "bob"],
      sendChannel: true,
      sendDm: true,
      ownership: "timeline-fallback",
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Timeline down.*may duplicate/));
  });

  test("label run without a token notifies the payload reviewers with warnings", async () => {
    const warn = jest.fn();
    const result = await labeledRun({ payloadReviewers: ["alice"], warn });
    expect(result).toMatchObject({ targetUsers: ["alice"], sendChannel: true, sendDm: true });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/timeline API is not available \(no github-token\)/));
  });

  test("review run keeps the leader behaviour with a warning when the timeline fails", async () => {
    const warn = jest.fn();
    const result = await reviewRun("alice", {
      loadPullRequestState: liveState(["alice", "bob"]),
      loadTimeline: failingState("Timeline down"),
      warn,
    });
    expect(result).toMatchObject({
      targetUsers: ["alice"],
      mentionUsers: ["alice", "bob"],
      sendChannel: true,
      sendDm: true,
      ownership: "timeline-fallback",
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Timeline down.*initial batch/));
  });

  test("a timeline without the urgent labeled event is treated as unavailable", async () => {
    const warn = jest.fn();
    const result = await reviewRun("alice", {
      loadPullRequestState: liveState(["alice"]),
      loadTimeline: timeline({ requests: { alice: 0 } }),
      warn,
    });
    expect(result).toMatchObject({ sendChannel: true, sendDm: true, ownership: "timeline-fallback" });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no "urgent" labeled event/));
  });

  test("KNOWN LIMITATION: review run timeline failure after a later label duplicates the notification", async () => {
    const state = liveState(["alice"]);
    const decisions = [
      await labeledRun({
        updatedAt: 8,
        loadPullRequestState: state,
        loadTimeline: timeline({ labeledAt: [8], requests: { alice: 0 } }),
      }),
      await reviewRun("alice", { labels: [], loadPullRequestState: state, loadTimeline: failingState() }),
    ];
    expect(summarize(decisions)).toEqual({ channelMessages: [["alice"], ["alice"]], dms: ["alice", "alice"] });
  });
});

describe("API failure behaviour", () => {
  test("falls back to payload reviewers with a warning and keeps the reviewer's DM", async () => {
    const warn = jest.fn();
    const result = await reviewRun("bob", {
      payloadReviewers: ["bob", "alice"],
      loadPullRequestState: failingState(),
      warn,
    });
    expect(result).toMatchObject({
      urgent: true,
      targetUsers: ["bob"],
      mentionUsers: ["alice", "bob"],
      sendChannel: false,
      sendDm: true,
      reviewerSource: "payload-fallback",
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Service Unavailable.*payload reviewers/));
  });

  test("missing token falls back to payload reviewers with a warning", async () => {
    const warn = jest.fn();
    const result = await reviewRun("alice", { payloadReviewers: ["alice"], warn });
    expect(result).toMatchObject({ sendChannel: true, sendDm: true, reviewerSource: "payload-fallback" });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no github-token/));
  });

  test("label run falls back to channel-only with a warning", async () => {
    const warn = jest.fn();
    const result = await labeledRun({ loadPullRequestState: failingState(), warn });
    expect(result).toMatchObject({ urgent: true, sendChannel: true, reviewerSource: "payload-fallback" });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Service Unavailable.*label payload reviewers/));
  });

  test("KNOWN LIMITATION: label missing from payload and API failure means no notification", async () => {
    const warn = jest.fn();
    const result = await reviewRun("alice", { labels: [], loadPullRequestState: failingState(), warn });
    expect(result).toMatchObject({ urgent: false, sendChannel: false, sendDm: false });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/cannot confirm the urgent label/));
  });

  test("KNOWN LIMITATION: fallback to a different payload snapshot can elect two leaders", async () => {
    const decisions = [
      await reviewRun("alice", { loadPullRequestState: liveState(["alice", "bob"]) }),
      // Bob's payload was serialized before Alice's request and his API read failed.
      await reviewRun("bob", { payloadReviewers: ["bob"], loadPullRequestState: failingState() }),
    ];
    expect(summarize(decisions).channelMessages).toEqual([["alice", "bob"], ["bob"]]);
  });
});

// Characterization tests: these PASS by asserting the duplicate or missing
// channel message that the stateless design is known to produce.
describe("KNOWN LIMITATIONS (characterization, not exactly-once)", () => {
  test("diverging API snapshots: reviewer submits a review before another run reads -> two channel messages", async () => {
    const decisions = [
      await reviewRun("alice", { loadPullRequestState: liveState(["alice", "bob", "carol"]) }),
      // Alice reviewed before Bob's and Carol's runs read the API.
      await reviewRun("bob", { loadPullRequestState: liveState(["bob", "carol"]) }),
      await reviewRun("carol", { loadPullRequestState: liveState(["bob", "carol"]) }),
    ];
    expect(summarize(decisions).channelMessages).toEqual([
      ["alice", "bob", "carol"],
      ["bob", "carol"],
    ]);
  });

  test("diverging API snapshots: a later reviewer sorting first steals leadership -> no batch channel message", async () => {
    const decisions = [
      await reviewRun("bob", { loadPullRequestState: liveState(["alice", "bob"]) }),
      // Alice's run is delayed; meanwhile "aaron" is requested later (outside the batch).
      await reviewRun("alice", { now: 200, loadPullRequestState: liveState(["aaron", "alice", "bob"]) }),
    ];
    expect(summarize(decisions).channelMessages).toEqual([]);
  });

  test("leader failure: if the leader run fails nobody else posts the channel message", async () => {
    const state = liveState(["alice", "bob", "carol"]);
    const decisions = await Promise.all(
      ["alice", "bob", "carol"].map((login) => reviewRun(login, { loadPullRequestState: state })),
    );
    const delivered = decisions.filter((decision) => decision.targetUsers[0] !== "alice");
    expect(summarize(delivered)).toEqual({ channelMessages: [], dms: ["bob", "carol"] });
  });

  test("re-running the leader run posts the channel message again (no rerun dedup)", async () => {
    const state = liveState(["alice", "bob"]);
    const decisions = [
      await reviewRun("alice", { loadPullRequestState: state }),
      await reviewRun("bob", { loadPullRequestState: state }),
      await reviewRun("alice", { now: 900, loadPullRequestState: state }),
    ];
    expect(summarize(decisions)).toEqual({
      channelMessages: [
        ["alice", "bob"],
        ["alice", "bob"],
      ],
      dms: ["alice", "bob", "alice"],
    });
  });

  test("label run executes before reviewer requests are visible -> extra channel-only message", async () => {
    const decisions = [
      await labeledRun({ loadPullRequestState: liveState([]) }),
      await reviewRun("alice", { loadPullRequestState: liveState(["alice", "bob"]) }),
      await reviewRun("bob", { loadPullRequestState: liveState(["alice", "bob"]) }),
    ];
    expect(summarize(decisions).channelMessages).toEqual([[], ["alice", "bob"]]);
  });

  test("payload updated_at bumped past the window by another edit -> run is treated as later and also posts", async () => {
    const state = liveState(["alice", "bob"]);
    const decisions = [
      await reviewRun("alice", { loadPullRequestState: state }),
      await reviewRun("bob", { updatedAt: 70, loadPullRequestState: state }),
    ];
    expect(summarize(decisions).channelMessages).toEqual([["alice", "bob"], ["bob"]]);
  });

  test("payload without updated_at falls back to execution time -> delayed run posts again", async () => {
    const state = liveState(["alice", "bob"]);
    const decisions = [
      await reviewRun("alice", { updatedAt: null, now: 30, loadPullRequestState: state }),
      await reviewRun("bob", { updatedAt: null, now: 90, loadPullRequestState: state }),
    ];
    expect(decisions[1].ageSource).toBe("execution-time");
    expect(summarize(decisions).channelMessages).toEqual([["alice", "bob"], ["bob"]]);
  });
});
