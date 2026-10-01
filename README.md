# Urgent PR Slack Notification

A GitHub Action that decides when a pull request labeled `urgent` needs a Slack notification, and produces the inputs for [`kreuz123/slack-dual-notify-action`](https://github.com/kreuz123/slack-dual-notify-action) so that reviewers get a DM and the channel gets a message that mentions them.

- ✅ Reacts to `pull_request` `labeled` and `review_requested` events.
- ✅ Skips reviewer notifications for a freshly opened PR, because the `review_requested` events that follow handle them.
- ✅ Notifies every currently requested reviewer when an existing PR becomes urgent.
- ✅ Notifies newly requested reviewers of an already urgent PR.
- ✅ When an urgent PR is created with several individual reviewers, aims for **one** channel message that mentions all of them, while each `review_requested` run still DMs only its own reviewer (best-effort, see [Reliability limitations](#reliability-limitations)).
- ✅ Renders the Slack message from a template with pull request placeholders.
- ✅ Never calls the Slack API itself, so no Slack secrets are needed for this step.

## Usage

> [!IMPORTANT]
> The `mention-users` wiring below requires a version of `kreuz123/slack-dual-notify-action` that supports the optional `mention-users` input (added by a companion change in that repository). At the time of writing that input is **not** part of a published release or the `v1` tag. The same applies to this action: its `mention-users` output and `github-token` input are not in a published release yet. Replace each `<version-with-mention-users>` with the release tag or commit SHA that contains the change in the respective repository. See [Rollout](#rollout).

```yaml
name: Urgent PR Slack Notification

on:
  pull_request:
    types: [labeled, review_requested]

permissions:
  contents: read
  pull-requests: read

jobs:
  notify_urgent:
    runs-on: ubuntu-latest
    steps:
      - name: Check urgent
        id: check
        uses: kreuz123/urgent-pr-slack-notification@<version-with-mention-users>

      - name: Send Slack notification
        if: steps.check.outputs.urgent == 'true'
        uses: kreuz123/slack-dual-notify-action@<version-with-mention-users>
        with:
          message-template: ${{ steps.check.outputs.message }}
          target-users: ${{ steps.check.outputs.target-users }}
          mention-users: ${{ steps.check.outputs.mention-users }}
          send-channel: ${{ steps.check.outputs.send-channel }}
          send-dm: ${{ steps.check.outputs.send-dm }}
          slack-bot-token: ${{ secrets.SLACK_BOT_TOKEN }}
          slack-channel-id: ${{ secrets.SLACK_CHANNEL_ID }}
          slack-reviewer-map: ${{ secrets.SLACK_REVIEWER_MAP }}
```

`SLACK_REVIEWER_MAP` is a JSON object mapping GitHub usernames to Slack user IDs, for example `{ "alice": "U0123456789" }`. Mapped reviewers are mentioned as `<@U0123456789>` in the channel message and receive a DM.

### Caller changes

Existing callers need two small changes:

1. Add `pull-requests: read` to the job or workflow `permissions`, keeping the permissions you already grant (for example `contents: read`). The action uses the default `github-token` (`${{ github.token }}`) for one read-only `GET /repos/{owner}/{repo}/pulls/{number}` call.
2. Pass `mention-users: ${{ steps.check.outputs.mention-users }}` to a `slack-dual-notify-action` version that supports it. That action uses `mention-users` for channel mentions only and falls back to `target-users` when it is blank; DMs always go to `target-users`.

### Rollout

1. Release `slack-dual-notify-action` with the optional `mention-users` input first. It is backward compatible because a blank `mention-users` falls back to `target-users`.
2. Then release this action and update callers (new Slack action version, `mention-users` wiring, `pull-requests: read`).

If a caller uses this version without wiring `mention-users`, the leader run's channel message mentions only the leader (its `target-users`), not the whole reviewer list.

## How the decision is made

An event is **initial** when its _event age_ is below `fresh-pr-window-seconds`. The event age is `pull_request.updated_at − pull_request.created_at` from the event payload. It approximates when the triggering change happened; it is not a guaranteed review-request or label time. Unlike the runner's clock it does not change when a run is queued for a long time or re-run. If the payload has no usable `updated_at`, the action falls back to the execution time.

| Event                       | Condition                                                                 | `target-users`      | `mention-users`                    | `send-channel`             | `send-dm`       |
| --------------------------- | ------------------------------------------------------------------------- | ------------------- | ---------------------------------- | -------------------------- | --------------- |
| `labeled` (urgent)          | initial, payload has individual reviewers                                 | empty               | empty                              | `false`                    | `false`         |
| `labeled` (urgent)          | initial, payload has none, live API shows individual reviewers            | empty               | empty                              | `false`                    | `false`         |
| `labeled` (urgent)          | initial, no individual reviewers (or API unavailable)                     | empty               | empty                              | `true`                     | `false`         |
| `labeled` (urgent)          | not initial                                                               | requested reviewers | requested reviewers                | `true`                     | reviewers exist |
| `review_requested` (user)   | initial, urgent label in payload or in the live API state                 | the new reviewer    | all observed individual reviewers  | only for the leader        | `true`          |
| `review_requested` (user)   | not initial, payload has the urgent label                                 | the new reviewer    | the new reviewer                   | `true`                     | `true`          |
| `review_requested` (team)   | —                                                                         | empty               | empty                              | `false`                    | `false`         |
| anything else               | —                                                                         | empty               | empty                              | `false`                    | `false`         |

For initial individual `review_requested` events, every run reads the currently requested individual reviewers from the API, adds its own reviewer, dedupes the logins case-insensitively and sorts them by lower-cased login. The first login is the **leader**: only the leader's run sets `send-channel` to `true`. Every eligible run keeps `urgent=true`, `send-dm=true` and `target-users` set to its own reviewer only. DMs are never centralized in the leader run.

### Expected behaviour: urgent PR created with alice, bob and carol

Assuming all three runs read the same reviewer list:

| Run (`requested_reviewer`) | `target-users` | `mention-users`     | `send-channel` | `send-dm` | Slack result                                 |
| -------------------------- | -------------- | ------------------- | -------------- | --------- | -------------------------------------------- |
| `alice` (leader)           | `alice`        | `alice,bob,carol`   | `true`         | `true`    | channel message mentioning all 3, DM to alice |
| `bob`                      | `bob`          | `alice,bob,carol`   | `false`        | `true`    | DM to bob                                    |
| `carol`                    | `carol`        | `alice,bob,carol`   | `false`        | `true`    | DM to carol                                  |
| `labeled`                  | empty          | empty               | `false`        | `false`   | nothing                                      |

The run order does not matter. This is the expected result in the normal case, not a guarantee; see below.

### GitHub API failures

The live state is read with up to 3 attempts (retry delays 1s and 3s) for network errors, `429` and `5xx` responses. Permission errors (`401`/`403`/`404`) are not retried. A failure is logged as a warning and the action falls back to the event payload:

- `review_requested` with the urgent label in the payload: the leader is elected from the payload's `requested_reviewers` plus the triggering reviewer. The reviewer's DM is still sent. Payload snapshots can differ between runs, so this can produce zero or several channel messages.
- `review_requested` without the urgent label in the payload: urgency cannot be confirmed and nothing is sent (same as before this change).
- Initial `labeled` with no reviewers in the payload: a channel-only message is sent (same as before), which may duplicate a leader's message.

The token is never logged. The repository comes from `GITHUB_REPOSITORY` and the pull request number from the event payload; URLs from the pull request payload are never used as API destinations.

### Team review requests

Only individual reviewers are aggregated. Individual CODEOWNERS that GitHub requests automatically are handled like manually selected reviewers. Team requests (including team CODEOWNERS) are **not** expanded into team members, are not mentioned and do not trigger a notification of their own, and `requested_teams` is not supported as a mention target. If an urgent PR is created with only team reviewers, the `labeled` run posts a channel-only message without mentions.

## Inputs

| Input                     | Required | Default                                                | Description                                                         |
| ------------------------- | -------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| `urgent-label`            | No       | `urgent`                                               | Label name that marks a PR as urgent. Matching is case-insensitive.  |
| `message-template`        | No       | `🚨 Urgent PR: <{{url}}\|{{title}}> needs review ASAP!` | Slack message body. Newlines and special characters are preserved.   |
| `fresh-pr-window-seconds` | No       | `60`                                                   | Event age in seconds below which an event counts as initial.         |
| `github-token`            | No       | `${{ github.token }}`                                  | Token for the read-only pull request API call. Needs `pull-requests: read`. When empty, the action warns and uses the payload only. |

### Message placeholders

`{{title}}`, `{{url}}`, `{{number}}`, `{{author}}`, `{{base}}`, `{{head}}`. Unknown placeholders are left untouched.

## Outputs

| Output         | Description                                                                        |
| -------------- | ---------------------------------------------------------------------------------- |
| `urgent`       | `"true"` when the event should trigger an urgent Slack notification.                |
| `target-users` | Comma-separated GitHub usernames to DM, for `target-users` of `slack-dual-notify-action`. |
| `mention-users` | Comma-separated GitHub usernames to mention in the channel, for `mention-users` of `slack-dual-notify-action`. Equals `target-users` except for initial `review_requested` events; empty when `urgent` is `"false"`. |
| `send-channel` | `"true"` when a Slack channel notification should be sent.                          |
| `send-dm`      | `"true"` when reviewer DMs should be sent.                                          |
| `message`      | Rendered Slack message. Empty when `urgent` is `"false"`.                           |

## Migrating from the workflow

The previous setup used a `github-script` job plus a reusable workflow call. Replace both with the two steps shown in [Usage](#usage):

- The `github-script` decision logic becomes this action.
- The `./.github/workflows/REUSABLE_SLACK_NOTIFICATION.yml` job becomes `kreuz123/slack-dual-notify-action` (see [Rollout](#rollout) for the version that supports `mention-users`).
- Job outputs (`urgent`, `users`, `channel`, `dm`) become step outputs (`urgent`, `target-users`, `send-channel`, `send-dm`).
- The inline `message_template` expression becomes the `message-template` input with `{{url}}` and `{{title}}` placeholders, exposed as the `message` output.

## Reliability limitations

The aggregation is **stateless and best-effort**. There is no persistence, locking or delivery record, so it does not provide exactly-once delivery and does not dedupe reruns. Each limitation below is covered by a characterization test in `__tests__/aggregation.test.js` that asserts the duplicate or missing message.

- **Snapshot divergence.** The requested-reviewers API returns the reviewers who are _still_ pending at read time, not an immutable snapshot of the creation batch. If alice submits a review (or her request is removed) before bob's run reads the API, bob's run can elect itself and a second channel message is posted. If a reviewer whose login sorts first is requested later and is visible to a delayed initial run, no run of the initial batch posts a channel message.
- **Execution and classification races.** Runs read the API at execution time. If a run reads before all initial requests are recorded, it can see a partial list. Classification uses the payload's `updated_at`, which is a heuristic: if another edit bumps `updated_at` past the window before the payload is produced, that run is treated as a later request and posts its own channel message; if `updated_at` is missing, the execution-time fallback reintroduces runner-delay races.
- **API fallback.** When the API read fails, payload snapshots are used, and they can differ between runs. The leader can then be inconsistent (zero or several channel messages).
- **Leader failure.** If the leader's run or its Slack step fails, is cancelled or is skipped, no other run posts the channel message. The other reviewers still get their DMs.
- **Reruns.** Re-running the leader's workflow posts the channel message and its DM again. Re-running another reviewer's workflow sends that DM again.
- **Label / review-request overlap.** GitHub does not guarantee the order in which the label and review requests of a new PR are recorded or delivered.
  - If the `labeled` run reads the API before any reviewer request is visible, it posts a channel-only message and the leader posts another one.
  - If the urgent label is added inside the window _after_ every initial `review_requested` run has already read the PR without the label, the `labeled` run still defers to them and nothing is sent. This was already the behaviour before this change. Removing and re-adding the label after the window notifies everyone.
  - A reviewer requested inside the window after a channel-only `labeled` message is treated as initial and posts a second channel message.
- **Teams.** Team requests are not expanded or mentioned (see [Team review requests](#team-review-requests)). On draft PRs, CODEOWNERS are requested when the PR becomes ready for review. Those requests are usually outside the window and each posts its own channel message.

If any duplicate or missed message is unacceptable, this design is not sufficient. That would need shared state, which is out of scope for this action.

## Testing / not verified live

- **Unit tested (Jest, mocked):** the decision logic, including a simulated batch of 3 individual `review_requested` runs with identical snapshots (exactly one channel decision mentioning all 3, each run DMing only itself), event and API order permutations, case-insensitive dedupe, a triggering reviewer missing from the API list, empty and single lists, teams, label interactions in both orders, delayed runs past the old 60s execution-time boundary, the API loader's bounded retries with injected sleep, fallbacks and warnings, output wiring, and the characterization tests above.
- **Not verified live:** no test runs against real GitHub webhooks, the GitHub API or Slack. The real ordering and timing of GitHub's creation-time `labeled`/`review_requested` events and payload `updated_at` values, CODEOWNERS auto-assignment timing, and the end-to-end behaviour with the companion `slack-dual-notify-action` change have not been verified.

## Permissions

The action makes one read-only GitHub API call (`GET /repos/{owner}/{repo}/pulls/{number}`) for initial events, using `github-token` (default `${{ github.token }}`). Grant `pull-requests: read` in addition to the permissions your workflow already uses (for example `contents: read`). Without it, the call can fail on private repositories; the action then logs a warning and falls back to the event payload.

## Development

```bash
npm install
npm test
npm run lint
npm run build
```

`dist/index.js` is committed and must be rebuilt whenever `index.js` or `src/` changes.

## License

[MIT](LICENSE)
