const DEFAULT_RETRY_DELAYS_MS = [1000, 3000];

/**
 * Waits for the given number of milliseconds.
 *
 * @param {number} ms - Delay in milliseconds.
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Checks whether a failed GitHub API call is worth retrying. Rate limiting and
 * server errors are retried, including network failures, which Octokit reports
 * as status 500. Client errors such as missing permissions, and errors without
 * an HTTP status (programming errors), are not.
 *
 * @param {*} error - Error thrown by Octokit.
 * @returns {boolean} True when the call should be retried.
 */
function isRetryableError(error) {
  const status = error?.status;
  return typeof status === "number" && (status === 429 || status >= 500);
}

/**
 * Calls `request` with bounded retries for transient errors.
 *
 * @param {() => Promise<*>} request - API call to perform.
 * @param {object} options
 * @param {string} options.what - Description used in warnings, e.g. "Reading pull request #7".
 * @param {number[]} options.retryDelaysMs - Delays between attempts; bounds the number of retries.
 * @param {(ms: number) => Promise<void>} options.sleep - Sleep function.
 * @param {(message: string) => void} options.warn - Warning logger.
 * @returns {Promise<*>} Result of the first successful attempt.
 */
async function withRetries(request, { what, retryDelaysMs, sleep, warn }) {
  const maxAttempts = retryDelaysMs.length + 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableError(error)) throw error;
      const delay = retryDelaysMs[attempt - 1];
      warn(`${what} failed (attempt ${attempt}/${maxAttempts}: ${error?.message}); retrying in ${delay}ms.`);
      await sleep(delay);
    }
  }
}

/**
 * Wraps an async function so that it runs at most once.
 *
 * @param {() => Promise<*>} load - Function to memoize.
 * @returns {() => Promise<*>} Memoized function.
 */
function memoize(load) {
  let pending;
  return () => {
    if (!pending) pending = load();
    return pending;
  };
}

/**
 * Throws when the pull request number from the payload is not usable.
 *
 * @param {*} pullNumber - Pull request number.
 */
function assertPullNumber(pullNumber) {
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    throw new Error("pull request number is missing from the event payload");
  }
}

/**
 * Creates a memoized loader that reads the current labels and requested
 * reviewers of a pull request with `GET /repos/{owner}/{repo}/pulls/{pull_number}`.
 *
 * The repository comes from the workflow context (`GITHUB_REPOSITORY`) and the
 * pull request number from the event payload; no URL from the pull request
 * payload is used as an API destination. The result is a live, mutable
 * snapshot of the pull request at read time.
 *
 * @param {object} options
 * @param {object} options.octokit - Authenticated Octokit client.
 * @param {string} options.owner - Repository owner.
 * @param {string} options.repo - Repository name.
 * @param {number} options.pullNumber - Pull request number.
 * @param {number[]} [options.retryDelaysMs] - Delays between attempts; bounds the number of retries.
 * @param {(ms: number) => Promise<void>} [options.sleep] - Sleep function, for testing.
 * @param {(message: string) => void} [options.warn] - Warning logger.
 * @returns {() => Promise<{ labels: Array<object>, requestedUsers: string[], requestedTeams: string[] }>}
 */
function createPullRequestStateLoader({
  octokit,
  owner,
  repo,
  pullNumber,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  sleep = defaultSleep,
  warn = () => {},
}) {
  return memoize(async () => {
    assertPullNumber(pullNumber);
    const { data } = await withRetries(() => octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber }), {
      what: `Reading pull request #${pullNumber}`,
      retryDelaysMs,
      sleep,
      warn,
    });
    return {
      labels: Array.isArray(data?.labels) ? data.labels : [],
      requestedUsers: (Array.isArray(data?.requested_reviewers) ? data.requested_reviewers : [])
        .map((reviewer) => reviewer?.login)
        .filter((login) => typeof login === "string"),
      requestedTeams: (Array.isArray(data?.requested_teams) ? data.requested_teams : [])
        .map((team) => team?.slug)
        .filter((slug) => typeof slug === "string"),
    };
  });
}

/**
 * Creates a memoized loader that reads the `labeled` and individual
 * `review_requested` events of a pull request with the read-only, paginated
 * `GET /repos/{owner}/{repo}/issues/{issue_number}/timeline` endpoint.
 *
 * Like the state loader, the repository comes from the workflow context and
 * the number from the event payload. Only GitHub's own event history is read;
 * nothing is stored.
 *
 * @param {object} options - Same options as {@link createPullRequestStateLoader}.
 * @returns {() => Promise<{ labeled: Array<{ name: string, createdAt: string }>,
 *   reviewRequests: Array<{ login: string, createdAt: string }> }>}
 */
function createTimelineLoader({
  octokit,
  owner,
  repo,
  pullNumber,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  sleep = defaultSleep,
  warn = () => {},
}) {
  return memoize(async () => {
    assertPullNumber(pullNumber);
    const events = await withRetries(
      () =>
        octokit.paginate(octokit.rest.issues.listEventsForTimeline, {
          owner,
          repo,
          issue_number: pullNumber,
          per_page: 100,
        }),
      { what: `Reading the timeline of pull request #${pullNumber}`, retryDelaysMs, sleep, warn },
    );
    const labeled = [];
    const reviewRequests = [];
    for (const event of Array.isArray(events) ? events : []) {
      if (typeof event?.created_at !== "string") continue;
      if (event.event === "labeled" && typeof event.label?.name === "string") {
        labeled.push({ name: event.label.name, createdAt: event.created_at });
      } else if (event.event === "review_requested" && typeof event.requested_reviewer?.login === "string") {
        reviewRequests.push({ login: event.requested_reviewer.login, createdAt: event.created_at });
      }
    }
    return { labeled, reviewRequests };
  });
}

module.exports = { createPullRequestStateLoader, createTimelineLoader, isRetryableError, DEFAULT_RETRY_DELAYS_MS };
