/**
 * Normalizes a username-like value into a trimmed string.
 *
 * @param {unknown} value - Raw value, typically from the webhook payload.
 * @returns {string} Trimmed string, or "" when the value is not usable.
 */
function normalizeName(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Returns the login names of the reviewers currently requested on the PR.
 *
 * @param {Array<object>} requestedReviewers - `pull_request.requested_reviewers`.
 * @returns {string[]} Cleaned reviewer logins.
 */
function collectReviewers(requestedReviewers) {
  if (!Array.isArray(requestedReviewers)) return [];
  return requestedReviewers.map((reviewer) => normalizeName(reviewer?.login)).filter(Boolean);
}

/**
 * Checks whether the pull request carries the urgent label.
 *
 * @param {Array<object>} labels - `pull_request.labels`.
 * @param {string} urgentLabel - Label name that marks a PR as urgent.
 * @returns {boolean} True when the label is present (case-insensitive).
 */
function hasUrgentLabel(labels, urgentLabel) {
  if (!Array.isArray(labels)) return false;
  const target = urgentLabel.toLowerCase();
  return labels.some((label) => normalizeName(label?.name).toLowerCase() === target);
}

/**
 * Deduplicates logins case-insensitively (keeping the first spelling) and
 * orders them deterministically by their lower-cased form.
 *
 * @param {unknown[]} logins - Raw login values.
 * @returns {string[]} Normalized, deduplicated and sorted logins.
 */
function normalizeReviewerList(logins) {
  const byKey = new Map();
  for (const value of Array.isArray(logins) ? logins : []) {
    const login = normalizeName(value);
    const key = login.toLowerCase();
    if (login && !byKey.has(key)) byKey.set(key, login);
  }
  // Default sort compares UTF-16 code units, so the order is locale-independent.
  return [...byKey.keys()].sort().map((key) => byKey.get(key));
}

/**
 * Computes the age of the pull request at the time the event payload was
 * produced, using `pull_request.updated_at` from the payload snapshot. Falls
 * back to the execution time when the payload has no usable `updated_at`.
 *
 * `updated_at` is an approximation of when the triggering change happened,
 * not a guaranteed review-request or label time. Unlike the execution time,
 * it does not depend on runner queue delays and is identical when the same
 * event is re-run.
 *
 * @param {object} pullRequest - `pull_request` payload object.
 * @param {number} now - Current time in milliseconds.
 * @returns {{ eventAgeSeconds: number, ageSource: "payload-updated-at" | "execution-time" }}
 */
function computeEventAge(pullRequest, now) {
  const createdAt = Date.parse(pullRequest.created_at);
  const updatedAt = Date.parse(pullRequest.updated_at);
  const ageSource = Number.isNaN(updatedAt) ? "execution-time" : "payload-updated-at";
  const reference = Number.isNaN(updatedAt) ? now : updatedAt;
  const eventAgeSeconds = Number.isNaN(createdAt) ? Number.POSITIVE_INFINITY : (reference - createdAt) / 1000;
  return { eventAgeSeconds, ageSource };
}

/**
 * Loads the live pull request state, reporting failures as warnings.
 *
 * @param {Function | undefined} loadPullRequestState - Async loader.
 * @param {(message: string) => void} warn - Warning logger.
 * @param {string} purpose - What the state is needed for, used in warnings.
 * @returns {Promise<object | null>} State, or null when unavailable.
 */
async function tryLoadState(loadPullRequestState, warn, purpose) {
  if (typeof loadPullRequestState !== "function") {
    warn(`GitHub API is not available (no github-token); ${purpose}.`);
    return null;
  }
  try {
    return await loadPullRequestState();
  } catch (error) {
    warn(`Reading the pull request from the GitHub API failed (${error?.message}); ${purpose}.`);
    return null;
  }
}

/**
 * Derives the notification ownership rule from the pull request timeline.
 *
 * `urgentLabeledAt` is the time of the latest urgent `labeled` event (L).
 * A reviewer whose latest individual `review_requested` event is strictly
 * before L was requested before the PR became urgent, so the `labeled` run
 * owns that reviewer's notification. Requests in the same second as L or
 * later, and reviewers without a request event, belong to their
 * `review_requested` runs. Only the latest label time and each reviewer's
 * request time are compared; events are not otherwise ordered.
 *
 * @param {{ labeled?: Array<object>, reviewRequests?: Array<object> }} timeline - Loaded timeline events.
 * @param {string} urgentLabel - Label name that marks a PR as urgent.
 * @returns {{ urgentLabeledAt: number | null, ownedByLabel: (login: string) => boolean }}
 */
function buildOwnership(timeline, urgentLabel) {
  const target = urgentLabel.toLowerCase();
  let urgentLabeledAt = null;
  for (const event of Array.isArray(timeline?.labeled) ? timeline.labeled : []) {
    const time = Date.parse(event?.createdAt);
    if (normalizeName(event?.name).toLowerCase() !== target || Number.isNaN(time)) continue;
    if (urgentLabeledAt === null || time > urgentLabeledAt) urgentLabeledAt = time;
  }

  const requestedAt = new Map();
  for (const event of Array.isArray(timeline?.reviewRequests) ? timeline.reviewRequests : []) {
    const key = normalizeName(event?.login).toLowerCase();
    const time = Date.parse(event?.createdAt);
    if (!key || Number.isNaN(time)) continue;
    if (!requestedAt.has(key) || time > requestedAt.get(key)) requestedAt.set(key, time);
  }

  return {
    urgentLabeledAt,
    ownedByLabel: (login) => {
      const time = requestedAt.get(normalizeName(login).toLowerCase());
      return urgentLabeledAt !== null && time !== undefined && time < urgentLabeledAt;
    },
  };
}

/**
 * Loads the timeline and derives the ownership rule, reporting failures and
 * a missing urgent `labeled` event as warnings.
 *
 * @param {Function | undefined} loadTimeline - Async timeline loader.
 * @param {string} urgentLabel - Label name that marks a PR as urgent.
 * @param {(message: string) => void} warn - Warning logger.
 * @param {string} purpose - Fallback description, used in warnings.
 * @returns {Promise<ReturnType<typeof buildOwnership> | null>} Ownership, or null when unavailable.
 */
async function tryLoadOwnership(loadTimeline, urgentLabel, warn, purpose) {
  if (typeof loadTimeline !== "function") {
    warn(`GitHub timeline API is not available (no github-token); ${purpose}.`);
    return null;
  }
  let timeline;
  try {
    timeline = await loadTimeline();
  } catch (error) {
    warn(`Reading the pull request timeline from the GitHub API failed (${error?.message}); ${purpose}.`);
    return null;
  }
  const ownership = buildOwnership(timeline, urgentLabel);
  if (ownership.urgentLabeledAt === null) {
    warn(`The pull request timeline has no "${urgentLabel}" labeled event; ${purpose}.`);
    return null;
  }
  return ownership;
}

/**
 * Decides whether an urgent Slack notification is required, and which
 * delivery channels (channel post and/or reviewer DMs) should be used.
 *
 * An event is "initial" when the pull request age in the event payload
 * snapshot is below the fresh window. For initial events, the PR timeline
 * decides who owns each reviewer's notification (see {@link buildOwnership}):
 * reviewers requested strictly before the latest urgent label belong to the
 * `labeled` run, all others to their `review_requested` runs. Behaviour:
 * - `labeled` with the urgent label on an initial PR posts to the channel
 *   only when no individual reviewers are requested (live API state, then
 *   payload). Otherwise it notifies (channel + DMs) the reviewers it owns, and
 *   defers when it owns none. Without a usable timeline it notifies every
 *   requested reviewer, accepting a possible duplicate over a missed message.
 * - `labeled` with the urgent label on an older PR notifies every currently
 *   requested reviewer.
 * - `review_requested` for an individual reviewer on an urgent PR DMs that
 *   reviewer. For initial events, a run whose reviewer is owned by the
 *   `labeled` run sends nothing. The other runs read the requested reviewers
 *   not owned by the `labeled` run and only the run whose reviewer sorts
 *   first posts to the channel, mentioning every one of them. Without a usable
 *   timeline, no reviewer is treated as owned by the `labeled` run. This is
 *   best-effort, not exactly-once.
 * - Later `review_requested` events post to the channel and DM the reviewer.
 *
 * @param {object} options
 * @param {string} options.action - Webhook action, e.g. "labeled".
 * @param {object} options.pullRequest - `pull_request` payload object.
 * @param {object} [options.label] - `label` payload object for `labeled` events.
 * @param {object} [options.requestedReviewer] - `requested_reviewer` payload object.
 * @param {string} options.urgentLabel - Label name that marks a PR as urgent.
 * @param {number} options.freshWindowSeconds - Event age below which an event counts as initial.
 * @param {number} [options.now] - Current time in milliseconds, for testing.
 * @param {Function} [options.loadPullRequestState] - Async loader of the live labels and requested reviewers.
 * @param {Function} [options.loadTimeline] - Async loader of the timeline `labeled` and `review_requested` events.
 * @param {(message: string) => void} [options.warn] - Warning logger.
 * @returns {Promise<{ urgent: boolean, targetUsers: string[], mentionUsers: string[], sendChannel: boolean,
 *   sendDm: boolean, eventAgeSeconds: number, ageSource: string, initial: boolean, reviewerSource: string,
 *   ownership: string }>}
 */
async function decideNotification({
  action,
  pullRequest,
  label,
  requestedReviewer,
  urgentLabel,
  freshWindowSeconds,
  now = Date.now(),
  loadPullRequestState,
  loadTimeline,
  warn = () => {},
}) {
  const result = {
    urgent: false,
    targetUsers: [],
    mentionUsers: [],
    sendChannel: false,
    sendDm: false,
    eventAgeSeconds: 0,
    ageSource: "none",
    initial: false,
    reviewerSource: "none",
    ownership: "none",
  };
  if (!pullRequest) return result;

  const allReviewers = collectReviewers(pullRequest.requested_reviewers);
  const newReviewer = normalizeName(requestedReviewer?.login);
  const { eventAgeSeconds, ageSource } = computeEventAge(pullRequest, now);
  const isInitial = eventAgeSeconds < freshWindowSeconds;
  Object.assign(result, { eventAgeSeconds, ageSource, initial: isInitial });

  if (action === "labeled") {
    if (normalizeName(label?.name).toLowerCase() !== urgentLabel.toLowerCase()) return result;

    result.urgent = true;
    if (!isInitial) {
      result.targetUsers = allReviewers;
      result.mentionUsers = allReviewers;
      result.sendChannel = true;
      result.sendDm = allReviewers.length > 0;
      result.reviewerSource = "payload";
      return result;
    }

    const state = await tryLoadState(loadPullRequestState, warn, "falling back to the label payload reviewers");
    const pending = normalizeReviewerList(state ? state.requestedUsers : allReviewers);
    result.reviewerSource = state ? "api" : "payload-fallback";
    if (pending.length === 0) {
      // No individual reviewer to hand over to: post a channel-only message.
      result.sendChannel = true;
      return result;
    }

    const ownership = await tryLoadOwnership(
      loadTimeline,
      urgentLabel,
      warn,
      "notifying every requested reviewer, which may duplicate the review_requested notifications",
    );
    const owned = ownership ? pending.filter((login) => ownership.ownedByLabel(login)) : pending;
    result.ownership = ownership ? "timeline" : "timeline-fallback";
    if (owned.length === 0) return result;

    result.targetUsers = owned;
    result.mentionUsers = owned;
    result.sendChannel = true;
    result.sendDm = true;
    return result;
  }

  if (action === "review_requested") {
    if (!newReviewer) return result;

    const payloadUrgent = hasUrgentLabel(pullRequest.labels, urgentLabel);
    if (!isInitial) {
      if (!payloadUrgent) return result;
      result.urgent = true;
      result.targetUsers = [newReviewer];
      result.mentionUsers = [newReviewer];
      result.sendChannel = true;
      result.sendDm = true;
      result.reviewerSource = "payload";
      return result;
    }

    // Initial request: the payload may predate the urgent label, so a missing
    // label is re-checked against the live state.
    let state = null;
    if (!payloadUrgent) {
      state = await tryLoadState(
        loadPullRequestState,
        warn,
        "cannot confirm the urgent label, so no notification is sent",
      );
      if (!state || !hasUrgentLabel(state.labels, urgentLabel)) return result;
    } else {
      state = await tryLoadState(
        loadPullRequestState,
        warn,
        "electing the channel leader from the payload reviewers, which may duplicate or miss the channel message",
      );
    }

    const ownership = await tryLoadOwnership(
      loadTimeline,
      urgentLabel,
      warn,
      "notifying this reviewer as part of the initial batch, which may duplicate the labeled notification",
    );
    result.ownership = ownership ? "timeline" : "timeline-fallback";
    result.urgent = true;
    result.reviewerSource = state ? "api" : "payload-fallback";
    // Requested before the urgent label was added: the labeled run notifies this reviewer.
    if (ownership && ownership.ownedByLabel(newReviewer)) return result;

    const observed = (state ? state.requestedUsers : allReviewers).filter(
      (login) => !ownership || !ownership.ownedByLabel(login),
    );
    const reviewers = normalizeReviewerList([...observed, newReviewer]);
    const leader = reviewers[0];

    result.targetUsers = [newReviewer];
    result.mentionUsers = reviewers;
    result.sendChannel = leader.toLowerCase() === newReviewer.toLowerCase();
    result.sendDm = true;
  }

  return result;
}

module.exports = {
  decideNotification,
  collectReviewers,
  hasUrgentLabel,
  normalizeReviewerList,
  computeEventAge,
  buildOwnership,
};
