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
 * Decides whether an urgent Slack notification is required, and which
 * delivery channels (channel post and/or reviewer DMs) should be used.
 *
 * Mirrors the behaviour of the original `Urgent PR Slack Notification`
 * workflow:
 * - `labeled` with the urgent label on a freshly opened PR notifies any
 *   reviewers already requested, and posts to the channel when none exist.
 * - `labeled` with the urgent label on an older PR notifies every currently
 *   requested reviewer.
 * - `review_requested` on an already urgent PR notifies the new reviewer.
 *
 * @param {object} options
 * @param {string} options.action - Webhook action, e.g. "labeled".
 * @param {object} options.pullRequest - `pull_request` payload object.
 * @param {object} [options.label] - `label` payload object for `labeled` events.
 * @param {object} [options.requestedReviewer] - `requested_reviewer` payload object.
 * @param {string} options.urgentLabel - Label name that marks a PR as urgent.
 * @param {number} options.freshWindowSeconds - Age below which a PR counts as fresh.
 * @param {number} [options.now] - Current time in milliseconds, for testing.
 * @returns {{ urgent: boolean, targetUsers: string[], sendChannel: boolean, sendDm: boolean, prAgeSeconds: number }}
 */
function decideNotification({
  action,
  pullRequest,
  label,
  requestedReviewer,
  urgentLabel,
  freshWindowSeconds,
  now = Date.now(),
}) {
  const result = { urgent: false, targetUsers: [], sendChannel: false, sendDm: false, prAgeSeconds: 0 };
  if (!pullRequest) return result;

  const allReviewers = collectReviewers(pullRequest.requested_reviewers);
  const newReviewer = normalizeName(requestedReviewer?.login);
  const createdAt = Date.parse(pullRequest.created_at);
  const prAgeSeconds = Number.isNaN(createdAt) ? Number.POSITIVE_INFINITY : (now - createdAt) / 1000;
  const isPrFresh = prAgeSeconds < freshWindowSeconds;
  result.prAgeSeconds = prAgeSeconds;

  if (action === "labeled") {
    if (normalizeName(label?.name).toLowerCase() !== urgentLabel.toLowerCase()) return result;

    result.urgent = true;
    if (isPrFresh) {
      result.targetUsers = allReviewers;
      result.sendChannel = allReviewers.length === 0;
      result.sendDm = allReviewers.length > 0;
    } else {
      result.targetUsers = allReviewers;
      result.sendChannel = true;
      result.sendDm = allReviewers.length > 0;
    }
    return result;
  }

  if (action === "review_requested") {
    if (!newReviewer || !hasUrgentLabel(pullRequest.labels, urgentLabel)) return result;

    result.urgent = true;
    result.targetUsers = [newReviewer];
    result.sendChannel = true;
    result.sendDm = true;
  }

  return result;
}

module.exports = { decideNotification, collectReviewers, hasUrgentLabel };
