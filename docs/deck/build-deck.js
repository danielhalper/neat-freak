// Generates Chrome Web Store screenshots for Neat Freak.
// Output: a 3-slide .pptx at 1280x800 (the Web Store screenshot size),
// rendered to 1280x800 PNGs in this same folder.

const path = require("path");
const fs = require("fs");
const pptxgen = require("pptxgenjs");
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const {
  FaBoxOpen, FaMagic, FaSearch, FaArrowRight
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
  ink: "0B1F1D",
  body: "1F2937",
  muted: "64748B",
  border: "E2E8F0",
  white: "FFFFFF",
  paper: "FAFAF7"
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

async function svgFileToBase64Png(svgPath, size = 512) {
  const svg = fs.readFileSync(svgPath);
  const pngBuffer = await sharp(svg, { density: 600 }).resize(size, size).png().toBuffer();
  return "image/png;base64," + pngBuffer.toString("base64");
}

function shadow() {
  return { type: "outer", color: "0B1F1D", blur: 20, offset: 4, angle: 90, opacity: 0.14 };
}

async function build() {
  const pres = new pptxgen();
  pres.defineLayout({ name: "STORE_1280x800", width: SLIDE_W, height: SLIDE_H });
  pres.layout = "STORE_1280x800";
  pres.author = "Neat Freak";
  pres.title = "Neat Freak — Chrome Web Store screenshots";

  const logoPng = await svgFileToBase64Png(path.join(ROOT, "assets", "logo.svg"), 512);
  const iconBox = await iconToBase64Png(FaBoxOpen, "#" + COLORS.teal);
  const iconMagic = await iconToBase64Png(FaMagic, "#" + COLORS.teal);
  const iconSearch = await iconToBase64Png(FaSearch, "#" + COLORS.teal);

  // ============================================================
  // SCREENSHOT 1: HERO
  // ============================================================
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.tealDark };

    // Subtle accent shapes (geometric, off to the right)
    s.addShape(pres.shapes.OVAL, {
      x: 11.2, y: -2, w: 5, h: 5,
      fill: { color: COLORS.tealMid, transparency: 40 }, line: { color: COLORS.tealMid, transparency: 40 }
    });
    s.addShape(pres.shapes.OVAL, {
      x: 10.5, y: 5.5, w: 4, h: 4,
      fill: { color: COLORS.tealMid, transparency: 60 }, line: { color: COLORS.tealMid, transparency: 60 }
    });

    // Logo (top-left)
    s.addImage({ data: logoPng, x: 0.8, y: 0.8, w: 1.0, h: 1.0 });
    s.addText("NEAT FREAK", {
      x: 2.0, y: 1.05, w: 5, h: 0.5,
      fontFace: FONT_BODY, fontSize: 16, bold: true, color: COLORS.gold, charSpacing: 12, margin: 0, valign: "middle"
    });

    // Big headline (left-aligned, centered vertically)
    s.addText("Tidy your tabs.", {
      x: 0.8, y: 2.6, w: 11.5, h: 1.6,
      fontFace: FONT_HEAD, fontSize: 88, bold: true, color: COLORS.white, margin: 0
    });
    s.addText("Find your work.", {
      x: 0.8, y: 4.1, w: 11.5, h: 1.6,
      fontFace: FONT_HEAD, fontSize: 88, bold: true, italic: true, color: COLORS.gold, margin: 0
    });

    // Sub-headline
    s.addText("Save every tab into memory-light folders, grouped by what you're actually working on — and restore them in one click.", {
      x: 0.8, y: 6.0, w: 10.5, h: 1.2,
      fontFace: FONT_BODY, fontSize: 20, color: COLORS.tealSoft, margin: 0, paraSpaceAfter: 4
    });

    // Bottom accent
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
  // SCREENSHOT 2: HOW IT WORKS
  // ============================================================
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.white };

    s.addText("THREE JOBS. ONE CLICK.", {
      x: 0.8, y: 0.9, w: 12, h: 0.5,
      fontFace: FONT_BODY, fontSize: 14, color: COLORS.gold, bold: true, charSpacing: 12, margin: 0
    });
    s.addText("How Neat Freak works.", {
      x: 0.8, y: 1.45, w: 12, h: 1.2,
      fontFace: FONT_HEAD, fontSize: 52, bold: true, color: COLORS.ink, margin: 0
    });

    const cards = [
      {
        icon: iconBox, n: "1", title: "Save",
        body: "Snapshot every open tab into a memory-light session. Tabs close, RAM frees up.",
      },
      {
        icon: iconMagic, n: "2", title: "Group",
        body: "Tabs auto-organize into folders by topic — your active workstreams, not just by domain.",
      },
      {
        icon: iconSearch, n: "3", title: "Find",
        body: "Search by name or ask in plain English. Restore one tab, one folder, or a whole session.",
      }
    ];
    cards.forEach((card, idx) => {
      const x = 0.8 + idx * 4.18;
      // Card
      s.addShape(pres.shapes.RECTANGLE, {
        x, y: 3.4, w: 3.95, h: 3.7,
        fill: { color: COLORS.paper }, line: { color: COLORS.border, width: 1 },
        shadow: shadow()
      });
      s.addShape(pres.shapes.RECTANGLE, {
        x, y: 3.4, w: 3.95, h: 0.09,
        fill: { color: COLORS.teal }, line: { color: COLORS.teal }
      });
      // Icon disc
      s.addShape(pres.shapes.OVAL, {
        x: x + 0.4, y: 3.8, w: 1.0, h: 1.0,
        fill: { color: COLORS.tealSoft }, line: { color: COLORS.tealSoft }
      });
      s.addImage({ data: card.icon, x: x + 0.65, y: 4.05, w: 0.5, h: 0.5 });
      // Step number
      s.addText(card.n, {
        x: x + 2.5, y: 3.65, w: 1.2, h: 1.0,
        fontFace: FONT_HEAD, fontSize: 72, bold: true, color: COLORS.tealSoft, align: "right", margin: 0
      });
      // Title
      s.addText(card.title, {
        x: x + 0.4, y: 5.0, w: 3.4, h: 0.6,
        fontFace: FONT_HEAD, fontSize: 32, bold: true, color: COLORS.ink, margin: 0
      });
      // Body
      s.addText(card.body, {
        x: x + 0.4, y: 5.7, w: 3.4, h: 1.3,
        fontFace: FONT_BODY, fontSize: 14, color: COLORS.body, margin: 0, paraSpaceAfter: 4
      });
    });

    // Optional power-user line
    s.addText([
      { text: "Want AI-smarter group names? ", options: { color: COLORS.body } },
      { text: "Drop your own OpenAI key in settings — optional, off by default.", options: { color: COLORS.muted, italic: true } }
    ], {
      x: 0.8, y: 7.55, w: 12, h: 0.45,
      fontFace: FONT_BODY, fontSize: 13, margin: 0
    });
  }

  // ============================================================
  // SCREENSHOT 3: SEARCH / FIND
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

    // Mock search UI on the left
    const mockX = 0.8;
    const mockY = 3.7;
    const mockW = 6.2;
    const mockH = 3.9;

    // Outer popup chrome
    s.addShape(pres.shapes.RECTANGLE, {
      x: mockX, y: mockY, w: mockW, h: mockH,
      fill: { color: COLORS.white }, line: { color: COLORS.border, width: 1 },
      shadow: shadow()
    });
    // Search input
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

    // Hint row
    s.addText([
      { text: "Press ", options: { color: COLORS.muted } },
      { text: "↵", options: { color: COLORS.ink, bold: true } },
      { text: " for smart search", options: { color: COLORS.muted } }
    ], {
      x: mockX + 0.3, y: mockY + 1.05, w: mockW - 0.6, h: 0.32,
      fontFace: FONT_BODY, fontSize: 11, margin: 0
    });

    // Results
    const results = [
      { title: "UX Designer — portfolio review.pdf", folder: "Hiring & Candidates" },
      { title: "Senior UX Designer roles · LinkedIn", folder: "Hiring & Candidates" },
      { title: "Product Design applicants · Sheet", folder: "Hiring & Candidates" },
      { title: "Notes from designer screening calls", folder: "Hiring & Candidates" }
    ];
    results.forEach((row, idx) => {
      const y = mockY + 1.55 + idx * 0.56;
      // Favicon block
      s.addShape(pres.shapes.RECTANGLE, {
        x: mockX + 0.35, y: y + 0.04, w: 0.34, h: 0.34,
        fill: { color: COLORS.tealSoft }, line: { color: COLORS.tealSoft }
      });
      s.addText("•", {
        x: mockX + 0.35, y: y + 0.04, w: 0.34, h: 0.34,
        fontFace: FONT_BODY, fontSize: 12, color: COLORS.teal, bold: true, align: "center", valign: "middle", margin: 0
      });
      // Title
      s.addText(row.title, {
        x: mockX + 0.85, y: y - 0.02, w: mockW - 1.2, h: 0.3,
        fontFace: FONT_BODY, fontSize: 13, bold: true, color: COLORS.ink, margin: 0
      });
      // Folder pill
      s.addText(row.folder, {
        x: mockX + 0.85, y: y + 0.22, w: mockW - 1.2, h: 0.24,
        fontFace: FONT_BODY, fontSize: 11, color: COLORS.muted, margin: 0
      });
    });

    // Right column: feature callouts
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
      // Accent bar
      s.addShape(pres.shapes.RECTANGLE, {
        x: callX, y: y + 0.05, w: 0.07, h: 0.95,
        fill: { color: COLORS.gold }, line: { color: COLORS.gold }
      });
      // Title
      s.addText(c.title, {
        x: callX + 0.25, y: y, w: 4.8, h: 0.35,
        fontFace: FONT_HEAD, fontSize: 19, bold: true, color: COLORS.ink, margin: 0
      });
      // Body
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
