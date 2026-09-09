const KG_PER_LB = 0.45359237;
const MS_PER_DAY = 86_400_000;

export function normalizeWeightUnit(unit) {
  return unit === 'lb' ? 'lb' : 'kg';
}

export function convertWeight(value, fromUnit, toUnit) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const from = normalizeWeightUnit(fromUnit);
  const to = normalizeWeightUnit(toUnit);
  if (from === to) return numeric;
  return from === 'lb' ? numeric * KG_PER_LB : numeric / KG_PER_LB;
}

function calendarDayNumber(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return null;
  const [year, month, day] = date.split('-').map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day) return null;
  return timestamp / MS_PER_DAY;
}

/**
 * Prepare measurements for display without changing their stored values.
 * Statistics and charts use one unit, and same-day readings contribute one
 * averaged point so frequently weighing on a day cannot dominate the trend.
 */
export function prepareWeightData(entries, preferredUnit = null) {
  const validEntries = (entries || [])
    .filter(entry => Number.isFinite(Number(entry.weight)) && Number(entry.weight) > 0)
    .map((entry, sourceIndex) => ({
      ...entry,
      weight: Number(entry.weight),
      bodyFat: entry.bodyFat != null
        && entry.bodyFat !== ''
        && Number.isFinite(Number(entry.bodyFat))
        && Number(entry.bodyFat) >= 0
        && Number(entry.bodyFat) <= 100
        ? Number(entry.bodyFat)
        : null,
      unit: normalizeWeightUnit(entry.unit),
      _sourceIndex: sourceIndex,
    }))
    .sort((a, b) => (a.date || '').localeCompare(b.date || '')
      || String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
      || a._sourceIndex - b._sourceIndex);

  const displayUnit = preferredUnit
    ? normalizeWeightUnit(preferredUnit)
    : validEntries.at(-1)?.unit || 'kg';
  const displayEntries = validEntries.map(entry => ({
    ...entry,
    displayWeight: convertWeight(entry.weight, entry.unit, displayUnit),
  }));

  const dailyGroups = new Map();
  for (const entry of displayEntries) {
    const dayNumber = calendarDayNumber(entry.date);
    if (dayNumber == null) continue;
    const group = dailyGroups.get(entry.date) || { values: [], dayNumber };
    group.values.push(entry.displayWeight);
    dailyGroups.set(entry.date, group);
  }

  const dailyEntries = [...dailyGroups.entries()]
    .map(([date, group]) => ({
      date,
      dayNumber: group.dayNumber,
      weight: group.values.reduce((sum, value) => sum + value, 0) / group.values.length,
      unit: displayUnit,
      readingCount: group.values.length,
    }))
    .sort((a, b) => a.dayNumber - b.dayNumber);

  const first = displayEntries[0] || null;
  const last = displayEntries.at(-1) || null;
  const average = dailyEntries.length > 0
    ? dailyEntries.reduce((sum, entry) => sum + entry.weight, 0) / dailyEntries.length
    : null;

  return {
    displayUnit,
    entries: displayEntries,
    dailyEntries,
    starting: first ? { ...first, weight: first.displayWeight, unit: displayUnit } : null,
    current: last ? { ...last, weight: last.displayWeight, unit: displayUnit } : null,
    delta: first && last ? last.displayWeight - first.displayWeight : null,
    average,
  };
}

/** Linear regression over elapsed calendar days, not array indexes. */
export function calculateWeightTrend(entries) {
  if (!Array.isArray(entries) || entries.length < 2) return null;
  const origin = entries[0].dayNumber;
  const points = entries.map(entry => ({
    x: entry.dayNumber - origin,
    y: entry.weight,
  }));
  const n = points.length;
  const sums = points.reduce((result, point) => ({
    x: result.x + point.x,
    y: result.y + point.y,
    xy: result.xy + point.x * point.y,
    x2: result.x2 + point.x * point.x,
  }), { x: 0, y: 0, xy: 0, x2: 0 });
  const denominator = n * sums.x2 - sums.x * sums.x;
  if (denominator === 0) return null;
  const slopePerDay = (n * sums.xy - sums.x * sums.y) / denominator;
  const intercept = (sums.y - slopePerDay * sums.x) / n;
  const lastDay = points.at(-1).x;
  return {
    slopePerDay,
    startWeight: intercept,
    endWeight: slopePerDay * lastDay + intercept,
    spanDays: lastDay,
  };
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

function selectEvenlySpacedIndexes(entryCount, maxLabels) {
  if (entryCount <= 0 || maxLabels <= 0) return [];
  if (entryCount <= maxLabels) return Array.from({ length: entryCount }, (_, index) => index);
  if (maxLabels === 1) return [entryCount - 1];

  return [...new Set(Array.from({ length: maxLabels }, (_, slot) => (
    Math.round((slot * (entryCount - 1)) / (maxLabels - 1))
  )))];
}

/**
 * Convert a prepared daily weight series into dimensionless chart geometry.
 * SVG and HTML layers can share these 0–100 coordinates without assuming that
 * the rendered plot is square. Dense series expose only a small, stable set of
 * labels while every point remains available through the chart description.
 */
export function createWeightChartModel(entries, { maxLabels = 5 } = {}) {
  const normalized = (entries || [])
    .filter(entry => Number.isFinite(Number(entry?.weight))
      && Number.isFinite(Number(entry?.dayNumber)))
    .map(entry => ({
      ...entry,
      weight: Number(entry.weight),
      dayNumber: Number(entry.dayNumber),
    }));
  if (normalized.length === 0) return null;

  let minIndex = 0;
  let maxIndex = 0;
  normalized.forEach((entry, index) => {
    if (entry.weight < normalized[minIndex].weight) minIndex = index;
    if (entry.weight > normalized[maxIndex].weight) maxIndex = index;
  });

  const trend = calculateWeightTrend(normalized);
  const extentWeights = normalized.map(entry => entry.weight);
  if (Number.isFinite(trend?.startWeight)) extentWeights.push(trend.startWeight);
  if (Number.isFinite(trend?.endWeight)) extentWeights.push(trend.endWeight);
  const extentMin = Math.min(...extentWeights);
  const extentMax = Math.max(...extentWeights);
  const extentRange = extentMax - extentMin;
  const padding = extentRange > 0
    ? extentRange * 0.1
    : Math.max(Math.abs(extentMin) * 0.001, 0.1);
  const chartMin = extentMin - padding;
  const chartMax = extentMax + padding;
  const chartRange = chartMax - chartMin;
  const startDay = normalized[0].dayNumber;
  const daySpan = normalized.at(-1).dayNumber - startDay;
  const labelIndexes = selectEvenlySpacedIndexes(
    normalized.length,
    Math.max(1, Math.floor(Number(maxLabels) || 1)),
  );
  const labelIndexSet = new Set(labelIndexes);
  const showAllValues = normalized.length <= maxLabels;

  const points = normalized.map((entry, index) => {
    const height = clampPercent(((entry.weight - chartMin) / chartRange) * 100);
    return {
      entry,
      index,
      x: daySpan > 0
        ? 2 + (((entry.dayNumber - startDay) / daySpan) * 96)
        : 50,
      y: 100 - height,
      height,
      showDateLabel: labelIndexSet.has(index),
      showValueLabel: showAllValues || index === minIndex || index === maxIndex,
    };
  });

  const toY = weight => 100 - clampPercent(((weight - chartMin) / chartRange) * 100);
  return {
    entries: normalized,
    points,
    trend,
    trendLine: trend ? {
      x1: points[0].x,
      y1: toY(trend.startWeight),
      x2: points.at(-1).x,
      y2: toY(trend.endWeight),
    } : null,
    minIndex,
    maxIndex,
    minWeight: normalized[minIndex].weight,
    maxWeight: normalized[maxIndex].weight,
    chartMin,
    chartMax,
    barWidthPercent: Math.min(7, Math.max(1.25, 60 / normalized.length)),
    labelIndexes,
  };
}

export { KG_PER_LB };
