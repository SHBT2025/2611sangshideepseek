# DEADLIGHT // OUTPOST 13

**Play online:** https://SHBT2025.github.io/2611sangshideepseek/

A complete single-file 3D zombie survival FPS for the browser. Everything — geometry, materials, textures, lighting, weather, weapon viewmodels, zombie bodies, animation, sound effects and music — is generated procedurally at runtime. No external assets, no network requests.

## Run it

Open **`index.html`** in a desktop Chromium browser (Chrome or Edge). On the start menu, choose **NIGHT** or **DAY**, then click **DEPLOY TO OUTPOST 13**.

For the cleanest test path you can optionally serve the folder locally:

```powershell
node serve.js
# then open http://127.0.0.1:8099/index.html
```

The game is fully playable from `file://` as well. WebGL 2 and a mouse + keyboard are required. Audio unlocks on the first click. The time-of-day choice is saved locally and restored the next time you open the game.

## Time of day

- **NIGHT** — the original storm: moonlight, stars, heavy rain, lightning, deep fog and low visibility.
- **DAY** — overcast daylight: a low warm sun, pale grey-blue sky, stronger shadows, lighter drizzle, higher visibility and brighter wet reflections. The flashlight starts off in daylight (press `F` if you want it).

Switching the time of day rebuilds the procedural sky environment probe and relights the entire outpost; the start menu updates its clock, visibility report and mission brief to match.

## Mission

Hold the abandoned Blackpine Valley listening post until extraction at dawn.

- Survive **8 escalating waves** of infected.
- Defend the **radio beacon/generator** at the center of the compound.
- Repair and rebuild the **north and south gate barricades** with collected boards.
- Scavenge ammunition, medkits, boards and supply caches between waves.
- Wave 8 ends with the **ABOMINATION**; kill it to trigger extraction.

## Controls

| Input | Action |
|---|---|
| `W A S D` | Move |
| Mouse | Look |
| `Shift` | Sprint |
| `C` | Crouch |
| `Left Mouse` | Fire |
| `Right Mouse` | Aim down sights |
| `R` | Reload |
| `F` | Flashlight |
| `E` | Interact / collect / hold to repair a barricade |
| `H` | Use medkit |
| `1` `2` `Q` | Switch weapons |
| `Esc` | Pause |

## Features

- HDR post-processing: ACES filmic tone mapping, dual-scale bloom, cold/warm grade, chromatic aberration, vignette, film grain and a damage/low-health wash.
- Wet procedural outpost with chain-link perimeter, destructible gates, bunker, watchtower, containers, floodlights, generator/radio mast, burning barrels, puddles, volumetric rain, mist, lightning and forest.
- Procedural **MK-18 rifle** and **M9 sidearm** with animated ADS, recoil, sway, sprint lower, magazine reload, bolt manipulation, shell ejection, muzzle flash and tracers.
- Five zombie types — walkers, runners, brutes, screamers and the wave-8 boss — with procedural bodies, clothing, grime/blood maps, ragdoll-ish death, A* pathing, gate breaching and objective targeting.
- Fully synthesized WebAudio: layered weapons, spatial zombie vocals, rain/wind/hum ambience, procedural reverb, dynamic music pulses, low-health heartbeat and boss audio.
- Complete game flow: time-of-day choose (night storm / daylight), start menu, field manual, settings, pause, death screen, extraction/victory screen, stats and restart.
- Quality presets (High/Medium/Low) adjust resolution, bloom, shadows and world density. Settings persist locally.
- Input/pointer-lock handling, pause on focus loss, adaptive HUD and objective prompts.

## Performance

Measured in Chrome on an AMD Radeon integrated GPU at 1600×950 with 16 live zombies: **6.7 ms average GPU frame time** including shadows and post-processing (~150 fps of headroom). The initial load builds the whole world and all procedural assets in roughly 1–3 seconds.

## Development

```
index.html              the deliverable — self-contained game
src/index.template.html shell, CSS and UI markup
src/core.js             math/noise/canvas/nav-grid utilities
src/post.js             HDR post pipeline
src/audio.js            procedural WebAudio engine
src/world.js            outpost, forest, weather, barricades, generator
src/enemies.js          zombie models, animation, AI, wave director
src/fx.js               pooled combat effects
src/weapons.js          viewmodels, weapon handling, hitscan
src/player.js           controller, camera, survival state
src/ui.js               HUD, menus, input
src/main.js             game director and integration
build.js                inlines everything into index.html
three.min.js            Three.js r160 UMD (build dependency)
```

Rebuild the single file after editing sources:

```powershell
node build.js
```

`preview-menu.png` and `preview-game.png` are captured screenshots from the built game. `preview-menu-day.png` and `preview-game-day.png` show the daytime variant.
