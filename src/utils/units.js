/**
 * Unit conversion system for LibreLog
 * Supports g, oz, cups, tbsp, tsp, ml, pieces, and common serving sizes
 */

/**
 * All supported units with their conversion factor to grams
 * For volume units, conversion assumes water density (1g/ml) as baseline;
 * individual foods can override via servingSize.aliases
 */
const UNIT_DEFINITIONS = {
  // Mass
  g:     { label: 'g',     group: 'mass',   toGrams: 1 },
  kg:    { label: 'kg',    group: 'mass',   toGrams: 1000 },
  oz:    { label: 'oz',    group: 'mass',   toGrams: 28.3495 },
  lb:    { label: 'lb',    group: 'mass',   toGrams: 453.592 },

  // Volume (using water density as default; foods can override)
  ml:    { label: 'ml',    group: 'volume', toGrams: 1 },
  l:     { label: 'L',     group: 'volume', toGrams: 1000 },
  cup:   { label: 'cup',   group: 'volume', toGrams: 240 },
  tbsp:  { label: 'tbsp',  group: 'volume', toGrams: 15 },
  tsp:   { label: 'tsp',   group: 'volume', toGrams: 5 },
  fl_oz: { label: 'fl oz', group: 'volume', toGrams: 29.5735 },

  // Count-based (require food-specific weight per piece)
  piece:  { label: 'piece',  group: 'count', toGrams: null },
  slice:  { label: 'slice',  group: 'count', toGrams: null },
  large:  { label: 'large',  group: 'count', toGrams: null },
  medium: { label: 'medium', group: 'count', toGrams: null },
  small:  { label: 'small',  group: 'count', toGrams: null },
};

/**
 * Get available units for a given food, including its native unit and aliases
 * @param {Object} food - Food object with servingSize and optional aliases
 * @returns {Array<{value: string, label: string}>} Available unit options
 */
export function getUnitsForFood(food) {
  const units = [];
  const seen = new Set();

  // Always include the food's native serving unit first
  const nativeUnit = food?.servingSize?.unit || 'g';
  units.push({ value: nativeUnit, label: getUnitLabel(nativeUnit) });
  seen.add(nativeUnit);

  // Add aliases defined on the food
  if (food?.servingSize?.aliases) {
    for (const alias of food.servingSize.aliases) {
      if (!seen.has(alias.unit)) {
        units.push({ value: alias.unit, label: getUnitLabel(alias.unit) });
        seen.add(alias.unit);
      }
    }
  }

  // Add standard mass units
  for (const key of ['g', 'oz']) {
    if (!seen.has(key)) {
      units.push({ value: key, label: UNIT_DEFINITIONS[key].label });
      seen.add(key);
    }
  }

  // Add volume units for foods typically measured by volume
  const volumeCategories = ['Beverage', 'Dairy', 'Oil', 'Sauce', 'Soup'];
  const isVolumeFood = volumeCategories.includes(food?.category) ||
    ['ml', 'l', 'cup', 'tbsp', 'tsp', 'fl_oz'].includes(nativeUnit);

  if (isVolumeFood) {
    for (const key of ['ml', 'cup', 'tbsp', 'tsp', 'fl_oz']) {
      if (!seen.has(key)) {
        units.push({ value: key, label: UNIT_DEFINITIONS[key].label });
        seen.add(key);
      }
    }
  }

  return units;
}

/**
 * Get display label for a unit
 * @param {string} unit - Unit key
 * @returns {string} Human-readable label
 */
export function getUnitLabel(unit) {
  return UNIT_DEFINITIONS[unit]?.label || unit;
}

/**
 * Convert a quantity from one unit to grams
 * @param {number} quantity - Amount in source unit
 * @param {string} fromUnit - Source unit key
 * @param {Object} [food] - Food object (needed for count-based units)
 * @returns {number} Equivalent amount in grams
 */
export function convertToGrams(quantity, fromUnit, food) {
  if (!quantity || quantity <= 0) return 0;

  // If already grams, return as-is
  if (fromUnit === 'g') return quantity;

  // Check food-specific aliases first (most accurate)
  if (food?.servingSize?.aliases) {
    const alias = food.servingSize.aliases.find(a => a.unit === fromUnit);
    if (alias && alias.gramsPerUnit) {
      return quantity * alias.gramsPerUnit;
    }
  }

  // If the fromUnit matches the food's native serving unit, use its quantity as the gram equivalent
  if (food?.servingSize && fromUnit === food.servingSize.unit) {
    // The food's nutrition is per servingSize.quantity of servingSize.unit
    // So 1 native unit = servingSize.quantity grams (for gram-based), or use alias
    const nativeDef = UNIT_DEFINITIONS[fromUnit];
    if (nativeDef && nativeDef.toGrams !== null) {
      return quantity * nativeDef.toGrams;
    }
    // For count-based native units (e.g., "1 large egg = 50g"), check aliases
    // If no alias provides grams, treat the serving quantity as the base
    return quantity * (food.servingSize.quantity || 1);
  }

  // Use standard conversion table
  const def = UNIT_DEFINITIONS[fromUnit];
  if (def && def.toGrams !== null) {
    return quantity * def.toGrams;
  }

  // Fallback: treat as grams
  return quantity;
}

/**
 * Calculate the nutrition multiplier for a given quantity and unit
 * relative to a food's serving size
 * @param {number} quantity - Amount consumed
 * @param {string} unit - Unit of measurement
 * @param {Object} food - Food object with servingSize and nutrients
 * @returns {number} Multiplier to apply to the food's per-serving nutrition
 */
export function getNutritionMultiplier(quantity, unit, food) {
  if (!food?.servingSize) return quantity / 100;

  const servingQty = food.servingSize.quantity || 100;
  const servingUnit = food.servingSize.unit || 'g';

  // Same unit as food's serving: simple ratio
  if (unit === servingUnit) {
    return quantity / servingQty;
  }

  // Convert both to grams, then compute ratio
  const consumedGrams = convertToGrams(quantity, unit, food);
  const servingGrams = convertToGrams(servingQty, servingUnit, food);

  if (servingGrams <= 0) return quantity / 100;

  return consumedGrams / servingGrams;
}

export { UNIT_DEFINITIONS };
