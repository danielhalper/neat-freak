// Generates the 1400x560 Chrome Web Store marquee tile.
// Output: store-marquee-1400x560.png in this folder (24-bit RGB, no alpha).

const path = require("path");
const fs = require("fs");
const pptxgen = require("pptxgenjs");
const sharp = require("sharp");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT_DIR = __dirname;
const OUT_FILE = path.join(OUT_DIR, "Neat-Freak-Marquee.pptx");

// 1400x560 at 96 DPI = 14.583" x 5.833"
const SLIDE_W = 14.583;
const SLIDE_H = 5.833;

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
  pres.defineLayout({ name: "MARQUEE_1400x560", width: SLIDE_W, height: SLIDE_H });
  pres.layout = "MARQUEE_1400x560";

  const logoPng = await svgFileToBase64Png(path.join(ROOT, "assets", "logo.svg"), 512);

  const s = pres.addSlide();
  s.background = { color: COLORS.tealDark };

  // Decorative accents
  s.addShape(pres.shapes.OVAL, {
    x: 11.0, y: -2.0, w: 5.5, h: 5.5,
    fill: { color: COLORS.tealMid, transparency: 45 },
    line: { color: COLORS.tealMid, transparency: 45 }
  });
  s.addShape(pres.shapes.OVAL, {
    x: 12.5, y: 3.3, w: 4.0, h: 4.0,
    fill: { color: COLORS.tealMid, transparency: 60 },
    line: { color: COLORS.tealMid, transparency: 60 }
  });
  s.addShape(pres.shapes.OVAL, {
    x: -1.5, y: 3.5, w: 3.5, h: 3.5,
    fill: { color: COLORS.tealMid, transparency: 70 },
    line: { color: COLORS.tealMid, transparency: 70 }
  });

  // Logo
  s.addImage({ data: logoPng, x: 0.85, y: 0.65, w: 1.2, h: 1.2 });

  // Wordmark
  s.addText("NEAT FREAK", {
    x: 2.25, y: 0.78, w: 6, h: 0.5,
    fontFace: "Calibri", fontSize: 18, bold: true, color: COLORS.gold, charSpacing: 14, margin: 0, valign: "middle"
  });
  s.addText("for Chrome", {
    x: 2.25, y: 1.25, w: 6, h: 0.3,
    fontFace: "Calibri", fontSize: 12, italic: true, color: COLORS.tealSoft, margin: 0
  });

  // Headline
  s.addText("Tidy your tabs.", {
    x: 0.85, y: 2.2, w: 12, h: 1.0,
    fontFace: "Georgia", fontSize: 56, bold: true, color: COLORS.white, margin: 0
  });
  s.addText("Find your work.", {
    x: 0.85, y: 3.05, w: 12, h: 1.0,
    fontFace: "Georgia", fontSize: 56, bold: true, italic: true, color: COLORS.gold, margin: 0
  });

  // Subhead
  s.addText("Save every open tab into memory-light folders, grouped by what you're actually working on — and restore them in one click.", {
    x: 0.85, y: 4.3, w: 11.5, h: 0.7,
    fontFace: "Calibri", fontSize: 17, color: COLORS.tealSoft, margin: 0
  });

  // Bottom accent
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.85, y: 5.25, w: 0.9, h: 0.05,
    fill: { color: COLORS.gold }, line: { color: COLORS.gold }
  });
  s.addText("Save · Group · Find", {
    x: 0.85, y: 5.35, w: 12, h: 0.35,
    fontFace: "Calibri", fontSize: 13, color: COLORS.tealSoft, margin: 0
  });

  await pres.writeFile({ fileName: OUT_FILE });
  console.log("Wrote", OUT_FILE);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
