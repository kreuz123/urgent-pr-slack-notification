/**
 * Parses a non-negative number input.
 *
 * @param {string} name - Name of the input, used for error messages.
 * @param {string} rawValue - Raw string value of the input.
 * @param {number} defaultValue - Default value to use when rawValue is empty.
 * @returns {number} Parsed number.
 * @throws {Error} If rawValue is non-empty and not a finite, non-negative number.
 */
function parseNumberInput(name, rawValue, defaultValue) {
  const trimmed = (rawValue || "").trim();
  if (trimmed === "") return defaultValue;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Input "${name}" must be a non-negative number. Received: "${rawValue}"`);
  }
  return parsed;
}

module.exports = { parseNumberInput };
