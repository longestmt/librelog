/**
 * seed-foods.js — Default food database for LibreLog
 * 30 common foods with accurate USDA nutrition values
 */

/**
 * Default foods with complete nutrition data
 * Structure: { name, servingSize: { quantity, unit }, nutrients: { energy, macros, fiber, sodium }, category, source }
 * Nutrition values are per standard serving, sourced from USDA FoodData Central
 */
export const DEFAULT_FOODS = [
    {
        name: 'Egg, large',
        servingSize: { quantity: 1, unit: 'large' },
        nutrients: {
            energy: { kcal: 70 },
            macros: { protein: { g: 6 }, carbs: { g: 0.5 }, fat: { g: 5 } },
            fiber: { g: 0 },
            sodium: { mg: 71 }
        },
        category: 'Protein',
        source: { type: 'seed' }
    },
    {
        name: 'Chicken breast, skinless',
        servingSize: { quantity: 100, unit: 'g' },
        nutrients: {
            energy: { kcal: 165 },
            macros: { protein: { g: 31 }, carbs: { g: 0 }, fat: { g: 3.6 } },
            fiber: { g: 0 },
            sodium: { mg: 74 }
        },
        category: 'Protein',
        source: { type: 'seed' }
    },
    {
        name: 'Rice, white, cooked',
        servingSize: { quantity: 100, unit: 'g' },
        nutrients: {
            energy: { kcal: 130 },
            macros: { protein: { g: 2.7 }, carbs: { g: 28 }, fat: { g: 0.3 } },
            fiber: { g: 0.4 },
            sodium: { mg: 2 }
        },
        category: 'Grain',
        source: { type: 'seed' }
    },
    {
        name: 'Oatmeal, cooked',
        servingSize: { quantity: 150, unit: 'g' },
        nutrients: {
            energy: { kcal: 150 },
            macros: { protein: { g: 5 }, carbs: { g: 27 }, fat: { g: 3 } },
            fiber: { g: 4 },
            sodium: { mg: 2 }
        },
        category: 'Grain',
        source: { type: 'seed' }
    },
    {
        name: 'Banana, medium',
        servingSize: { quantity: 1, unit: 'medium' },
        nutrients: {
            energy: { kcal: 105 },
            macros: { protein: { g: 1.3 }, carbs: { g: 27 }, fat: { g: 0.3 } },
            fiber: { g: 3.1 },
            sodium: { mg: 1 }
        },
        category: 'Fruit',
        source: { type: 'seed' }
    },
    {
        name: 'Apple, medium',
        servingSize: { quantity: 1, unit: 'medium' },
        nutrients: {
            energy: { kcal: 95 },
            macros: { protein: { g: 0.5 }, carbs: { g: 25 }, fat: { g: 0.3 } },
            fiber: { g: 4.4 },
            sodium: { mg: 2 }
        },
        category: 'Fruit',
        source: { type: 'seed' }
    },
    {
        name: 'Milk, whole',
        servingSize: { quantity: 240, unit: 'ml' },
        nutrients: {
            energy: { kcal: 150 },
            macros: { protein: { g: 8 }, carbs: { g: 12 }, fat: { g: 8 } },
            fiber: { g: 0 },
            sodium: { mg: 98 }
        },
        category: 'Dairy',
        source: { type: 'seed' }
    },
    {
        name: 'Bread, whole wheat',
        servingSize: { quantity: 28, unit: 'g' },
        nutrients: {
            energy: { kcal: 80 },
            macros: { protein: { g: 4 }, carbs: { g: 14 }, fat: { g: 1 } },
            fiber: { g: 2.4 },
            sodium: { mg: 140 }
        },
        category: 'Grain',
        source: { type: 'seed' }
    },
    {
        name: 'Salmon, cooked',
        servingSize: { quantity: 100, unit: 'g' },
        nutrients: {
            energy: { kcal: 208 },
            macros: { protein: { g: 22 }, carbs: { g: 0 }, fat: { g: 13 } },
            fiber: { g: 0 },
            sodium: { mg: 59 }
        },
        category: 'Protein',
        source: { type: 'seed' }
    },
    {
        name: 'Broccoli, raw',
        servingSize: { quantity: 100, unit: 'g' },
        nutrients: {
            energy: { kcal: 34 },
            macros: { protein: { g: 2.8 }, carbs: { g: 7 }, fat: { g: 0.4 } },
            fiber: { g: 2.4 },
            sodium: { mg: 64 }
        },
        category: 'Vegetable',
        source: { type: 'seed' }
    },
    {
        name: 'Sweet potato, baked',
        servingSize: { quantity: 100, unit: 'g' },
        nutrients: {
            energy: { kcal: 86 },
            macros: { protein: { g: 1.6 }, carbs: { g: 20 }, fat: { g: 0.1 } },
            fiber: { g: 3 },
            sodium: { mg: 55 }
        },
        category: 'Vegetable',
        source: { type: 'seed' }
    },
    {
        name: 'Avocado, raw',
        servingSize: { quantity: 100, unit: 'g' },
        nutrients: {
            energy: { kcal: 160 },
            macros: { protein: { g: 2 }, carbs: { g: 9 }, fat: { g: 15 } },
            fiber: { g: 7 },
            sodium: { mg: 7 }
        },
        category: 'Fruit',
        source: { type: 'seed' }
    },
    {
        name: 'Almonds',
        servingSize: { quantity: 28, unit: 'g' },
        nutrients: {
            energy: { kcal: 164 },
            macros: { protein: { g: 6 }, carbs: { g: 6 }, fat: { g: 14 } },
            fiber: { g: 3.5 },
            sodium: { mg: 0 }
        },
        category: 'Nuts',
        source: { type: 'seed' }
    },
    {
        name: 'Greek yogurt, plain',
        servingSize: { quantity: 100, unit: 'g' },
        nutrients: {
            energy: { kcal: 59 },
            macros: { protein: { g: 10 }, carbs: { g: 3.3 }, fat: { g: 0.4 } },
            fiber: { g: 0 },
            sodium: { mg: 75 }
        },
        category: 'Dairy',
        source: { type: 'seed' }
    },
    {
        name: 'Olive oil',
        servingSize: { quantity: 14, unit: 'g' },
        nutrients: {
            energy: { kcal: 119 },
            macros: { protein: { g: 0 }, carbs: { g: 0 }, fat: { g: 13.5 } },
            fiber: { g: 0 },
            sodium: { mg: 0 }
        },
        category: 'Oil',
        source: { type: 'seed' }
    },
    {
        name: 'Pasta, cooked',
        servingSize: { quantity: 100, unit: 'g' },
        nutrients: {
            energy: { kcal: 131 },
            macros: { protein: { g: 5 }, carbs: { g: 25 }, fat: { g: 1.1 } },
            fiber: { g: 1.8 },
            sodium: { mg: 1 }
        },
        category: 'Grain',
        source: { type: 'seed' }
    },
    {
        name: 'Ground beef, 90% lean',
        servingSize: { quantity: 100, unit: 'g' },
        nutrients: {
            energy: { kcal: 180 },
            macros: { protein: { g: 24 }, carbs: { g: 0 }, fat: { g: 9 } },
            fiber: { g: 0 },
            sodium: { mg: 75 }
        },
        category: 'Protein',
        source: { type: 'seed' }
    },
    {
        name: 'Tofu, firm',
        servingSize: { quantity: 100, unit: 'g' },
        nutrients: {
            energy: { kcal: 144 },
            macros: { protein: { g: 17 }, carbs: { g: 2.2 }, fat: { g: 8 } },
            fiber: { g: 1.2 },
            sodium: { mg: 7 }
        },
        category: 'Protein',
        source: { type: 'seed' }
    },
    {
        name: 'Black beans, cooked',
        servingSize: { quantity: 100, unit: 'g' },
        nutrients: {
            energy: { kcal: 84 },
            macros: { protein: { g: 5.8 }, carbs: { g: 15 }, fat: { g: 0.3 } },
            fiber: { g: 3.7 },
            sodium: { mg: 3 }
        },
        category: 'Legume',
        source: { type: 'seed' }
    },
    {
        name: 'Peanut butter',
        servingSize: { quantity: 32, unit: 'g' },
        nutrients: {
            energy: { kcal: 188 },
            macros: { protein: { g: 8 }, carbs: { g: 7 }, fat: { g: 16 } },
            fiber: { g: 1.6 },
            sodium: { mg: 170 }
        },
        category: 'Nuts',
        source: { type: 'seed' }
    },
    {
        name: 'Cheese, cheddar',
        servingSize: { quantity: 28, unit: 'g' },
        nutrients: {
            energy: { kcal: 113 },
            macros: { protein: { g: 7 }, carbs: { g: 0.4 }, fat: { g: 9.4 } },
            fiber: { g: 0 },
            sodium: { mg: 176 }
        },
        category: 'Dairy',
        source: { type: 'seed' }
    },
    {
        name: 'Spinach, raw',
        servingSize: { quantity: 30, unit: 'g' },
        nutrients: {
            energy: { kcal: 7 },
            macros: { protein: { g: 0.9 }, carbs: { g: 1.1 }, fat: { g: 0.1 } },
            fiber: { g: 0.7 },
            sodium: { mg: 24 }
        },
        category: 'Vegetable',
        source: { type: 'seed' }
    },
    {
        name: 'Orange, medium',
        servingSize: { quantity: 1, unit: 'medium' },
        nutrients: {
            energy: { kcal: 62 },
            macros: { protein: { g: 1.2 }, carbs: { g: 15 }, fat: { g: 0.3 } },
            fiber: { g: 3.1 },
            sodium: { mg: 0 }
        },
        category: 'Fruit',
        source: { type: 'seed' }
    },
    {
        name: 'Honey',
        servingSize: { quantity: 21, unit: 'g' },
        nutrients: {
            energy: { kcal: 64 },
            macros: { protein: { g: 0.1 }, carbs: { g: 17 }, fat: { g: 0 } },
            fiber: { g: 0.1 },
            sodium: { mg: 1 }
        },
        category: 'Sweetener',
        source: { type: 'seed' }
    },
    {
        name: 'Butter',
        servingSize: { quantity: 14, unit: 'g' },
        nutrients: {
            energy: { kcal: 102 },
            macros: { protein: { g: 0.1 }, carbs: { g: 0.1 }, fat: { g: 11.5 } },
            fiber: { g: 0 },
            sodium: { mg: 91 }
        },
        category: 'Oil',
        source: { type: 'seed' }
    },
    {
        name: 'Coffee, black',
        servingSize: { quantity: 240, unit: 'ml' },
        nutrients: {
            energy: { kcal: 2 },
            macros: { protein: { g: 0.3 }, carbs: { g: 0 }, fat: { g: 0 } },
            fiber: { g: 0 },
            sodium: { mg: 5 }
        },
        category: 'Beverage',
        source: { type: 'seed' }
    },
    {
        name: 'Tomato, raw',
        servingSize: { quantity: 100, unit: 'g' },
        nutrients: {
            energy: { kcal: 18 },
            macros: { protein: { g: 0.9 }, carbs: { g: 3.9 }, fat: { g: 0.2 } },
            fiber: { g: 1.2 },
            sodium: { mg: 5 }
        },
        category: 'Vegetable',
        source: { type: 'seed' }
    },
    {
        name: 'Carrot, raw',
        servingSize: { quantity: 100, unit: 'g' },
        nutrients: {
            energy: { kcal: 41 },
            macros: { protein: { g: 0.9 }, carbs: { g: 10 }, fat: { g: 0.2 } },
            fiber: { g: 2.8 },
            sodium: { mg: 69 }
        },
        category: 'Vegetable',
        source: { type: 'seed' }
    },
    {
        name: 'Lentils, cooked',
        servingSize: { quantity: 100, unit: 'g' },
        nutrients: {
            energy: { kcal: 116 },
            macros: { protein: { g: 9 }, carbs: { g: 20 }, fat: { g: 0.4 } },
            fiber: { g: 3.2 },
            sodium: { mg: 4 }
        },
        category: 'Legume',
        source: { type: 'seed' }
    },
    {
        name: 'Quinoa, cooked',
        servingSize: { quantity: 100, unit: 'g' },
        nutrients: {
            energy: { kcal: 120 },
            macros: { protein: { g: 4.4 }, carbs: { g: 21 }, fat: { g: 1.9 } },
            fiber: { g: 2.8 },
            sodium: { mg: 7 }
        },
        category: 'Grain',
        source: { type: 'seed' }
    }
];
