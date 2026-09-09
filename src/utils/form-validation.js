/** Read a positive number without silently replacing invalid user input. */
export function readPositiveNumberInput(input, {
  report = false,
  min = 0.1,
  integer = false,
} = {}) {
  const value = Number(input?.value);
  const valid = Boolean(input)
    && Number.isFinite(value)
    && value >= min
    && (!integer || Number.isInteger(value));
  const message = integer
    ? `Enter a whole number of at least ${min}.`
    : `Enter a quantity of at least ${min}.`;
  input?.setCustomValidity(valid ? '' : message);
  if (!valid) {
    if (report) input?.reportValidity();
    input?.focus();
    return null;
  }
  return value;
}
