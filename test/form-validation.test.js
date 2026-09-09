import test from 'node:test';
import assert from 'node:assert/strict';
import { readPositiveNumberInput } from '../src/utils/form-validation.js';

function inputFixture(value) {
  return {
    value,
    validationMessage: '',
    reported: false,
    focused: false,
    setCustomValidity(message) { this.validationMessage = message; },
    reportValidity() { this.reported = true; },
    focus() { this.focused = true; },
  };
}

test('positive quantity validation never replaces invalid input with a large default', () => {
  const zero = inputFixture('0');
  assert.equal(readPositiveNumberInput(zero, { report: true }), null);
  assert.equal(zero.value, '0');
  assert.match(zero.validationMessage, /at least/i);
  assert.equal(zero.reported, true);
  assert.equal(zero.focused, true);

  const valid = inputFixture('0.25');
  assert.equal(readPositiveNumberInput(valid, { report: true }), 0.25);
  assert.equal(valid.validationMessage, '');

  const fractionalYield = inputFixture('1.5');
  assert.equal(readPositiveNumberInput(fractionalYield, { min: 1, integer: true }), null);
});
