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
  let pending;

  async function load() {
    if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
      throw new Error("pull request number is missing from the event payload");
    }

    const maxAttempts = retryDelaysMs.length + 1;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
        return {
          labels: Array.isArray(data?.labels) ? data.labels : [],
          requestedUsers: (Array.isArray(data?.requested_reviewers) ? data.requested_reviewers : [])
            .map((reviewer) => reviewer?.login)
            .filter((login) => typeof login === "string"),
          requestedTeams: (Array.isArray(data?.requested_teams) ? data.requested_teams : [])
            .map((team) => team?.slug)
            .filter((slug) => typeof slug === "string"),
        };
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryableError(error)) throw error;
        const delay = retryDelaysMs[attempt - 1];
        warn(
          `Reading pull request #${pullNumber} failed (attempt ${attempt}/${maxAttempts}: ${error?.message}); ` +
            `retrying in ${delay}ms.`,
        );
        await sleep(delay);
      }
    }
  }

  return () => {
    if (!pending) pending = load();
    return pending;
  };
}

module.exports = { createPullRequestStateLoader, isRetryableError, DEFAULT_RETRY_DELAYS_MS };
