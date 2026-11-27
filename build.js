// Build the single-file game: inline three.js, all modules and CSS.
const fs = require("fs");
const path = require("path");

const root = __dirname;
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const template = read("src/index.template.html");
const three = read("three.min.js");
const modules = {
  __THREE__: three,
  __CORE__: read("src/core.js"),
  __POST__: read("src/post.js"),
  __AUDIO__: read("src/audio.js"),
  __WORLD__: read("src/world.js"),
  __FX__: read("src/fx.js"),
  __ENEMIES__: read("src/enemies.js"),
  __WEAPONS__: read("src/weapons.js"),
  __PLAYER__: read("src/player.js"),
  __UI__: read("src/ui.js"),
  __MAIN__: read("src/main.js"),
};

let out = template;
for (const [key, src] of Object.entries(modules)) {
  const token = `/*${key}*/`;
  if (!out.includes(token)) throw new Error(`Template is missing ${token}`);
  // Guard against accidental script termination inside inline JS.
  const safe = src.replace(/<\/script/gi, "<\\/script");
  out = out.split(token).join(safe);
}

// Remove the dev-only live-reload token if one appears.
out = out.replace("<!--__DEV__-->", "");

fs.writeFileSync(path.join(root, "index.html"), out, "utf8");
const kb = (Buffer.byteLength(out, "utf8") / 1024).toFixed(0);
console.log(`Built index.html (${kb} KB) with ${Object.keys(modules).length} inlined payloads.`);
