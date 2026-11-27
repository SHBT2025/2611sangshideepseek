# DEADLIGHT // OUTPOST 13

**在线试玩 · Play online:** https://SHBT2025.github.io/2611sangshideepseek/

## 中文介绍

**《DEADLIGHT // 前哨 13》** 是一个完全运行在浏览器中的 3D 僵尸生存第一人称射击游戏。整个游戏——地形、建筑、材质、贴图、植被、天空、雨雾、武器模型、僵尸模型与动画、音效与氛围音乐——全部由代码在运行时程序化生成，不使用任何外部素材，也不会发起网络请求。

- **守住前哨**：保护中央的无线电灯塔/发电机，利用南北两座可破坏、可修复的木门抵挡尸潮。
- **8 波进攻**：普通行尸、快速奔跑者、重型壮尸、尖啸者和第 8 波 Boss「ABOMINATION」。
- **生存搜刮**：波次之间搜刮弹药、医疗包、木板和补给箱，修复门板、加固防线。
- **昼夜双版本**：开始菜单可选择 **夜晚**（暴雨、星空、闪电、低能见度）或 **白天**（阴天暖阳、更远视距、细雨与湿地反光）。
- **完整流程**：开始菜单、战场手册、设置、暂停、死亡统计、撤离胜利结算和重新开始。
- **技术规格**：Three.js r160 + WebGL 2，单文件 `index.html`（约 1.2 MB），HDR 后处理、动态阴影、程序化音频，桌面 Chrome / Edge 即可运行。

### 操作

| 按键 | 功能 |
|---|---|
| `W A S D` | 移动 |
| 鼠标 | 视角 |
| `Shift` | 冲刺 |
| `C` | 蹲下 |
| 鼠标左键 | 射击 |
| 鼠标右键 | 瞄准 |
| `R` | 换弹 |
| `F` | 手电筒 |
| `E` | 拾取 / 交互 / 按住修复门板 |
| `H` | 使用医疗包 |
| `1` `2` `Q` | 切换武器 |
| `Esc` | 暂停 |

> 需要支持 WebGL 2 的桌面浏览器与鼠标键盘；音频会在首次点击后解锁。项目仓库：[2611sangshideepseek](https://github.com/SHBT2025/2611sangshideepseek)。

---

## English

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
