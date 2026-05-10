# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

Open `index.html` directly in any modern browser. No build step, no dependencies, no server required.

## Architecture

Single-page vanilla JS app — three files, no frameworks:

- `index.html` — markup only; all IDs referenced from JS
- `styles.css` — all styling, including responsive breakpoints and print styles
- `app.js` — all logic (one script tag, no modules)

**State** lives in a single `state` object at the top of `app.js`. Persistence is `localStorage` under the key `seat_randomiser_classes_v1`. Saved classes are an array of `{ id, name, students: string[], locks: {} }` objects.

**Classroom layout** is defined by the `TABLES` constant — 6 tables with fixed seat numbers and CSS grid positions (`data-pos` on each `.table` div). The seating algorithm (`planAssignment` + `randomise`) fills tables front-to-back, forces tables with locked seats to be used, and tries to keep every used table at ≥ 3 students.

**Three tabs** share the same state but render independently:
- *Seating* — `randomise()` + `renderSeating()`, undo/redo via `seatingPast`/`seatingFuture` stacks
- *Groups* — `makeGroups()` + `renderGroups()`, same undo/redo pattern
- *Cold call* — `pickStudent()` + `renderColdCall()`, tracks picked set for no-repeats mode

**Locks** map `seatNumber (string) → studentName` in `state.locks`. Each student can only be locked to one seat at a time; `applyLock` enforces this.

**Rendering pattern**: every render function reads from `state` and rewrites the relevant DOM subtree. There is no virtual DOM or diffing — just direct innerHTML/class manipulation. `escapeHtml` must be used whenever inserting user-supplied names into innerHTML.
