import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { clearAllData, put, setSetting } from '../src/data/db.js';
import { searchFoodsWithStatus } from '../src/engine/food-search.js';
import { chatCompletion, isAIConfigured } from '../src/integrations/aiClient.js';
import { normalizeProduct } from '../src/integrations/openfoodfacts.js';
import { requestJSON } from '../src/integrations/request.js';
import { startRecording, transcribeAudio } from '../src/integrations/voiceParser.js';
import { getNutritionMultiplier } from '../src/utils/units.js';
import {
  calculateWeightTrend,
  convertWeight,
  createWeightChartModel,
  prepareWeightData,
} from '../src/engine/weight.js';

test('remote requests cannot cross the provider consent boundary', async t => {
  await clearAllData();
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount += 1;
    return Response.json({ ok: true });
  });

  await assert.rejects(
    requestJSON({
      provider: 'Test Food Source',
      consentKey: 'test-food-source',
      url: 'https://example.invalid/search',
    }),
    error => error.code === 'consent-required' && error.retryable === false,
  );
  assert.equal(fetchCount, 0);

  await setSetting('privacyConsent_test-food-source', true);
  const response = await requestJSON({
    provider: 'Test Food Source',
    consentKey: 'test-food-source',
    url: 'https://example.invalid/search',
  });
  assert.equal(response.data.ok, true);
  assert.equal(fetchCount, 1);
});

test('cloud AI text and audio stay offline until that provider is enabled', async t => {
  await clearAllData();
  await setSetting('ai_provider', 'openai');
  await setSetting('ai_api_key', 'test-only-key');
  await setSetting('ai_api_key_provider', 'openai');
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount += 1;
    return Response.json({ choices: [{ message: { content: '{}' } }] });
  });

  assert.equal(await isAIConfigured(), false);
  const completion = await chatCompletion([{ role: 'user', content: 'synthetic meal' }]);
  assert.match(completion.error, /off until you enable it/i);
  const transcription = await transcribeAudio(new Blob(['synthetic audio']));
  assert.match(transcription.error, /off until you enable it/i);
  assert.equal(fetchCount, 0);

  await setSetting('privacyConsent_ai_openai', true);
  assert.equal(await isAIConfigured(), true);
});

test('a cloud API key is never sent to a different AI provider', async t => {
  await clearAllData();
  await setSetting('ai_provider', 'anthropic');
  await setSetting('ai_api_key', 'openai-only-key');
  await setSetting('ai_api_key_provider', 'openai');
  await setSetting('privacyConsent_ai_anthropic', true);
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount += 1;
    return Response.json({ content: [{ text: '{}' }] });
  });

  assert.equal(await isAIConfigured(), false);
  const completion = await chatCompletion([{ role: 'user', content: 'synthetic meal' }]);
  assert.match(completion.error, /enter an API key.*anthropic/i);
  assert.equal(fetchCount, 0);
});

test('an unbound legacy cloud API key stays offline until it is re-entered', async t => {
  await clearAllData();
  await setSetting('ai_provider', 'anthropic');
  await setSetting('ai_api_key', 'ambiguous-legacy-key');
  await setSetting('privacyConsent_ai_anthropic', true);
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount += 1;
    return Response.json({ content: [{ text: '{}' }] });
  });

  assert.equal(await isAIConfigured(), false);
  const completion = await chatCompletion([{ role: 'user', content: 'synthetic meal' }]);
  assert.match(completion.error, /enter an API key.*anthropic/i);
  assert.equal(fetchCount, 0);
});

test('food search returns local matches and structured consent status without networking', async t => {
  await clearAllData();
  await put('foods', {
    id: 'local-oats',
    name: 'Local oats',
    servingSize: { quantity: 100, unit: 'g' },
  });
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount += 1;
    return Response.json({ products: [] });
  });

  const result = await searchFoodsWithStatus('oats', {
    sources: { local: true, usda: false, off: true },
  });

  assert.deepEqual(result.foods.map(food => food.id), ['local-oats']);
  assert.equal(result.status.local.state, 'ok');
  assert.equal(result.status.off.state, 'consent-required');
  assert.equal(fetchCount, 0);
});

test('local food search treats regular-expression characters as literal text', async () => {
  await clearAllData();
  await put('foods', {
    id: 'local-bracket-food',
    name: 'Cereal [family pack]',
    servingSize: { quantity: 100, unit: 'g' },
  });

  const result = await searchFoodsWithStatus('[', {
    localOnly: true,
    sources: { local: true, usda: false, off: false },
  });

  assert.deepEqual(result.foods.map(food => food.id), ['local-bracket-food']);
  assert.equal(result.status.local.state, 'ok');
});

test('food search distinguishes a provider failure from no matches', async t => {
  await clearAllData();
  await setSetting('privacyConsent_openfoodfacts', true);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 400 }));

  const result = await searchFoodsWithStatus('oats', {
    sources: { local: true, usda: false, off: true },
  });

  assert.deepEqual(result.foods, []);
  assert.equal(result.status.off.state, 'error');
  assert.equal(result.status.off.code, 'http');
  assert.equal(result.status.off.retryable, false);
});

test('USDA reports a missing credential as a source error', async t => {
  await clearAllData();
  await setSetting('privacyConsent_usda', true);
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount += 1;
    return Response.json({ foods: [] });
  });

  const result = await searchFoodsWithStatus('eggs', {
    sources: { local: false, usda: true, off: false },
  });

  assert.deepEqual(result.foods, []);
  assert.equal(result.status.usda.state, 'error');
  assert.equal(result.status.usda.code, 'not-configured');
  assert.equal(result.status.usda.retryable, false);
  assert.match(result.status.usda.message, /API key in Settings/i);
  assert.equal(fetchCount, 0);
});

test('browser speech consent is enforced before microphone access', async () => {
  await clearAllData();
  await setSetting('ai_provider', 'anthropic');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let microphoneRequests = 0;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { SpeechRecognition: class {} },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      language: 'en-US',
      mediaDevices: {
        getUserMedia: async () => {
          microphoneRequests += 1;
          throw new Error('synthetic microphone stop');
        },
      },
    },
  });

  try {
    await assert.rejects(
      startRecording(),
      error => error.code === 'consent-required' && error.retryable === false,
    );
    assert.equal(microphoneRequests, 0);

    await setSetting('privacyConsent_browser_speech', true);
    await assert.rejects(startRecording(), /synthetic microphone stop/i);
    assert.equal(microphoneRequests, 1);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete globalThis.window;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
  }
});

test('voice setup releases the microphone if recorder construction fails', async () => {
  await clearAllData();
  await setSetting('ai_provider', 'openai');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder');
  let trackStopped = false;
  let contextClosed = false;

  class FakeAudioContext {
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { fftSize: 0, frequencyBinCount: 1 }; }
    async close() { contextClosed = true; }
  }
  class ThrowingMediaRecorder {
    static isTypeSupported() { return true; }
    constructor() { throw new Error('synthetic recorder failure'); }
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { AudioContext: FakeAudioContext },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop: () => { trackStopped = true; } }],
        }),
      },
    },
  });
  Object.defineProperty(globalThis, 'MediaRecorder', {
    configurable: true,
    value: ThrowingMediaRecorder,
  });

  try {
    await assert.rejects(startRecording(), /synthetic recorder failure/);
    assert.equal(trackStopped, true);
    assert.equal(contextClosed, true);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete globalThis.window;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
    if (originalMediaRecorder) Object.defineProperty(globalThis, 'MediaRecorder', originalMediaRecorder);
    else delete globalThis.MediaRecorder;
  }
});

test('OFF normalization preserves a verified package serving basis', () => {
  const food = normalizeProduct({
    code: 'package-fixture',
    product_name: 'Package fixture',
    serving_quantity: '40',
    serving_quantity_unit: 'g',
    serving_size: '1 bar (40 g)',
    nutriments: {
      'energy-kcal_100g': 500,
      proteins_100g: 20,
      'energy-kcal_serving': 200,
      proteins_serving: 8,
      carbohydrates_serving: 22,
      fat_serving: 9,
      sodium_serving: 0.15,
    },
  });

  assert.deepEqual(food.servingSize, {
    quantity: 1,
    unit: 'serving',
    label: '1 bar (40 g)',
    packageQuantity: 40,
    packageUnit: 'g',
    gramsPerUnit: 40,
  });
  assert.equal(food.nutrients.energy.kcal, 200);
  assert.equal(food.nutrients.macros.protein.g, 8);
  assert.equal(food.nutrients.sodium.mg, 150);
  assert.equal(getNutritionMultiplier(1, 'serving', food), 1);
  assert.equal(getNutritionMultiplier(20, 'g', food), 0.5);
  assert.equal(food.source.nutritionBasis, 'serving');
});

test('OFF normalization falls back to 100g when serving data is ambiguous', () => {
  const food = normalizeProduct({
    code: 'ambiguous-fixture',
    product_name: 'Ambiguous fixture',
    serving_quantity: '40',
    serving_size: 'about one bar',
    nutriments: {
      'energy-kcal_100g': 500,
      proteins_100g: 20,
      // No normalized serving calorie value: do not mix serving and 100g data.
      proteins_serving: 8,
    },
  });

  assert.deepEqual(food.servingSize, { quantity: 100, unit: 'g' });
  assert.equal(food.nutrients.energy.kcal, 500);
  assert.equal(food.nutrients.macros.protein.g, 20);
  assert.equal(food.source.nutritionBasis, '100g');
});

test('mixed kg and lb measurements produce one converted daily series', () => {
  const prepared = prepareWeightData([
    { id: 'one', date: '2026-09-01', weight: 100, unit: 'kg' },
    { id: 'two', date: '2026-09-05', weight: 220.462262, unit: 'lb' },
    { id: 'three', date: '2026-09-05', weight: 221, unit: 'lb' },
  ]);

  assert.equal(prepared.displayUnit, 'lb');
  assert.ok(Math.abs(prepared.starting.weight - 220.462262) < 0.0001);
  assert.ok(Math.abs(prepared.delta - 0.537738) < 0.0001);
  assert.equal(prepared.dailyEntries.length, 2);
  assert.equal(prepared.dailyEntries[1].readingCount, 2);
  assert.ok(Math.abs(prepared.average - ((220.462262 + 220.731131) / 2)) < 0.0001);
  assert.ok(Math.abs(convertWeight(220.462262, 'lb', 'kg') - 100) < 0.0001);
});

test('weight trend regression uses elapsed calendar days', () => {
  const prepared = prepareWeightData([
    { date: '2026-09-01', weight: 100, unit: 'kg' },
    { date: '2026-09-02', weight: 101, unit: 'kg' },
    { date: '2026-09-11', weight: 110, unit: 'kg' },
  ], 'kg');
  const trend = calculateWeightTrend(prepared.dailyEntries);

  assert.equal(trend.spanDays, 10);
  assert.ok(Math.abs(trend.slopePerDay - 1) < 1e-10);
  assert.ok(Math.abs(trend.startWeight - 100) < 1e-10);
  assert.ok(Math.abs(trend.endWeight - 110) < 1e-10);
});

test('weight chart model uses endpoint geometry without square-chart rotation math', () => {
  const prepared = prepareWeightData([
    { date: '2026-09-01', weight: 100, unit: 'kg' },
    { date: '2026-09-02', weight: 101, unit: 'kg' },
    { date: '2026-09-11', weight: 110, unit: 'kg' },
  ], 'kg');
  const model = createWeightChartModel(prepared.dailyEntries);

  assert.equal(model.trendLine.x1, 2);
  assert.equal(model.trendLine.x2, 98);
  assert.ok(model.trendLine.y1 > model.trendLine.y2);
  assert.ok(model.trendLine.y1 >= 0 && model.trendLine.y1 <= 100);
  assert.ok(model.trendLine.y2 >= 0 && model.trendLine.y2 <= 100);
  assert.deepEqual(model.points.map(point => Math.round(point.x * 10) / 10), [2, 11.6, 98]);
});

test('dense weight chart models cap visible date labels and narrow their bars', () => {
  const entries = Array.from({ length: 30 }, (_, index) => ({
    date: `2026-09-${String(index + 1).padStart(2, '0')}`,
    dayNumber: index,
    weight: 200 - (index * 0.2),
    unit: 'lb',
  }));
  const model = createWeightChartModel(entries, { maxLabels: 5 });

  assert.equal(model.labelIndexes.length, 5);
  assert.equal(model.labelIndexes[0], 0);
  assert.equal(model.labelIndexes.at(-1), 29);
  assert.equal(model.points.filter(point => point.showDateLabel).length, 5);
  assert.ok(model.barWidthPercent <= 2);
  assert.equal(model.points.filter(point => point.showValueLabel).length, 2);
});
