const core = require("@actions/core");
const github = require("@actions/github");
const { parseNumberInput } = require("./src/number-input");
const { decideNotification } = require("./src/urgent");
const { createPullRequestStateLoader } = require("./src/pull-request-state");
const { renderMessage } = require("./src/message");

const DEFAULT_MESSAGE_TEMPLATE = "🚨 Urgent PR: <{{url}}|{{title}}> needs review ASAP!";

async function run() {
  try {
    const urgentLabelInput = core.getInput("urgent-label");
    const urgentLabel = urgentLabelInput.trim() === "" ? "urgent" : urgentLabelInput.trim();
    const messageTemplateInput = core.getInput("message-template", { trimWhitespace: false });
    const messageTemplate = messageTemplateInput === "" ? DEFAULT_MESSAGE_TEMPLATE : messageTemplateInput;
    const freshWindowSeconds = parseNumberInput("fresh-pr-window-seconds", core.getInput("fresh-pr-window-seconds"), 60);

    const payload = github.context.payload || {};
    const action = payload.action || "";
    const pullRequest = payload.pull_request;

    if (!pullRequest) {
      core.info("No pull_request payload found; skipping urgent notification.");
      setOutputs({ urgent: false, targetUsers: [], mentionUsers: [], sendChannel: false, sendDm: false }, "");
      return;
    }

    const token = core.getInput("github-token");
    let loadPullRequestState;
    if (token) {
      const { owner, repo } = github.context.repo;
      loadPullRequestState = createPullRequestStateLoader({
        octokit: github.getOctokit(token),
        owner,
        repo,
        pullNumber: pullRequest.number,
        warn: core.warning,
      });
    }

    const decision = await decideNotification({
      action,
      pullRequest,
      label: payload.label,
      requestedReviewer: payload.requested_reviewer,
      urgentLabel,
      freshWindowSeconds,
      loadPullRequestState,
      warn: core.warning,
    });

    const reviewerCount = Array.isArray(pullRequest.requested_reviewers)
      ? pullRequest.requested_reviewers.length
      : 0;
    if (action === "review_requested" && !payload.requested_reviewer && payload.requested_team) {
      core.info("Team review requests are not expanded to team members; skipping.");
    }
    core.info(
      `Action: ${action}, UrgentLabel: ${urgentLabel}, RequestedReviewers: ${reviewerCount}, ` +
        `EventAge: ${Math.round(decision.eventAgeSeconds)}s (${decision.ageSource}), Initial: ${decision.initial}, ` +
        `ReviewerSource: ${decision.reviewerSource}`,
    );

    const message = decision.urgent ? renderMessage(messageTemplate, pullRequest) : "";
    setOutputs(decision, message);

    core.info(
      `Result - Urgent: ${decision.urgent}, Users: ${decision.targetUsers.join(",")}, ` +
        `Mentions: ${decision.mentionUsers.join(",")}, ` +
        `Channel: ${decision.sendChannel}, DM: ${decision.sendDm}`,
    );
  } catch (error) {
    core.setFailed(error.message);
  }
}

function setOutputs(decision, message) {
  core.setOutput("urgent", String(decision.urgent));
  core.setOutput("target-users", decision.targetUsers.join(","));
  core.setOutput("mention-users", decision.mentionUsers.join(","));
  core.setOutput("send-channel", String(decision.sendChannel));
  core.setOutput("send-dm", String(decision.sendDm));
  core.setOutput("message", message);
}

module.exports = { run, DEFAULT_MESSAGE_TEMPLATE };

if (require.main === module) run();
