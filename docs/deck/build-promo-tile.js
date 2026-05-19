// Generates the 440x280 Chrome Web Store small promo tile.
// Output: store-promo-440x280.png in this folder.

const path = require("path");
const fs = require("fs");
const pptxgen = require("pptxgenjs");
const sharp = require("sharp");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT_DIR = __dirname;
const OUT_FILE = path.join(OUT_DIR, "Neat-Freak-Promo-Tile.pptx");

// 440x280 at 96 DPI = 4.583" x 2.917"
const SLIDE_W = 4.583;
const SLIDE_H = 2.917;

const COLORS = {
  teal: "0F766E",
  tealDark: "093F3B",
  tealMid: "115E59",
  tealSoft: "D9F0E8",
  gold: "F4BD45",
  white: "FFFFFF"
};

async function svgFileToBase64Png(svgPath, size = 256) {
  const svg = fs.readFileSync(svgPath);
  const pngBuffer = await sharp(svg, { density: 600 }).resize(size, size).png().toBuffer();
  return "image/png;base64," + pngBuffer.toString("base64");
}

async function build() {
  const pres = new pptxgen();
  pres.defineLayout({ name: "PROMO_440x280", width: SLIDE_W, height: SLIDE_H });
  pres.layout = "PROMO_440x280";

  const logoPng = await svgFileToBase64Png(path.join(ROOT, "assets", "logo.svg"), 256);

  const s = pres.addSlide();
  s.background = { color: COLORS.tealDark };

  // Decorative accent circles
  s.addShape(pres.shapes.OVAL, {
    x: 3.7, y: -0.7, w: 1.8, h: 1.8,
    fill: { color: COLORS.tealMid, transparency: 50 },
    line: { color: COLORS.tealMid, transparency: 50 }
  });
  s.addShape(pres.shapes.OVAL, {
    x: 3.3, y: 1.9, w: 1.5, h: 1.5,
    fill: { color: COLORS.tealMid, transparency: 65 },
    line: { color: COLORS.tealMid, transparency: 65 }
  });

  // Logo
  s.addImage({ data: logoPng, x: 0.28, y: 0.28, w: 0.85, h: 0.85 });

  // Wordmark
  s.addText("NEAT FREAK", {
    x: 1.2, y: 0.38, w: 3.2, h: 0.4,
    fontFace: "Calibri", fontSize: 14, bold: true, color: COLORS.gold, charSpacing: 10, margin: 0, valign: "middle"
  });
  s.addText("for Chrome", {
    x: 1.2, y: 0.72, w: 3.2, h: 0.25,
    fontFace: "Calibri", fontSize: 9, italic: true, color: COLORS.tealSoft, margin: 0
  });

  // Big headline
  s.addText("Tidy your tabs.", {
    x: 0.28, y: 1.25, w: 4.2, h: 0.6,
    fontFace: "Georgia", fontSize: 30, bold: true, color: COLORS.white, margin: 0
  });
  s.addText("Find your work.", {
    x: 0.28, y: 1.78, w: 4.2, h: 0.6,
    fontFace: "Georgia", fontSize: 30, bold: true, italic: true, color: COLORS.gold, margin: 0
  });

  // Bottom strip
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.28, y: 2.5, w: 0.42, h: 0.04,
    fill: { color: COLORS.gold }, line: { color: COLORS.gold }
  });
  s.addText("Save · Group · Find", {
    x: 0.28, y: 2.58, w: 4.2, h: 0.3,
    fontFace: "Calibri", fontSize: 11, color: COLORS.tealSoft, margin: 0
  });

  await pres.writeFile({ fileName: OUT_FILE });
  console.log("Wrote", OUT_FILE);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
