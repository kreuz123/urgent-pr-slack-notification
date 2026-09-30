# Urgent PR Slack Notification

A GitHub Action that decides when a pull request labeled `urgent` needs a Slack notification, and produces the inputs for [`kreuz123/slack-dual-notify-action`](https://github.com/kreuz123/slack-dual-notify-action) so that reviewers get a DM and the channel gets a message that mentions them.

- ✅ Reacts to `pull_request` `labeled` and `review_requested` events.
- ✅ Skips reviewer notifications for a freshly opened PR, because the `review_requested` events that follow handle them.
- ✅ Notifies every currently requested reviewer when an existing PR becomes urgent.
- ✅ Notifies newly requested reviewers of an already urgent PR.
- ✅ Renders the Slack message from a template with pull request placeholders.
- ✅ Never calls the Slack API itself, so no Slack secrets are needed for this step.

## Usage

```yaml
name: Urgent PR Slack Notification

on:
  pull_request:
    types: [labeled, review_requested]

permissions:
  contents: read

jobs:
  notify_urgent:
    runs-on: ubuntu-latest
    steps:
      - name: Check urgent
        id: check
        uses: kreuz123/urgent-pr-slack-notification@v1

      - name: Send Slack notification
        if: steps.check.outputs.urgent == 'true'
        uses: kreuz123/slack-dual-notify-action@v1
        with:
          message-template: ${{ steps.check.outputs.message }}
          target-users: ${{ steps.check.outputs.target-users }}
          send-channel: ${{ steps.check.outputs.send-channel }}
          send-dm: ${{ steps.check.outputs.send-dm }}
          slack-bot-token: ${{ secrets.SLACK_BOT_TOKEN }}
          slack-channel-id: ${{ secrets.SLACK_CHANNEL_ID }}
          slack-reviewer-map: ${{ secrets.SLACK_REVIEWER_MAP }}
```

`SLACK_REVIEWER_MAP` is a JSON object mapping GitHub usernames to Slack user IDs, for example `{ "alice": "U0123456789" }`. Mapped reviewers are mentioned as `<@U0123456789>` in the channel message and receive a DM.

## How the decision is made

| Event              | Condition                                 | `target-users`      | `send-channel`  | `send-dm` |
| ------------------ | ----------------------------------------- | ------------------- | --------------- | --------- |
| `labeled`          | urgent label, PR is fresh, no reviewers    | empty               | `true`          | `false`   |
| `labeled`          | urgent label, PR is fresh, has reviewers   | empty               | `false`         | `false`   |
| `labeled`          | urgent label, PR is older than the window  | requested reviewers | `true`          | reviewers exist |
| `review_requested` | PR already has the urgent label            | the new reviewer    | `true`          | `true`    |
| anything else      | —                                          | empty               | `false`         | `false`   |

A pull request counts as fresh while its age is below `fresh-pr-window-seconds`. Labeling a fresh PR that already has reviewers sends nothing, because each following `review_requested` event notifies its reviewer individually.

## Inputs

| Input                     | Required | Default                                                | Description                                                         |
| ------------------------- | -------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| `urgent-label`            | No       | `urgent`                                               | Label name that marks a PR as urgent. Matching is case-insensitive.  |
| `message-template`        | No       | `🚨 Urgent PR: <{{url}}\|{{title}}> needs review ASAP!` | Slack message body. Newlines and special characters are preserved.   |
| `fresh-pr-window-seconds` | No       | `60`                                                   | Age in seconds below which a PR counts as freshly opened.            |

### Message placeholders

`{{title}}`, `{{url}}`, `{{number}}`, `{{author}}`, `{{base}}`, `{{head}}`. Unknown placeholders are left untouched.

## Outputs

| Output         | Description                                                                        |
| -------------- | ---------------------------------------------------------------------------------- |
| `urgent`       | `"true"` when the event should trigger an urgent Slack notification.                |
| `target-users` | Comma-separated GitHub usernames for `target-users` of `slack-dual-notify-action`.  |
| `send-channel` | `"true"` when a Slack channel notification should be sent.                          |
| `send-dm`      | `"true"` when reviewer DMs should be sent.                                          |
| `message`      | Rendered Slack message. Empty when `urgent` is `"false"`.                           |

## Migrating from the workflow

The previous setup used a `github-script` job plus a reusable workflow call. Replace both with the two steps shown in [Usage](#usage):

- The `github-script` decision logic becomes this action.
- The `./.github/workflows/REUSABLE_SLACK_NOTIFICATION.yml` job becomes `kreuz123/slack-dual-notify-action@v1`.
- Job outputs (`urgent`, `users`, `channel`, `dm`) become step outputs (`urgent`, `target-users`, `send-channel`, `send-dm`).
- The inline `message_template` expression becomes the `message-template` input with `{{url}}` and `{{title}}` placeholders, exposed as the `message` output.

## Permissions

This action only reads the webhook payload, so the default `contents: read` permission is enough. No GitHub token is required.

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
