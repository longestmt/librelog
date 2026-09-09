import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWeeklyCalorieBars, summarizeNutritionDays } from '../src/pages/insights.js';

test('nutrition summaries distinguish missing, in-progress, and past logged days', () => {
  const summary = summarizeNutritionDays([
    { date: '2026-09-06', calories: 1800, protein: 150, hasData: true },
    { date: '2026-09-07', calories: 0, protein: 0, hasData: false },
    { date: '2026-09-08', calories: 600, protein: 50, hasData: true },
  ], '2026-09-08');

  assert.deepEqual(summary.days.map(day => day.status), ['logged', 'missing', 'in-progress']);
  assert.equal(summary.averageCalories, 1800);
  assert.equal(summary.averageProtein, 150);
  assert.equal(summary.averageCaloriesDays, 1);
  assert.equal(summary.averageProteinDays, 1);
  assert.equal(summary.loggedDays.length, 1);
});

test('current-day values never become a past-day average', () => {
  const summary = summarizeNutritionDays([
    { date: '2026-09-08', calories: 1200, protein: 90, hasData: true },
  ], '2026-09-08');

  assert.equal(summary.averageCalories, null);
  assert.equal(summary.averageProtein, null);
  assert.equal(summary.loggedDays.length, 0);
});

test('nutrition averages exclude days where that nutrient is unknown', () => {
  const summary = summarizeNutritionDays([
    {
      date: '2026-09-05',
      calories: 1800,
      protein: 0,
      incomplete: ['protein'],
      hasData: true,
    },
    {
      date: '2026-09-06',
      calories: 2000,
      protein: 160,
      incomplete: [],
      hasData: true,
    },
    {
      date: '2026-09-07',
      calories: 400,
      protein: 30,
      incomplete: [],
      hasData: true,
    },
  ], '2026-09-07');

  assert.equal(summary.averageCalories, 1900);
  assert.equal(summary.averageCaloriesDays, 2);
  assert.equal(summary.averageProtein, 160);
  assert.equal(summary.averageProteinDays, 1);
  assert.equal(summary.loggedDays.length, 2);
});

test('nutrition average is unavailable when every logged value is unknown', () => {
  const summary = summarizeNutritionDays([
    {
      date: '2026-09-06',
      calories: 1800,
      protein: 0,
      incomplete: ['protein'],
      hasData: true,
    },
  ], '2026-09-07');

  assert.equal(summary.averageCalories, 1800);
  assert.equal(summary.averageProtein, null);
  assert.equal(summary.averageProteinDays, 0);
  assert.equal(summary.loggedDays.length, 1);
});

test('weekly calorie chart renders incomplete calories as unknown instead of zero', () => {
  const html = renderWeeklyCalorieBars([{
    date: '2026-09-06',
    dayLabel: 'Sun',
    calories: 0,
    incomplete: ['kcal'],
    hasData: true,
    status: 'logged',
  }], '2026-09-07', 2000);

  assert.match(html, /bar-column[^>]*unknown/);
  assert.match(html, /<div class="bar-gap"><\/div>/);
  assert.match(html, /<div class="bar-value">—<\/div>/);
  assert.match(html, /Calories unknown/);
  assert.doesNotMatch(html, /<div class="bar"/);
  assert.doesNotMatch(html, /<div class="bar-value">0<\/div>/);
});
