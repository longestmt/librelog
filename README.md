# LibreLog

A privacy-first, open-source meal tracking and calorie counting app. Part of the **Libre Suite** alongside [LibreLift](https://github.com/longestmt/librelift).

**No accounts. No subscriptions. No data harvesting. Your nutrition data stays on your device.**

## Features

### Core Tracking
- **Food search** — Open Food Facts + USDA FoodData Central databases
- **Barcode scanning** — Camera-based or manual entry via QuaggaJS
- **Daily diary** — Meals grouped by Breakfast, Lunch, Dinner, Snacks
- **Nutrition summary** — Calories, protein, carbs, fat, fiber, sodium
- **Calorie ring** — Visual progress toward daily goals
- **Daily notes** — Free-text notes per day

### AI-Assisted Logging (Optional, BYOK)
- **Photo analysis** — Take a photo, AI identifies foods and estimates portions
- **Voice logging** — Describe your meal naturally, AI parses into structured entries
- **Text description** — Type what you ate, AI extracts food items
- **Multi-provider** — OpenAI, Anthropic, or local Ollama
- **Cost tracking** — Monthly usage and estimated spend in settings

### Recipes & Templates
- **Recipe builder** — Combine foods with per-serving nutrition
- **Meal templates** — Save and load typical day meals
- **Day copy** — Clone meals from any previous day

### Weight Tracking
- **Daily logging** — Weight, body fat %, kg/lb
- **Trend chart** — Visual weight history with min/max highlights
- **Statistics** — Current, starting, change, average
- **CSV export** — Download weight history

### Data & Privacy
- **Offline-first** — Works without internet via service worker
- **Local storage** — All data in IndexedDB, never sent to servers
- **Auto-backup** — Every 6 hours to filesystem or localStorage
- **JSON export/import** — Full data portability
- **MyFitnessPal import** — CSV migration from MFP
- **WebDAV sync** — Optional self-hosted sync (Nextcloud, etc.)

### Design
- **3 themes** — Compline (dark), Lauds (light), Vigil (AMOLED)
- **WCAG 2.1 AA** — Screen reader support, keyboard navigation, skip links
- **Responsive** — Mobile-first with desktop sidebar layout
- **PWA** — Installable, works offline

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | Vanilla JavaScript (ES modules) |
| Build | Vite 6 |
| Mobile | Capacitor 8 |
| Storage | IndexedDB |
| PWA | vite-plugin-pwa (Workbox) |
| Barcode | QuaggaJS (quagga2) |
| License | AGPL-3.0-or-later |

## Getting Started

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## AI Setup (Optional)

LibreLog works fully without AI. To enable photo/voice/text food logging:

1. Go to **Settings → AI Features**
2. Select a provider (OpenAI, Anthropic, or Ollama)
3. Enter your API key
4. Photo, Voice, and AI Text tabs appear in the search page

Keys are stored locally on your device. Estimated cost: $0.01–0.03 per analysis.

## Project Structure

```
src/
├── app.js                 # SPA router & shell
├── pages/                 # Route pages
│   ├── diary.js           # Daily food diary
│   ├── search.js          # Unified search (text/scan/photo/voice/AI)
│   ├── insights.js        # Statistics & progress
│   ├── weight.js          # Weight tracking
│   ├── recipes.js         # Recipe builder
│   └── settings.js        # Preferences & integrations
├── components/            # UI components (modal, toast)
├── data/                  # IndexedDB, backup, import/export
├── engine/                # Nutrition calc, food search, goals
├── integrations/          # OFF, USDA, AI client, image/voice
├── utils/                 # Units, formatting, sanitization
└── styles/                # CSS themes & components
```

## License

[AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.html)

Free software — you are free to use, study, share, and improve it.
