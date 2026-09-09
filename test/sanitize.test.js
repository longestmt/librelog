import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHTML } from '../src/utils/sanitize.js';

test('HTML escaping stringifies arrays and objects before escaping markup', () => {
  assert.equal(
    escapeHTML(["<style>body{display:none}</style><a href='https://attacker.example'>Continue</a>"]),
    '&lt;style&gt;body{display:none}&lt;/style&gt;&lt;a href=&#039;https://attacker.example&#039;&gt;Continue&lt;/a&gt;',
  );
  assert.equal(escapeHTML({ value: '<img>' }), '[object Object]');
  assert.equal(escapeHTML(null), '');
});
