# Macro Tracker - Refactoring & Improvement Plan

This document outlines a roadmap for improving and scaling the Macro Tracker PWA, transitioning it from a single-file prototype into a robust, maintainable, and visually premium application.

## 1. Architecture & Code Organization
The current app lives in a single `1200+` line `index.html` file. The first step is to modularize the codebase for better maintainability.

* **Split Files (ES Modules):** Break the logic into smaller, focused modules.
  * `ui.js`: DOM manipulation and rendering logic.
  * `core.js`: Core math and deterministic functions (`computeEntry`, `solveFridge`).
  * `storage.js`: Local storage and persistence logic.
  * `api.js`: External API handlers (USDA and Gemini).
  * `style.css`: Move all inline styles to a dedicated stylesheet.
* **Adopt a Framework (Recommended):** Evaluate migrating the vanilla DOM manipulation to a modern web framework like **React, Vue, or Svelte** using **Vite**. This provides robust state management (eliminating manual `render()` calls) and component reusability.

## 2. Data Storage & Reliability
The app currently relies on `localStorage`, which is synchronous, has size limits, and can be evicted by the browser unpredictably.

* **Migrate to IndexedDB:** Use a lightweight wrapper (like `idb`) to transition from `localStorage` to `IndexedDB`. This will provide asynchronous, non-blocking storage with much higher capacity and persistence reliability.
* **Cloud Sync (Future Phase):** Implement a backend solution (e.g., Firebase, Supabase) to seamlessly sync user ledgers across devices, eliminating the need for manual JSON imports/exports.

## 3. Aesthetics & UI / UX ("The Wow Factor")
The current design is highly functional but can be elevated to feel like a premium product.

* **Design System & Typography:** Upgrade from the basic dark mode to a premium aesthetic. Incorporate modern sans-serif fonts (like Inter or Outfit), refined color palettes, and subtle glassmorphism on panels.
* **Micro-animations:** 
  * Add smooth CSS transitions for elements entering the DOM (e.g., when a new food item is logged).
  * Implement loading spinners or skeleton loaders during network requests (USDA/Gemini).
  * Add polished toast notification animations.
* **Data Visualization:** Replace the text-based `<details>` history view with charts. Integrate a library like Chart.js or Recharts to visualize the caloric corridor and macro adherence over time (weekly/monthly).

## 4. Security & API Management
Currently, API keys for USDA and Gemini are stored directly on the client side.

* **Backend Proxy:** To release the app broadly without requiring users to supply their own API keys, set up a serverless backend proxy (e.g., Vercel Functions, Cloudflare Workers). The frontend will call this proxy, which securely holds the keys and communicates with the external APIs.

## 5. Testing & Developer Experience
Ensure the deterministic core remains accurate as the app scales.

* **Unit Testing:** Implement a testing framework (like **Vitest** or **Jest**).
* **Test Coverage:** Write comprehensive tests for critical math functions, particularly `solveFridge()` and `computeEntry()`, to guarantee that the macro math and caloric targets remain 100% accurate across updates.
* **Build Tooling:** If migrating to a framework, integrate a bundler (Vite/Webpack) to minify assets, handle CSS pre-processing, and properly generate the PWA manifest and service workers.
