// Generates Chrome Web Store screenshots for Neat Freak.
// Output: a 4-slide .pptx at 1280x800 (the Web Store screenshot size).
// PNG export is a separate step (pptx → pdf via LibreOffice → png via PyMuPDF).
//
// Slide structure (these are MARKETING shots, not onboarding — they sell the
// product, they don't tutorialize it):
//   1. Hero        — wordmark + tagline + the real character
//   2. Smart tidy  — "It knows what to keep": chaos → mascot → calm outcome
//   3. Smart group — folders by workstream, not domain
//   4. Search      — find anything later in plain English

const path = require("path");
const fs = require("fs");
const pptxgen = require("pptxgenjs");
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const {
  FaBoxOpen, FaMagic, FaSearch, FaCheck
} = require("react-icons/fa");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT_DIR = __dirname;
const OUT_FILE = path.join(OUT_DIR, "Neat-Freak-Store-Screenshots.pptx");

// Web Store screenshots: 1280x800 -> 13.333" x 8.333" at 96 DPI.
const SLIDE_W = 13.333;
const SLIDE_H = 8.333;

const COLORS = {
  teal: "0F766E",
  tealDark: "093F3B",
  tealMid: "115E59",
  tealSoft: "D9F0E8",
  tealMist: "F0FDFA",
  gold: "F4BD45",
  goldDeep: "C68A14",
  amber: "D59B32",
  ink: "0B1F1D",
  body: "1F2937",
  muted: "64748B",
  mutedSoft: "94A3B8",
  border: "E2E8F0",
  borderSoft: "EDE7D8",
  warmWash: "F5EFE5",
  white: "FFFFFF",
  paper: "FAFAF7",
  cream: "FEFEFC"
};

const FONT_HEAD = "Georgia";
const FONT_BODY = "Calibri";

function renderIconSvg(IconComponent, color = "#000000", size = 256) {
  return ReactDOMServer.renderToStaticMarkup(
    React.createElement(IconComponent, { color, size: String(size) })
  );
}

async function iconToBase64Png(IconComponent, color, size = 256) {
  const svg = renderIconSvg(IconComponent, color, size);
  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return "image/png;base64," + pngBuffer.toString("base64");
}

async function svgFileToBase64Png(svgPath, width, height) {
  const svg = fs.readFileSync(svgPath);
  const pngBuffer = await sharp(svg, { density: 600 })
    .resize(width, height, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return "image/png;base64," + pngBuffer.toString("base64");
}

function shadow() {
  return { type: "outer", color: "0B1F1D", blur: 20, offset: 4, angle: 90, opacity: 0.14 };
}

function softShadow() {
  return { type: "outer", color: "0B1F1D", blur: 30, offset: 6, angle: 90, opacity: 0.10 };
}

function cardShadow() {
  return { type: "outer", color: "0B1F1D", blur: 9, offset: 3, angle: 90, opacity: 0.18 };
}

async function build() {
  const pres = new pptxgen();
  pres.defineLayout({ name: "STORE_1280x800", width: SLIDE_W, height: SLIDE_H });
  pres.layout = "STORE_1280x800";
  pres.author = "Neat Freak";
  pres.title = "Neat Freak — Chrome Web Store screenshots";

  const logoPng = await svgFileToBase64Png(path.join(ROOT, "assets", "logo.svg"), 512, 512);
  // The REAL in-product character (round body + arms), generated from
  // neat-freak-panel.js by build-character-svgs.js. 320x200 viewBox → render
  // at 1.6:1 so the creature isn't distorted.
  const mascotHappyPng = await svgFileToBase64Png(path.join(OUT_DIR, "mascot-character-happy.svg"), 1000, 625);
  const iconBox = await iconToBase64Png(FaBoxOpen, "#" + COLORS.teal);

  // ============================================================
  // SLIDE 1 — HERO with the real character
  // ============================================================
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.tealDark };

    s.addShape(pres.shapes.OVAL, {
      x: 10.6, y: -1.6, w: 5.6, h: 5.6,
      fill: { color: COLORS.tealMid, transparency: 50 }, line: { color: COLORS.tealMid, transparency: 50 }
    });
    s.addShape(pres.shapes.OVAL, {
      x: 9.6, y: 5.6, w: 4.5, h: 4.5,
      fill: { color: COLORS.tealMid, transparency: 65 }, line: { color: COLORS.tealMid, transparency: 65 }
    });

    s.addImage({ data: logoPng, x: 0.8, y: 0.8, w: 1.0, h: 1.0 });
    s.addText("NEAT FREAK", {
      x: 2.0, y: 1.05, w: 5, h: 0.5,
      fontFace: FONT_BODY, fontSize: 16, bold: true, color: COLORS.gold, charSpacing: 12, margin: 0, valign: "middle"
    });

    s.addText("Tidy your tabs.", {
      x: 0.8, y: 2.6, w: 9.4, h: 1.6,
      fontFace: FONT_HEAD, fontSize: 76, bold: true, color: COLORS.white, margin: 0
    });
    s.addText("Find your work.", {
      x: 0.8, y: 4.1, w: 9.4, h: 1.6,
      fontFace: FONT_HEAD, fontSize: 76, bold: true, italic: true, color: COLORS.gold, margin: 0
    });

    s.addText("Save every tab into memory-light folders, grouped by what you're actually working on — and restore them in one click.", {
      x: 0.8, y: 5.95, w: 8.8, h: 1.3,
      fontFace: FONT_BODY, fontSize: 19, color: COLORS.tealSoft, margin: 0, paraSpaceAfter: 4
    });

    s.addImage({ data: mascotHappyPng, x: 8.5, y: 4.55, w: 4.6, h: 2.875 });

    s.addShape(pres.shapes.RECTANGLE, {
      x: 0.8, y: 7.55, w: 1.2, h: 0.06,
      fill: { color: COLORS.gold }, line: { color: COLORS.gold }
    });
    s.addText("A Chrome extension. No account. Yours.", {
      x: 0.8, y: 7.7, w: 11, h: 0.4,
      fontFace: FONT_BODY, fontSize: 13, color: COLORS.tealSoft, italic: true, margin: 0
    });
  }

  // ============================================================
  // SLIDE 2 — "It knows what to keep" (chaos → mascot → calm)
  // ============================================================
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.white };

    s.addText("SMART TIDY", {
      x: 0.8, y: 0.85, w: 12, h: 0.5,
      fontFace: FONT_BODY, fontSize: 14, color: COLORS.gold, bold: true, charSpacing: 12, margin: 0
    });
    s.addText("It knows what to keep.", {
      x: 0.8, y: 1.4, w: 12, h: 1.0,
      fontFace: FONT_HEAD, fontSize: 52, bold: true, color: COLORS.ink, margin: 0
    });
    s.addText("Neat Freak reads what you're working on, leaves your live work open, and files the rest into folders — restorable in one click. Nothing lost.", {
      x: 0.8, y: 2.55, w: 11.8, h: 0.8,
      fontFace: FONT_BODY, fontSize: 16, italic: true, color: COLORS.muted, margin: 0
    });

    // ---------- Left: the chaos pile ----------
    const chaosX = 0.65, chaosY = 3.7, chaosW = 3.85, chaosH = 3.5;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x: chaosX, y: chaosY, w: chaosW, h: chaosH, rectRadius: 0.12,
      fill: { color: COLORS.warmWash }, line: { type: "none" }
    });
    // A messy fan of tilted "tab" cards — quantity + tilt read as clutter.
    const chaosCards = [
      { x: 0.95, y: 4.05, rot: 347 },
      { x: 1.75, y: 3.92, rot: 8 },
      { x: 1.05, y: 4.62, rot: 353 },
      { x: 1.85, y: 4.55, rot: 12 },
      { x: 1.30, y: 5.30, rot: 350 },
      { x: 2.02, y: 5.18, rot: 6 },
      { x: 1.48, y: 5.95, rot: 356 }
    ];
    const cw = 1.7, ch = 0.5;
    chaosCards.forEach((c) => {
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
        x: c.x, y: c.y, w: cw, h: ch, rectRadius: 0.06, rotate: c.rot,
        fill: { color: COLORS.white }, line: { color: COLORS.border, width: 1 },
        shadow: cardShadow()
      });
      // favicon dot + title bar, rotated with the card
      s.addShape(pres.shapes.OVAL, {
        x: c.x + 0.12, y: c.y + 0.17, w: 0.16, h: 0.16, rotate: c.rot,
        fill: { color: COLORS.mutedSoft }, line: { type: "none" }
      });
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
        x: c.x + 0.38, y: c.y + 0.2, w: 1.1, h: 0.1, rectRadius: 0.05, rotate: c.rot,
        fill: { color: COLORS.border }, line: { type: "none" }
      });
    });
    s.addText("47 tabs, scattered", {
      x: chaosX, y: chaosY + chaosH + 0.12, w: chaosW, h: 0.35,
      fontFace: FONT_BODY, fontSize: 13, italic: true, color: COLORS.muted, align: "center", margin: 0
    });

    // ---------- Center: the mascot doing the sorting ----------
    s.addText("→", {
      x: 4.45, y: 5.05, w: 0.7, h: 0.6,
      fontFace: FONT_BODY, fontSize: 30, bold: true, color: COLORS.gold, align: "center", valign: "middle", margin: 0
    });
    s.addImage({ data: mascotHappyPng, x: 5.15, y: 4.35, w: 3.0, h: 1.875 });
    s.addText("→", {
      x: 8.15, y: 5.05, w: 0.7, h: 0.6,
      fontFace: FONT_BODY, fontSize: 30, bold: true, color: COLORS.gold, align: "center", valign: "middle", margin: 0
    });

    // ---------- Right: the calm outcome ----------
    const calmX = 8.55, calmW = 4.2;
    // Kept-open cluster
    s.addText("STILL OPEN", {
      x: calmX, y: 3.78, w: calmW, h: 0.3,
      fontFace: FONT_BODY, fontSize: 11, bold: true, color: COLORS.goldDeep, charSpacing: 6, margin: 0
    });
    const keptTabs = ["Proposal draft · Google Docs", "Checkout · Etsy"];
    keptTabs.forEach((t, i) => {
      const y = 4.12 + i * 0.62;
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
        x: calmX, y, w: calmW, h: 0.5, rectRadius: 0.06,
        fill: { color: COLORS.white }, line: { color: COLORS.border, width: 1 }, shadow: cardShadow()
      });
      s.addShape(pres.shapes.RECTANGLE, {
        x: calmX, y, w: 0.08, h: 0.5,
        fill: { color: COLORS.gold }, line: { type: "none" }
      });
      s.addShape(pres.shapes.OVAL, {
        x: calmX + 0.25, y: y + 0.17, w: 0.16, h: 0.16,
        fill: { color: COLORS.teal }, line: { type: "none" }
      });
      s.addText(t, {
        x: calmX + 0.55, y, w: calmW - 0.7, h: 0.5,
        fontFace: FONT_BODY, fontSize: 12.5, bold: true, color: COLORS.ink, valign: "middle", margin: 0
      });
    });
    // Filed-into-folders cluster
    s.addText("TUCKED INTO FOLDERS", {
      x: calmX, y: 5.5, w: calmW, h: 0.3,
      fontFace: FONT_BODY, fontSize: 11, bold: true, color: COLORS.teal, charSpacing: 6, margin: 0
    });
    const folders = ["Hiring & Candidates", "Q4 Planning", "Plumber search · Tue"];
    folders.forEach((name, i) => {
      const y = 5.84 + i * 0.56;
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
        x: calmX, y, w: calmW, h: 0.46, rectRadius: 0.06,
        fill: { color: COLORS.cream }, line: { color: COLORS.borderSoft, width: 1 }
      });
      s.addShape(pres.shapes.OVAL, {
        x: calmX + 0.14, y: y + 0.08, w: 0.3, h: 0.3,
        fill: { color: COLORS.tealSoft }, line: { type: "none" }
      });
      s.addImage({ data: iconBox, x: calmX + 0.2, y: y + 0.14, w: 0.18, h: 0.18 });
      s.addText(name, {
        x: calmX + 0.56, y, w: calmW - 0.7, h: 0.46,
        fontFace: FONT_BODY, fontSize: 12.5, bold: true, color: COLORS.ink, valign: "middle", margin: 0
      });
    });

    // Footer reassurance
    s.addText([
      { text: "Filed tabs are saved, not deleted — ", options: { color: COLORS.body } },
      { text: "restore any one in a click.", options: { color: COLORS.muted, italic: true } }
    ], {
      x: 0.8, y: 7.75, w: 12, h: 0.4,
      fontFace: FONT_BODY, fontSize: 13, align: "center", margin: 0
    });
  }

  // ============================================================
  // SLIDE 3 — SMART GROUPING
  // ============================================================
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.white };

    s.addText("SMART GROUPING", {
      x: 0.8, y: 0.9, w: 12, h: 0.5,
      fontFace: FONT_BODY, fontSize: 14, color: COLORS.gold, bold: true, charSpacing: 12, margin: 0
    });
    s.addText("Folders by what you're working on.", {
      x: 0.8, y: 1.45, w: 12, h: 1.2,
      fontFace: FONT_HEAD, fontSize: 52, bold: true, color: COLORS.ink, margin: 0
    });
    s.addText("Not by domain. Not by date. By workstream.", {
      x: 0.8, y: 2.85, w: 12, h: 0.5,
      fontFace: FONT_BODY, fontSize: 17, italic: true, color: COLORS.muted, margin: 0
    });

    const folders = [
      {
        name: "Hiring & Candidates",
        tabs: [
          "UX Designer — portfolio review.pdf",
          "Senior UX Designer roles · LinkedIn",
          "Product Design applicants · Sheet",
          "Notes from screening calls"
        ]
      },
      {
        name: "Step Up: Mastery & Sessions",
        tabs: [
          "Mastery — product brief · Doc",
          "Session experience research",
          "Tutor feedback dashboard",
          "Q4 planning · Sheet"
        ]
      },
      {
        name: "That Plumber Search From Tuesday",
        tabs: [
          "Local plumbers · Yelp",
          "How to fix a leaking trap · article",
          "Home Depot · plumbing parts",
          "Reddit · plumbing DIY"
        ]
      }
    ];
    folders.forEach((folder, idx) => {
      const cardW = 3.95;
      const cardH = 3.9;
      const cardX = 0.8 + idx * 4.18;
      const cardY = 3.6;

      s.addShape(pres.shapes.RECTANGLE, {
        x: cardX, y: cardY, w: cardW, h: cardH,
        fill: { color: COLORS.cream }, line: { color: COLORS.borderSoft, width: 1 },
        shadow: shadow()
      });
      s.addShape(pres.shapes.RECTANGLE, {
        x: cardX, y: cardY, w: cardW, h: 0.09,
        fill: { color: COLORS.teal }, line: { color: COLORS.teal }
      });
      s.addShape(pres.shapes.OVAL, {
        x: cardX + 0.35, y: cardY + 0.35, w: 0.7, h: 0.7,
        fill: { color: COLORS.tealSoft }, line: { color: COLORS.tealSoft }
      });
      s.addImage({ data: iconBox, x: cardX + 0.5, y: cardY + 0.5, w: 0.4, h: 0.4 });
      s.addText(folder.name, {
        x: cardX + 1.2, y: cardY + 0.35, w: cardW - 1.4, h: 0.75,
        fontFace: FONT_HEAD, fontSize: 16, bold: true, color: COLORS.ink, margin: 0, valign: "middle"
      });
      s.addText(`${folder.tabs.length} tabs`, {
        x: cardX + 0.35, y: cardY + 1.25, w: cardW - 0.7, h: 0.3,
        fontFace: FONT_BODY, fontSize: 11, color: COLORS.muted, charSpacing: 4, margin: 0
      });
      folder.tabs.forEach((tab, i) => {
        const ty = cardY + 1.65 + i * 0.5;
        s.addShape(pres.shapes.RECTANGLE, {
          x: cardX + 0.35, y: ty + 0.05, w: 0.24, h: 0.24,
          fill: { color: COLORS.tealMist }, line: { color: COLORS.tealMist }
        });
        s.addText("•", {
          x: cardX + 0.35, y: ty + 0.05, w: 0.24, h: 0.24,
          fontFace: FONT_BODY, fontSize: 10, color: COLORS.teal, bold: true, align: "center", valign: "middle", margin: 0
        });
        s.addText(tab, {
          x: cardX + 0.7, y: ty - 0.03, w: cardW - 1.0, h: 0.4,
          fontFace: FONT_BODY, fontSize: 11, color: COLORS.body, margin: 0, valign: "middle"
        });
      });
    });

    s.addText([
      { text: "Reads titles, domains, and short page summaries.  ", options: { color: COLORS.body } },
      { text: "Opens in the same burst? Probably the same workstream.", options: { color: COLORS.muted, italic: true } }
    ], {
      x: 0.8, y: 7.7, w: 12, h: 0.4,
      fontFace: FONT_BODY, fontSize: 13, margin: 0
    });
  }

  // ============================================================
  // SLIDE 4 — SEARCH
  // ============================================================
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.paper };

    s.addText("SEARCH", {
      x: 0.8, y: 0.9, w: 12, h: 0.5,
      fontFace: FONT_BODY, fontSize: 14, color: COLORS.gold, bold: true, charSpacing: 12, margin: 0
    });
    s.addText("Find that tab you swear you had.", {
      x: 0.8, y: 1.45, w: 12, h: 1.3,
      fontFace: FONT_HEAD, fontSize: 50, bold: true, color: COLORS.ink, margin: 0
    });
    s.addText("Type a keyword, or ask a question. Neat Freak searches every saved tab.", {
      x: 0.8, y: 2.85, w: 12, h: 0.5,
      fontFace: FONT_BODY, fontSize: 17, italic: true, color: COLORS.muted, margin: 0
    });

    const mockX = 0.8;
    const mockY = 3.7;
    const mockW = 6.2;
    const mockH = 3.9;

    s.addShape(pres.shapes.RECTANGLE, {
      x: mockX, y: mockY, w: mockW, h: mockH,
      fill: { color: COLORS.white }, line: { color: COLORS.border, width: 1 },
      shadow: shadow()
    });
    s.addShape(pres.shapes.RECTANGLE, {
      x: mockX + 0.3, y: mockY + 0.3, w: mockW - 0.6, h: 0.65,
      fill: { color: COLORS.white }, line: { color: COLORS.teal, width: 2 }
    });
    s.addText("🔍", {
      x: mockX + 0.45, y: mockY + 0.3, w: 0.45, h: 0.65,
      fontFace: FONT_BODY, fontSize: 16, color: COLORS.muted, valign: "middle", margin: 0
    });
    s.addText("ux applicants i looked up", {
      x: mockX + 0.95, y: mockY + 0.3, w: mockW - 1.6, h: 0.65,
      fontFace: FONT_BODY, fontSize: 15, color: COLORS.ink, valign: "middle", margin: 0
    });

    s.addText([
      { text: "Press ", options: { color: COLORS.muted } },
      { text: "↵", options: { color: COLORS.ink, bold: true } },
      { text: " for smart search", options: { color: COLORS.muted } }
    ], {
      x: mockX + 0.3, y: mockY + 1.05, w: mockW - 0.6, h: 0.32,
      fontFace: FONT_BODY, fontSize: 11, margin: 0
    });

    const results = [
      { title: "UX Designer — portfolio review.pdf", folder: "Hiring & Candidates" },
      { title: "Senior UX Designer roles · LinkedIn", folder: "Hiring & Candidates" },
      { title: "Product Design applicants · Sheet", folder: "Hiring & Candidates" },
      { title: "Notes from designer screening calls", folder: "Hiring & Candidates" }
    ];
    results.forEach((row, idx) => {
      const y = mockY + 1.55 + idx * 0.56;
      s.addShape(pres.shapes.RECTANGLE, {
        x: mockX + 0.35, y: y + 0.04, w: 0.34, h: 0.34,
        fill: { color: COLORS.tealSoft }, line: { color: COLORS.tealSoft }
      });
      s.addText("•", {
        x: mockX + 0.35, y: y + 0.04, w: 0.34, h: 0.34,
        fontFace: FONT_BODY, fontSize: 12, color: COLORS.teal, bold: true, align: "center", valign: "middle", margin: 0
      });
      s.addText(row.title, {
        x: mockX + 0.85, y: y - 0.02, w: mockW - 1.2, h: 0.3,
        fontFace: FONT_BODY, fontSize: 13, bold: true, color: COLORS.ink, margin: 0
      });
      s.addText(row.folder, {
        x: mockX + 0.85, y: y + 0.22, w: mockW - 1.2, h: 0.24,
        fontFace: FONT_BODY, fontSize: 11, color: COLORS.muted, margin: 0
      });
    });

    const callX = 7.6;
    const calls = [
      {
        title: "Plain English works",
        body: "“ux applicants I looked up?” finds the right tabs even if those words aren't in the titles."
      },
      {
        title: "Searches every session",
        body: "Surfaces tabs from yesterday, last week, or that one Tuesday you went deep on Yelp."
      },
      {
        title: "Memory stays light",
        body: "Tabs are saved as URLs. Chrome closes them and reclaims the RAM."
      }
    ];
    calls.forEach((c, idx) => {
      const y = 3.7 + idx * 1.3;
      s.addShape(pres.shapes.RECTANGLE, {
        x: callX, y: y + 0.05, w: 0.07, h: 0.95,
        fill: { color: COLORS.gold }, line: { color: COLORS.gold }
      });
      s.addText(c.title, {
        x: callX + 0.25, y, w: 4.8, h: 0.35,
        fontFace: FONT_HEAD, fontSize: 19, bold: true, color: COLORS.ink, margin: 0
      });
      s.addText(c.body, {
        x: callX + 0.25, y: y + 0.4, w: 4.8, h: 0.7,
        fontFace: FONT_BODY, fontSize: 13, color: COLORS.body, margin: 0
      });
    });
  }

  await pres.writeFile({ fileName: OUT_FILE });
  console.log("Wrote", OUT_FILE);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
