# fivem-greenscreener

A FiveM resource that automatically captures screenshots of every GTA clothing item, prop, object, and vehicle against a greenscreen — then removes the background and saves clean, transparent 1:1 PNG images ready for your UI.

> **Fork of [Bentix-cs/fivem-greenscreener](https://github.com/Bentix-cs/fivem-greenscreener)** with major improvements to image quality, reliability, performance, and usability. See [CHANGELOG.md](CHANGELOG.md) for full details.

## Key Features

- Screenshot **every** GTA clothing item, prop, object, and vehicle (including addons)
- **Smart chroma key** with 3 sensitivity levels — preserves yellow-green items the original would remove
- **1:1 square output** with centered content and transparent background
- **Resumable sessions** — skip already-captured items on restart
- **Server-confirmed screenshots** — no more missed or corrupt captures
- **Per-category camera presets** — optimized angles for each clothing type
- **Runtime adjustment** — tune camera position and rotation live without restarting
- **Batch processing** with progress logging, error recovery, and automatic pauses
- **Clean captures** — hides all HUD, chat, overlays, and suppresses ped animations
- Customizable camera positions through `config.json`
- Automatic greenscreen removal (based on work by [@hakanesnn](https://github.com/hakanesnn))
- Large greenscreen box (thanks to [@jimgordon20](https://github.com/jimgordon20/jim_g_green_screen))

## Installation

1. Clone the repository into your resources folder
2. Make sure [screenshot-basic](https://github.com/citizenfx/screenshot-basic) is installed
3. Add `ensure greenscreener` to your server.cfg (after `screenshot-basic`)
4. Start the resource and use `/screenshot` to begin

**Do not use a subfolder like `resources/[scripts]` as it will cause the script to malfunction.**

## Dependencies

- [screenshot-basic](https://github.com/citizenfx/screenshot-basic)
- yarn

## Commands

### `/screenshot [category]`

Capture screenshots of all clothing items. Optionally filter by category.

```
/screenshot              — all categories, male + female
/screenshot torso        — only torso items
/screenshot mask         — only masks
/screenshot hat          — only hats
```

**Available categories:** `mask`, `top`, `torso`, `pants`, `shoes`, `bag`, `accessory`, `vest`, `hat`, `glasses`, `ears`, `watch`, `bracelet`

### `/customscreenshot <component> <drawable/all> <CLOTHING|PROPS> <male|female|both> [camera-settings]`

Capture a specific component or iterate all drawables.

```
/customscreenshot 11 17 CLOTHING male
/customscreenshot 11 all CLOTHING male
/customscreenshot 0 all PROPS both
/customscreenshot 11 17 CLOTHING male {"fov": 55, "rotation": {"x": 0, "y": 0, "z": 15}, "zPos": 0.26}
```

### `/screenshotobject <hash>`

Screenshot objects or weapons.

```
/screenshotobject 2240524752
/screenshotobject weapon_pistol
```

### `/screenshotvehicle <model|all> [primarycolor] [secondarycolor]`

Screenshot one or all vehicles. Optional paint colors ([color list](https://wiki.rage.mp/index.php?title=Vehicle_Colors)).

```
/screenshotvehicle all
/screenshotvehicle zentorno 31 5
```

### `/gs_set <category> <property> <value>`

Adjust camera and ped settings at runtime (changes apply immediately).

```
/gs_set clothing_torso zPos -0.5
/gs_set clothing_torso fov 35
/gs_set clothing_mask pedY -3419.5
/gs_set clothing_shoes extraRot 45
```

**Properties:** `zPos`, `fov`, `pedY`, `pedRotX`, `basePedZ`, `extraRot`

### `/gs_show [category]`

Display current camera settings and overrides.

```
/gs_show                 — show all overrides
/gs_show clothing_torso  — show torso settings
```

## Configuration

All settings are in `config.json` with inline comments:

| Option | Default | Description |
|--------|---------|-------------|
| `imageSize` | `150` | Output image size in pixels (square) |
| `chromaSensitivity` | `"soft"` | Greenscreen removal: `soft`, `medium`, `hard` |
| `includeTextures` | `true` | Capture all texture variations per drawable |
| `overwriteExistingImages` | `true` | Set `false` for resumable sessions |
| `useDatabaseItems` | `false` | Set `true` to use `clothing_items.json` item list |
| `useQBVehicles` | `false` | Use QBCore vehicle list instead of native models |
| `categories` | `[]` | Filter categories (empty = all) |

### Database Mode (Optional)

If you have a database with clothing item names/labels, you can generate a `clothing_items.json`:

```bash
node extract_items.js path/to/your/database_dump.sql
```

Then set `"useDatabaseItems": true` in `config.json`. This gives your screenshots meaningful filenames from your database instead of generic `clothing_mask_m_0_0.png` names.

## Controls During Capture

While screenshots are being taken, you can adjust the ped position and rotation in real-time:

| Key | Action |
|-----|--------|
| W/S | Move ped forward/backward |
| A/D | Move ped left/right |
| Q/E | Move ped down/up |
| Arrow Up/Down | Tilt ped |
| Arrow Left/Right | Rotate ped |
| V | Print current position/rotation to server console |

## Output

Images are saved to `resources/greenscreener/images/` in category folders:

```
images/
├── Accessories/
├── Bags/
├── Bracelets/
├── Ears/
├── Glasses/
├── Hats/
├── Masks/
├── Pants/
├── Shoes/
├── Tops/
├── Torsos/
├── Watches/
└── Bodyarmors/
```

All images are transparent PNGs at the configured size (default 150x150).

## Examples

<img src="https://i.imgur.com/2WJyGgy.png" width="200"> <img src="https://i.imgur.com/aAQwU4d.png" width="200">
<img src="https://i.imgur.com/EqY5Inu.png" width="200"> <img src="https://i.imgur.com/ctTF9M9.png" width="200">
<img src="https://i.imgur.com/6qD7hF3.png" width="200"> <img src="https://i.imgur.com/xdMyGyk.png" width="200">

## Credits

- Original project by [Bentix-cs](https://github.com/Bentix-cs/fivem-greenscreener)
- Greenscreen removal by [@hakanesnn](https://github.com/hakanesnn)
- Greenscreen model by [@jimgordon20](https://github.com/jimgordon20/jim_g_green_screen)

## Support

- Original project: [Bentix Discord](https://discord.gg/yN96thgggk)
- Support the original author on [ko-fi](https://ko-fi.com/bentix)
