/**
 * io.js — Import/export for LibreLog
 * Handles JSON backups, CSV diary exports, and MyFitnessPal CSV import
 */

import { exportAllData, importAllData, put, getAll } from './db.js';

/**
 * Download JSON data as a file
 * @param {Object} data
 * @param {string} filename
 */
export function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
}

/**
 * Export all LibreLog data as JSON backup
 * Filename: librelog-backup-{YYYY-MM-DD}.json
 * @returns {Promise<void>}
 */
export async function exportData() {
    const data = await exportAllData();
    const date = new Date().toISOString().split('T')[0];
    downloadJSON(data, `librelog-backup-${date}.json`);
}

/**
 * Read a JSON file as a Promise
 * @param {File} file
 * @returns {Promise<Object>}
 */
export function readFileAsJSON(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            try { resolve(JSON.parse(reader.result)); }
            catch (e) { reject(new Error('Invalid JSON file')); }
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file);
    });
}

/**
 * Import data from a JSON backup file
 * @param {File} file
 * @param {boolean} merge - if false, clears existing data first
 * @returns {Promise<void>}
 */
export async function importData(file, merge = false) {
    const data = await readFileAsJSON(file);
    if (!data.stores) throw new Error('Invalid LibreLog backup file');
    await importAllData(data, merge);
}

/**
 * Import meals from a MyFitnessPal CSV export.
 * MFP CSV format: Date, Meal, Food Name, Calories, Fat (g), Protein (g), Carbs (g), ...
 * Handles both the "Food Diary" and common third-party MFP export formats.
 * @param {File} file - CSV file from MFP export
 * @returns {Promise<{imported: number, skipped: number}>}
 */
export async function importMyFitnessPalCSV(file) {
  const text = await readFileAsText(file);
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) throw new Error('CSV file appears empty');

  // Parse header to find column indices
  const header = parseCSVLine(lines[0]).map(h => h.toLowerCase().trim());
  const colMap = {
    date: findCol(header, ['date']),
    meal: findCol(header, ['meal', 'meal type', 'mealtype']),
    name: findCol(header, ['food name', 'food', 'name', 'description']),
    calories: findCol(header, ['calories', 'energy (kcal)', 'energy', 'cals']),
    fat: findCol(header, ['fat (g)', 'fat', 'total fat']),
    protein: findCol(header, ['protein (g)', 'protein']),
    carbs: findCol(header, ['carbs (g)', 'carbs', 'carbohydrates', 'total carbohydrate']),
    fiber: findCol(header, ['fiber (g)', 'fiber', 'dietary fiber']),
    sodium: findCol(header, ['sodium (mg)', 'sodium']),
  };

  if (colMap.date === -1 || colMap.name === -1) {
    throw new Error('CSV must have at least Date and Food Name columns');
  }

  let imported = 0;
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length < 3) { skipped++; continue; }

    const dateRaw = cols[colMap.date]?.trim();
    const name = cols[colMap.name]?.trim();
    if (!dateRaw || !name) { skipped++; continue; }

    // Parse date (MFP uses various formats: MM/DD/YYYY, YYYY-MM-DD, etc.)
    const date = normalizeDate(dateRaw);
    if (!date) { skipped++; continue; }

    const mealRaw = colMap.meal >= 0 ? cols[colMap.meal]?.trim().toLowerCase() : '';
    const mealType = normalizeMealType(mealRaw);

    const kcal = parseFloat(cols[colMap.calories]) || 0;
    const protein = colMap.protein >= 0 ? parseFloat(cols[colMap.protein]) || 0 : 0;
    const carbs = colMap.carbs >= 0 ? parseFloat(cols[colMap.carbs]) || 0 : 0;
    const fat = colMap.fat >= 0 ? parseFloat(cols[colMap.fat]) || 0 : 0;
    const fiber = colMap.fiber >= 0 ? parseFloat(cols[colMap.fiber]) || 0 : 0;
    const sodium = colMap.sodium >= 0 ? parseFloat(cols[colMap.sodium]) || 0 : 0;

    // Create or find food entry
    const foodId = `mfp-${name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 50)}`;

    // Save food
    await put('foods', {
      id: foodId,
      name,
      servingSize: { quantity: 100, unit: 'g', aliases: [] },
      nutrients: {
        energy: { kcal },
        macros: { protein: { g: protein }, carbs: { g: carbs }, fat: { g: fat } },
        fiber: { g: fiber },
        sodium: { mg: sodium },
      },
      source: { type: 'myfitnesspal' },
    });

    // Create meal entry
    const mealId = `mfp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await put('meals', {
      id: mealId,
      date,
      type: mealType,
      items: [{
        foodId,
        quantity: 100,
        unit: 'g',
        notes: 'Imported from MyFitnessPal',
        nutrients: { kcal, protein, carbs, fat, fiber, sodium },
      }],
      createdAt: new Date().toISOString(),
    });

    imported++;
  }

  return { imported, skipped };
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function findCol(header, candidates) {
  for (const c of candidates) {
    const idx = header.indexOf(c);
    if (idx >= 0) return idx;
  }
  // Partial match
  for (const c of candidates) {
    const idx = header.findIndex(h => h.includes(c));
    if (idx >= 0) return idx;
  }
  return -1;
}

function normalizeDate(raw) {
  // Try ISO format first
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  // MM/DD/YYYY
  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  // DD/MM/YYYY
  const dmy = raw.match(/^(\d{1,2})[-.](\d{1,2})[-.](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  // Try Date.parse as last resort
  const parsed = new Date(raw);
  if (!isNaN(parsed)) return parsed.toISOString().split('T')[0];
  return null;
}

function normalizeMealType(raw) {
  if (!raw) return 'lunch';
  if (raw.includes('breakfast') || raw.includes('morning')) return 'breakfast';
  if (raw.includes('lunch') || raw.includes('midday')) return 'lunch';
  if (raw.includes('dinner') || raw.includes('evening') || raw.includes('supper')) return 'dinner';
  if (raw.includes('snack')) return 'snacks';
  return 'lunch';
}

/**
 * Export diary entries (meals) as CSV
 * Columns: Date, MealType, FoodName, Quantity, Unit, Calories, Protein, Carbs, Fat
 * @param {Array<Object>} meals
 * @returns {void}
 */
export function exportDiaryCSV(meals) {
    const headers = ['Date', 'MealType', 'FoodName', 'Quantity', 'Unit', 'Calories', 'Protein', 'Carbs', 'Fat'];
    const rows = [headers.join(',')];

    for (const meal of meals) {
        const foods = meal.foods || [];
        for (const foodEntry of foods) {
            rows.push([
                meal.date || '',
                meal.mealType || '',
                foodEntry.name || '',
                foodEntry.quantity || '',
                foodEntry.unit || '',
                foodEntry.calories || '',
                foodEntry.protein || '',
                foodEntry.carbs || '',
                foodEntry.fat || '',
            ].map(v => {
                // Escape quotes in CSV values
                const str = String(v);
                return str.includes(',') || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
            }).join(','));
        }
    }

    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'librelog-diary.csv';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
}
