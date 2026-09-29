const core = require("@actions/core");
const github = require("@actions/github");
const { parseNumberInput } = require("./src/number-input");
const { decideNotification } = require("./src/urgent");
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
      setOutputs({ urgent: false, targetUsers: [], sendChannel: false, sendDm: false }, "");
      return;
    }

    const decision = decideNotification({
      action,
      pullRequest,
      label: payload.label,
      requestedReviewer: payload.requested_reviewer,
      urgentLabel,
      freshWindowSeconds,
    });

    const reviewerCount = Array.isArray(pullRequest.requested_reviewers)
      ? pullRequest.requested_reviewers.length
      : 0;
    core.info(
      `Action: ${action}, UrgentLabel: ${urgentLabel}, RequestedReviewers: ${reviewerCount}, ` +
        `PrAge: ${Math.round(decision.prAgeSeconds)}s`,
    );

    const message = decision.urgent ? renderMessage(messageTemplate, pullRequest) : "";
    setOutputs(decision, message);

    core.info(
      `Result - Urgent: ${decision.urgent}, Users: ${decision.targetUsers.join(",")}, ` +
        `Channel: ${decision.sendChannel}, DM: ${decision.sendDm}`,
    );
  } catch (error) {
    core.setFailed(error.message);
  }
}

function setOutputs(decision, message) {
  core.setOutput("urgent", String(decision.urgent));
  core.setOutput("target-users", decision.targetUsers.join(","));
  core.setOutput("send-channel", String(decision.sendChannel));
  core.setOutput("send-dm", String(decision.sendDm));
  core.setOutput("message", message);
}

module.exports = { run, DEFAULT_MESSAGE_TEMPLATE };

if (require.main === module) run();
