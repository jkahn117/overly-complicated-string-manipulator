# Frontend Plan: Pipeline Builder UI

## Overview

Build a single-page pipeline builder UI using **Astro** (static output) + **Alpine.js** (interactivity) + **Tailwind v4** (styling). The site is served as static assets from the existing dispatch worker using Wrangler's `assets` configuration. The UI allows users to:

1. Enter input text
2. Build a pipeline of built-in transformation steps
3. Execute the pipeline against the worker API
4. View the output and step-by-step history

---

## Architecture

### How it fits into the existing project

```
wfp-dynamics-with-analytics/
├── src/                     # Existing worker code (unchanged)
│   ├── index.ts
│   ├── types.ts
│   ├── middleware.ts
│   ├── codegen.ts
│   ├── proxy.ts
│   └── routes/admin.ts
├── web/                     # NEW: Astro frontend source
│   ├── astro.config.mjs
│   ├── tsconfig.json
│   ├── src/
│   │   ├── layouts/
│   │   │   └── Base.astro
│   │   ├── pages/
│   │   │   └── index.astro
│   │   ├── components/
│   │   │   ├── Header.astro
│   │   │   ├── InputField.astro
│   │   │   ├── Arrow.astro
│   │   │   ├── PipelineEditor.astro
│   │   │   ├── StepCard.astro
│   │   │   └── OutputPanel.astro
│   │   └── scripts/
│   │       └── pipeline.ts    # Alpine.js store + API client
│   └── public/
│       └── favicon.svg
├── dist/                    # Astro build output (gitignored)
├── wrangler.jsonc           # Updated with assets config
└── package.json             # Updated with web scripts
```

### Routing strategy

The worker currently uses:
- `POST /` — pipeline execution (requires `x-tenant-id` header)
- `PUT /pipeline` — update pipeline config
- `POST /admin/tenants` — create tenant

All API routes are **POST/PUT only**. The frontend serves on **GET** requests. Default Wrangler asset routing handles this perfectly — static assets are served first for paths that match files, and unmatched requests fall through to the worker. No `run_worker_first` needed since the HTTP methods don't overlap.

We add a `run_worker_first` pattern for `POST /` to be explicit, since the asset routing might try to serve `index.html` for `/`:

```jsonc
"assets": {
  "directory": "./dist",
  "binding": "ASSETS",
  "run_worker_first": ["POST:/*", "PUT:/*"]
}
```

Actually, Wrangler's `run_worker_first` only supports path patterns, not method patterns. But this doesn't matter — the default behavior is: if a static asset matches the request path, serve it; otherwise, fall through to the worker. Since `POST /` won't match any static file, the worker handles it. The only potential conflict is `GET /` which should serve `index.html`. Let's verify the default behavior handles this:

- `GET /` → Wrangler finds `dist/index.html` → serves static asset ✓
- `POST /` → Wrangler finds no asset match for POST → falls through to worker ✓
- `PUT /pipeline` → no asset match → falls through to worker ✓
- `POST /admin/tenants` → no asset match → falls through to worker ✓

**Default asset-first routing works perfectly. No special config needed.**

### Wrangler config changes

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "wfp-dynamics-with-analytics",
  "main": "src/index.ts",
  "compatibility_date": "2026-02-27",
  "observability": { "enabled": true },
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS"
  },
  // ... existing bindings unchanged
}
```

### Build pipeline

1. `pnpm --filter web build` → Astro builds to `./dist/` (project root, not `web/dist/`)
2. `wrangler deploy` → uploads worker code + `./dist/` assets together

For local dev, two terminals:
- `pnpm --filter web dev` — Astro dev server on port 4321 (proxies API to wrangler)
- `pnpm dev` — Wrangler dev on port 8787

Or a single command using `concurrently` for convenience.

---

## Page Layout

Single page, vertical flow:

```
┌─────────────────────────────────────────────┐
│  Header: "Pipeline Builder"                 │
│  Subtitle: "WFP Dynamics"                   │
├─────────────────────────────────────────────┤
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │  Input Text                         │    │
│  │  (large textarea, monospace font)   │    │
│  │                                     │    │
│  └─────────────────────────────────────┘    │
│                                             │
│              ↓  (arrow)                     │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │  Pipeline Editor                    │    │
│  │  ┌───────────────────────────────┐  │    │
│  │  │ Step 1: uppercase         [✕] │  │    │
│  │  ├───────────────────────────────┤  │    │
│  │  │ Step 2: replace           [✕] │  │    │
│  │  │   find: [___] replace: [___]  │  │    │
│  │  ├───────────────────────────────┤  │    │
│  │  │ Step 3: prefix            [✕] │  │    │
│  │  │   value: [___]                │  │    │
│  │  └───────────────────────────────┘  │    │
│  │                                     │    │
│  │  [ + Add Step ▾ ]                   │    │
│  └─────────────────────────────────────┘    │
│                                             │
│              ↓  (arrow)                     │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │  Output                             │    │
│  │  (result display, monospace)        │    │
│  │                                     │    │
│  │  History:                           │    │
│  │  Step 0: uppercase                  │    │
│  │    "hello" → "HELLO"               │    │
│  │  Step 1: prefix                     │    │
│  │    "HELLO" → ">>HELLO"             │    │
│  └─────────────────────────────────────┘    │
│                                             │
│         [ ▶ Run Pipeline ]                  │
│                                             │
└─────────────────────────────────────────────┘
```

---

## Components

### 1. `Base.astro` — Layout

- Sets up HTML boilerplate, Tailwind v4 import, Alpine.js script
- Dark/light theme support via Tailwind (start with light)
- Centered content with max-width container

### 2. `Header.astro`

- Title: "Pipeline Builder"
- Subtitle: "WFP Dynamics with Analytics"
- Clean, minimal design

### 3. `InputField.astro`

- Large `<textarea>` bound to Alpine state `$store.pipeline.input`
- Monospace font, placeholder text: "Enter your input text..."
- Auto-resize or fixed height (~6 rows)

### 4. `Arrow.astro`

- SVG down-arrow, centered
- Styled with Tailwind (gray, subtle)
- Reusable between sections

### 5. `PipelineEditor.astro`

Contains the step list and "Add Step" button.

- Renders list of `StepCard` components via Alpine `x-for`
- "Add Step" button opens a dropdown of available operations:
  - `uppercase` — no config
  - `lowercase` — no config
  - `trim` — no config
  - `replace` — config: `find`, `replace`
  - `prefix` — config: `value`
  - `suffix` — config: `value`
- Steps are rendered in order with step numbers
- Empty state: "No steps added. Click 'Add Step' to begin."

### 6. `StepCard.astro`

Rendered for each step in the pipeline.

- Shows step number, operation name, remove button (��)
- For ops with config (`replace`, `prefix`, `suffix`): inline text inputs
- Compact card design with border

### 7. `OutputPanel.astro`

- Shows final `data` result in a highlighted box
- Shows step-by-step `history` as a vertical list
  - Each entry: step number, op name, `"input" → "output"`
- Loading state while request is in flight
- Error state showing error message + partial history
- Empty state: "Run the pipeline to see results"

### 8. Run Button

- Fixed or inline "Run Pipeline" button
- Calls `POST /` with the input text and current pipeline steps
- Disabled when no steps or no input
- Shows loading spinner during execution

---

## Alpine.js Store (`pipeline.ts`)

```ts
// Conceptual structure — not final code

interface Step {
  id: string;          // unique ID for x-for :key
  type: "builtin";
  op: BuiltinOp;
  config: Record<string, string>;
}

interface PipelineStore {
  // State
  input: string;
  steps: Step[];
  output: null | { data: string; history: HistoryEntry[] };
  error: null | { message: string; step: number; history: HistoryEntry[] };
  loading: boolean;
  showAddMenu: boolean;
  tenantId: string;      // configurable, default "demo"

  // Actions
  addStep(op: BuiltinOp): void;
  removeStep(id: string): void;
  moveStep(fromIndex: number, toIndex: number): void;
  updateStepConfig(id: string, key: string, value: string): void;
  run(): Promise<void>;

  // Computed
  get canRun(): boolean;
  get stepsPayload(): FlowDefinition;
}
```

### API integration

The `run()` method needs to:

1. First, ensure the tenant exists and has the current pipeline saved:
   - `PUT /pipeline` with the steps (requires `x-tenant-id` header)
2. Then execute:
   - `POST /` with the input text (requires `x-tenant-id` header)

For the demo/playground flow, we need a pre-existing tenant. Two options:

**Decision: Option A** ��� Pre-seed a "playground" tenant via the admin API. Hardcode its ID in the frontend. This is a demo app — no tenant management in the frontend.

### Execution flow

```ts
async function run() {
  this.loading = true;
  this.error = null;
  this.output = null;

  try {
    const tenantId = await ensureTenant();

    // Save current pipeline
    await fetch("/pipeline", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-tenant-id": tenantId,
      },
      body: JSON.stringify({ pipeline: this.stepsPayload }),
    });

    // Execute pipeline
    const res = await fetch("/", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "x-tenant-id": tenantId,
      },
      body: this.input,
    });

    const result = await res.json();
    if (res.ok) {
      this.output = result;
    } else {
      this.error = result;
    }
  } catch (e) {
    this.error = { message: e.message, step: -1, history: [] };
  } finally {
    this.loading = false;
  }
}
```

---

## Tech Stack Details

### Astro

- **Output mode**: `static` (pre-rendered, no SSR needed)
- **Build output**: `../dist/` (relative to `web/`, which is `./dist/` from project root)
- No Cloudflare adapter needed (pure static)
- Alpine.js loaded via `<script>` tag (CDN or bundled)

### Alpine.js

- Loaded from CDN: `https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js`
- Or installed via npm and bundled by Astro
- `Alpine.store('pipeline', { ... })` for global state
- `x-data`, `x-for`, `x-show`, `x-on`, `x-bind` for UI binding

### Tailwind v4

- Installed as Astro integration (`@astrojs/tailwind` or direct Tailwind v4 + Vite plugin)
- Tailwind v4 uses CSS-first configuration (no `tailwind.config.js`)
- Import via `@import "tailwindcss"` in a global CSS file
- Design tokens via `@theme` directive

---

## Implementation Steps

### Phase 1: Project scaffolding

1. Create `web/` directory with Astro project
2. Install dependencies: `astro`, `alpinejs`, `@tailwindcss/vite`
3. Configure Astro:
   - Static output
   - Build output to `../dist/`
   - Tailwind v4 via Vite plugin
4. Update root `package.json`:
   - Add workspace config or scripts that delegate to `web/`
   - Add `build:web`, `dev:web` scripts
5. Update `wrangler.jsonc`:
   - Add `assets` config pointing to `./dist`
6. Add `dist/` to `.gitignore`
7. Update `worker-configuration.d.ts` (run `wrangler types`)

### Phase 2: Layout and static components

8. Create `Base.astro` layout (HTML shell, Alpine.js + Tailwind setup)
9. Create `Header.astro`
10. Create `Arrow.astro` (reusable SVG down-arrow)
11. Create `InputField.astro` (textarea)
12. Create `PipelineEditor.astro` (step list + add button)
13. Create `StepCard.astro` (individual step display)
14. Create `OutputPanel.astro` (result + history display)
15. Wire up `index.astro` page with all components

### Phase 3: Alpine.js interactivity

16. Create `pipeline.ts` with Alpine store definition
17. Implement `addStep()` — opens dropdown, adds step to list
18. Implement `removeStep()` — removes step by ID
19. Implement `updateStepConfig()` — updates config fields for replace/prefix/suffix
20. Implement step rendering with config forms
21. Implement empty states and validation

### Phase 4: API integration

22. Implement `ensureTenant()` — tenant bootstrapping via admin API
23. Implement `run()` — PUT pipeline + POST execute
24. Wire up "Run Pipeline" button
25. Implement loading, success, and error states in OutputPanel
26. Test end-to-end with `wrangler dev`

### Phase 5: Polish

27. Add responsive design (mobile-friendly)
28. Add keyboard shortcuts (Ctrl+Enter to run)
29. Add step reordering (move up/move down buttons)
30. Add "copy output" button
31. Test build + deploy flow

---

## Open Questions

1. **Dev server proxy**: During local dev, Astro runs on :4321 and Wrangler on :8787. We'll need Astro's dev server to proxy API calls to Wrangler. Astro doesn't have built-in proxy support, but we can use a Vite plugin or just run everything through Wrangler's dev server (build Astro first, then `wrangler dev` serves both).

   **Recommended approach**: Use `wrangler dev` as the single dev server. Run `astro build --watch` in one terminal and `wrangler dev` in another. Wrangler serves both the built assets and the API. This matches production behavior exactly.

2. **Tenant ID management**: The hybrid approach (auto-create tenant) means the admin API must be accessible without auth. This is already the case (admin routes skip tenant middleware). For a production app, you'd want auth on admin routes.

3. **Workspace vs scripts**: Since both the worker and the frontend share a single Wrangler deploy, we don't need a true monorepo workspace. Simple npm scripts that build the frontend before deploying are sufficient. But if we want isolated `node_modules` for the frontend (Astro + Alpine + Tailwind), a pnpm workspace is cleaner.

   **Recommended**: Use a pnpm workspace with `web/` as a separate package. Root `package.json` gets a `build` script that builds the frontend, and `deploy` chains `build` + `wrangler deploy`.

---

## Package Changes

### Root `package.json` updates

```json
{
  "scripts": {
    "build:web": "pnpm --filter web build",
    "dev:web": "pnpm --filter web build --watch",
    "dev": "wrangler dev",
    "dev:all": "concurrently \"pnpm dev:web\" \"pnpm dev\"",
    "deploy": "pnpm build:web && wrangler deploy",
    "test": "vitest",
    "cf-typegen": "wrangler types"
  }
}
```

### `pnpm-workspace.yaml`

```yaml
packages:
  - "web"
```

### `web/package.json`

```json
{
  "name": "web",
  "private": true,
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview"
  },
  "dependencies": {
    "astro": "^5.x",
    "alpinejs": "^3.x",
    "@types/alpinejs": "^3.x"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.x",
    "tailwindcss": "^4.x"
  }
}
```

---

## Design Tokens (Tailwind v4)

```css
/* web/src/styles/global.css */
@import "tailwindcss";

@theme {
  --color-surface: #ffffff;
  --color-surface-alt: #f8fafc;
  --color-border: #e2e8f0;
  --color-text: #0f172a;
  --color-text-muted: #64748b;
  --color-primary: #3b82f6;
  --color-primary-hover: #2563eb;
  --color-danger: #ef4444;
  --color-success: #22c55e;
  --font-mono: "JetBrains Mono", "Fira Code", ui-monospace, monospace;
}
```
