- NEVER write unit tests after you write code.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work. At the end of E2E tests, produce a verifiable and repeatable artifact.
- If you must test a system in isolation, FIRST write all the ways it could fail, THEN write the code.

# Repository Guidelines

## Project Structure & Module Organization

Nen is a Windows desktop anime player. `src/` holds the renderer UI, styles, and shared types. `electron/` holds the main process, preload bridge, playback, providers, and data rules. `service/together/` holds the separate Watch Together WebSocket server and its Docker files. `scripts/` holds development, build, and media setup scripts. Put icons and other static assets in `public/`. Build output goes to `dist/`, `dist-electron/`, and `test-builds/`; do not edit these files by hand.

## Build, Test, and Development Commands

Use Node.js 22.12 or later on Windows x64. CI uses Node.js 24.

- `npm ci`: install the locked dependencies.
- `npm run setup:media`: download and check the mpv and FFmpeg tools in `vendor/`. Run this before the first build or development session.
- `npm run dev`: build the Electron code, start Vite, and open the app.
- `npm run build`: check TypeScript, build the renderer, and bundle Electron code.
- `npm run package`: make an unpacked app in `test-builds/`.
- `npm run release`: make a Windows installer in `test-builds/`.
- `cd service/together; npm ci; npm start`: run the separate Watch Together server.

## Coding Style & Naming Conventions

Use TypeScript for app code and ES modules for scripts and the service. Follow the existing two-space indent, double quotes, semicolons, and trailing commas in TypeScript files. Use `camelCase` for variables and functions, `PascalCase` for types and classes, and lowercase hyphenated file names, such as `watch-data.ts`. Keep renderer code in `src/` and privileged Electron work in `electron/`; expose only needed operations through the preload bridge. The project has no configured formatter or linter. Run `npm run build` to check types and bundling.

## Testing Guidelines

There is no committed test suite or `npm test` command, and no stated coverage target. Run `npm run build` for each change. For UI or playback changes, also check the affected flow with `npm run dev`. If you add tests, use clear names such as `rules.test.mjs` and state how to run them in the pull request.

## Commit & Pull Request Guidelines

Recent commits use short, imperative summaries, such as `Fix playback and updates`; some include a pull request number. Use a summary that names the change. In each pull request, describe the behavior, list the checks you ran, link a related issue when one exists, and add screenshots for visible UI changes. Do not commit generated output, downloaded media tools, secrets, or `.env` files.
