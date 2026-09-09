import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { clearAllData, getAll, softDelete } from '../src/data/db.js';
import { importMyFitnessPalCSV } from '../src/data/io.js';

class TestFileReader {
  readAsText(blob) {
    blob.text().then(text => {
      this.result = text;
      this.onload?.();
    }, error => {
      this.error = error;
      this.onerror?.();
    });
  }
}

globalThis.FileReader ||= TestFileReader;

const header = 'Date,Meal,Food Name,Calories,Fat (g),Protein (g),Carbs (g)';
const rowA = '09/01/2026,Breakfast,Oatmeal,150,3,5,27';
const rowB = '09/01/2026,Lunch,Apple,95,0.3,0.5,25';
const rowC = '09/01/2026,Dinner,Bean Chili,320,8,18,45';

function csv(rows) {
  return new Blob([[header, ...rows].join('\n')], { type: 'text/csv' });
}

test('an appended MyFitnessPal export imports only its new rows', async () => {
  await clearAllData();

  assert.deepEqual(await importMyFitnessPalCSV(csv([rowA, rowB])), {
    imported: 2,
    skipped: 0,
  });
  assert.deepEqual(await importMyFitnessPalCSV(csv([rowA, rowB, rowC])), {
    imported: 1,
    skipped: 2,
  });

  const meals = await getAll('meals');
  assert.equal(meals.length, 3);
  assert.deepEqual(meals.map(meal => meal.items[0].foodId).sort(), [
    'mfp-apple',
    'mfp-bean-chili',
    'mfp-oatmeal',
  ]);
});

test('identical MyFitnessPal rows remain distinct but re-import idempotently', async () => {
  await clearAllData();
  const duplicateExport = csv([rowA, rowA]);

  assert.equal((await importMyFitnessPalCSV(duplicateExport)).imported, 2);
  const repeated = await importMyFitnessPalCSV(csv([rowA, rowA]));

  assert.deepEqual(repeated, { imported: 0, skipped: 2 });
  assert.equal((await getAll('meals')).length, 2);
});

test('re-import keeps a deliberately deleted MyFitnessPal row deleted', async () => {
  await clearAllData();
  assert.deepEqual(await importMyFitnessPalCSV(csv([rowA])), {
    imported: 1,
    skipped: 0,
  });
  const [meal] = await getAll('meals');
  await softDelete('meals', meal.id);

  assert.deepEqual(await importMyFitnessPalCSV(csv([rowA])), {
    imported: 0,
    skipped: 1,
  });
  assert.deepEqual(await getAll('meals'), []);
});
