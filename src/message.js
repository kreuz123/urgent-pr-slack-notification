const PLACEHOLDER_PATTERN = /\{\{\s*([a-z_]+)\s*\}\}/g;

/**
 * Builds the placeholder values that can be used inside a message template.
 *
 * @param {object} pullRequest - `pull_request` payload object.
 * @returns {Record<string, string>} Placeholder name to value.
 */
function escapeSlackText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildPlaceholders(pullRequest) {
  const number = pullRequest?.number;
  return {
    title: escapeSlackText(pullRequest?.title),
    url: pullRequest?.html_url ?? "",
    number: number === undefined || number === null ? "" : String(number),
    author: escapeSlackText(pullRequest?.user?.login),
    base: escapeSlackText(pullRequest?.base?.ref),
    head: escapeSlackText(pullRequest?.head?.ref),
  };
}

/**
 * Renders a message template, replacing `{{placeholder}}` tokens with pull
 * request values. Unknown placeholders are left untouched so that other
 * templating syntax is never mangled.
 *
 * @param {string} template - Message template.
 * @param {object} pullRequest - `pull_request` payload object.
 * @returns {string} Rendered message.
 */
function renderMessage(template, pullRequest) {
  const placeholders = buildPlaceholders(pullRequest);
  return template.replace(PLACEHOLDER_PATTERN, (match, key) =>
    Object.prototype.hasOwnProperty.call(placeholders, key) ? placeholders[key] : match,
  );
}

module.exports = { renderMessage, buildPlaceholders };
