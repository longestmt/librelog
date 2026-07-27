import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateAIResponse } from '../src/integrations/aiValidation.js';

const fixtures = JSON.parse(
  await readFile(new URL('./fixtures/ai-estimates.json', import.meta.url), 'utf8'),
);

for (const fixture of fixtures) {
  test(`AI estimate fixture: ${fixture.name}`, () => {
    if (fixture.accepted === 0) {
      assert.throws(
        () => validateAIResponse(fixture.input, { sourceType: fixture.sourceType }),
        /valid food estimates/i,
      );
      return;
    }

    const result = validateAIResponse(fixture.input, {
      sourceType: fixture.sourceType,
      now: () => 42,
    });
    assert.equal(result.foods.length, fixture.accepted);
    if (fixture.expectedQuantity != null) {
      assert.equal(result.foods[0].servingSize.quantity, fixture.expectedQuantity);
    }
    if (fixture.expectedUnit) {
      assert.equal(result.foods[0].servingSize.unit, fixture.expectedUnit);
    }
    if (fixture.minimumWarnings) {
      assert.ok(result.warnings.length >= fixture.minimumWarnings);
    }
    for (const food of result.foods) {
      assert.equal(food._aiMeta.estimated, true);
      assert.ok(food._aiMeta.assumptions.length > 0);
    }
  });
}
