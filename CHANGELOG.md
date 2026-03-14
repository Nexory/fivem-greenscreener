# Changelog

All notable changes compared to the [original fivem-greenscreener](https://github.com/Bentix-cs/fivem-greenscreener) (v1.6.5) are documented here.

## [2.0.0] - 2026-03-14

### Image Quality
- **Smart chroma key algorithm** with 3-tier sensitivity (`soft`, `medium`, `hard`) — the original used a simple `green > red + blue` check that would remove yellow-green clothing items. The new algorithm uses separate thresholds for green difference, max red, and min green values, preserving items with yellow-green tones while still cleanly removing the greenscreen background.
- **Proper 1:1 square centering** — after cropping to content, images are centered on a square transparent canvas before resizing. The original would sometimes produce off-center or stretched results.
- **Alpha threshold filtering** (128) during content detection to ignore semi-transparent noise/artifacts at image edges.

### Reliability
- **Server-confirmed screenshot flow** — screenshots now use a `screenshotDone` event from the server with a timeout-backed promise (800ms), replacing the original's fixed 600ms `Delay()` which could fail on slower systems or with larger images.
- **Preload timeout** (5 seconds) — if a clothing/prop variation fails to preload, it's gracefully skipped with a warning instead of hanging indefinitely.
- **Failed items tracking** — each category run tracks failed items and prints a summary at the end (successful count, failed count, skipped count, and which items failed).
- **Error recovery** — if an item crashes, the ped components are reset and processing continues with the next item instead of aborting the entire run.
- **Batch pauses** — automatically pauses for 2 seconds every 100 items to prevent GTA engine stress and memory issues.

### Performance
- **Client-side file skip** — pre-fetches existing filenames from the server before starting. When `overwriteExistingImages` is `false`, items are skipped on the client side without even taking a screenshot, massively speeding up resumed sessions.
- **Progress logging** — logs progress every 50 items with elapsed time and processing rate (items/sec).
- **Resumable sessions** — set `overwriteExistingImages` to `false` in config to resume where you left off after a crash or restart.

### Camera System
- **Per-category ped overrides** (`categoryOverrides`) — each clothing category can have custom ped position (Y), rotation (X/Z), and extra rotation. Pre-configured for torso (side view), shoes (angled), bags (back view), watches (arm close-up), bracelets, and more.
- **Ear side detection** — automatically detects `(L)` and `(R)` in earring labels and rotates the ped to show the correct ear.
- **Runtime adjustment commands**:
  - `/gs_set <category> <property> <value>` — adjust zPos, fov, pedY, pedRotX, basePedZ, extraRot on the fly
  - `/gs_show [category]` — display current camera settings and overrides
- **Smart camera recreation** — the camera is only rebuilt when settings actually change (zPos, fov, rotation, ear side), not on every single item.

### Usability
- **Category filter argument** — `/screenshot [category]` now accepts an optional category name (e.g., `/screenshot torso`, `/screenshot mask`). Auto-prefixes `clothing_` if not provided.
- **Real-time position adjustment** — during capture, use WASD to move the ped, Q/E for height, and Arrow keys for rotation. Press V to print current settings to console.
- **Auto-spawn** — automatically triggers spawnmanager on resource start to clear txAdmin's "Awaiting scripts" warning.
- **Clean screenshots** — hides txAdmin overlays, chat, HUD components, player blips, loading screens, and text renderers for artifact-free captures.
- **Full idle animation suppression** — disables ambient, gesture, and viseme animations, plus ped config flag 292 and `TaskStandStill` to prevent any ped movement during screenshots.

### Weather & Environment
- **Thorough weather control** — disables network weather sync (`SetWeatherOwnedByNetwork`), clears all weather effects, overrides to EXTRASUNNY, and freezes game time at noon.
- **Environment cleanup** — removes particle effects, projectiles, cops, and clears the area in a 500-unit radius (important for airport locations with debris).
- **Visual effect cleanup** — clears timecycle modifiers and disables artificial lights state changes for consistent lighting.

### Code Quality
- **Self-documenting config** — `config.json` includes JSON comments (`//__comment__//` keys) explaining each setting.
- **Proper resource cleanup** — `onResourceStop` handler restores weather, deletes greenscreen object, re-enables HUD/radar, unfreezes player, and clears intervals.
- **Greenscreen object management** — properly tracks and deletes the greenscreen prop, preventing duplicates on resource restart.

### New Commands
| Command | Description |
|---------|-------------|
| `/screenshot [category]` | Screenshot all items, optionally filtered by category |
| `/customscreenshot <comp> <drawable/all> <CLOTHING\|PROPS> <male\|female\|both>` | Custom targeted screenshots |
| `/screenshotobject <hash>` | Screenshot objects/weapons |
| `/screenshotvehicle <model\|all> [primary] [secondary]` | Screenshot vehicles |
| `/gs_set <category> <property> <value>` | Adjust camera/ped settings at runtime |
| `/gs_show [category]` | Show current settings and overrides |

### Configuration
New config options (see `config.json` for full documentation):

| Option | Default | Description |
|--------|---------|-------------|
| `chromaSensitivity` | `"soft"` | Greenscreen removal aggressiveness: `soft`, `medium`, `hard` |
| `overwriteExistingImages` | `true` | Set to `false` for resumable sessions |
| `useDatabaseItems` | `false` | Set to `true` to use `clothing_items.json` item list |
| `includeTextures` | `true` | Capture all texture variations per drawable |
| `imageSize` | `150` | Output image size in pixels (square) |
