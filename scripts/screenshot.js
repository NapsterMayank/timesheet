#!/usr/bin/env node
// Renders TUI frames to HTML for the README screenshots.
//
// This is a development script, not part of the published package. It calls the
// exact same captureFrame() the live TUI renders with, so the images in the
// README show real output from real code, not mockups.
//
//   node scripts/screenshot.js          # synthetic demo data (what's committed)
//   node scripts/screenshot.js --real   # your own data (don't commit it)
//
// Writes docs/*.html. To refresh the PNGs in the README, open each file in a
// browser and screenshot the terminal block, or point any headless browser at
// it. HTML is used rather than hand-built SVG because the browser resolves the
// monospace font metrics itself, which is what makes the box-drawing and block
// characters line up seamlessly.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureFrame } from "../src/tui.js";
import { demoData } from "./demo-data.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Screenshots use synthetic data by default: the README is public, and a real
// frame would publish whatever project names happen to be on the author's disk.
const USE_REAL = process.argv.includes("--real");

const BG = "#15161c";
const DEFAULT_FG = "#c8ccd6";
const FONT =
  "'DejaVu Sans Mono', 'Cascadia Mono', Consolas, Menlo, 'Liberation Mono', ui-monospace, monospace";

const ANSI_RE = /\x1b\[([0-9;]*)m/g;

// Turn one ANSI line into [{text, fg, bold}] runs.
function parseLine(line) {
  const runs = [];
  let fg = null;
  let bold = false;
  let last = 0;

  const push = (text) => {
    if (text) runs.push({ text, fg, bold });
  };

  ANSI_RE.lastIndex = 0;
  let m;
  while ((m = ANSI_RE.exec(line)) !== null) {
    push(line.slice(last, m.index));
    last = ANSI_RE.lastIndex;

    const codes = m[1].split(";").filter(Boolean).map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) {
        fg = null;
        bold = false;
      } else if (code === 1) {
        bold = true;
      } else if (code === 22) {
        bold = false;
      } else if (code === 39) {
        fg = null;
      } else if (code === 38 && codes[i + 1] === 2) {
        fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
        i += 4;
      }
    }
  }
  push(line.slice(last));

  return runs;
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toHtml(frame, { title }) {
  const body = frame
    .split("\n")
    .map((line) =>
      parseLine(line)
        .map((r) => {
          const style = [r.fg ? `color:${r.fg}` : "", r.bold ? "font-weight:700" : ""]
            .filter(Boolean)
            .join(";");
          return style ? `<span style="${style}">${esc(r.text)}</span>` : esc(r.text);
        })
        .join("")
    )
    .join("\n");

  return `<!doctype html>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  html, body { margin: 0; background: #0d0e12; }
  body { display: inline-block; padding: 18px; }
  pre {
    margin: 0;
    padding: 22px 24px;
    background: ${BG};
    color: ${DEFAULT_FG};
    border-radius: 10px;
    font-family: ${FONT};
    font-size: 14px;
    line-height: 1.28;
    white-space: pre;
    letter-spacing: 0;
  }
</style>
<pre id="shot">${body}</pre>
`;
}

const shots = [
  { name: "tui-7d", range: "7", days: 7, width: 104, title: "aitimesheet tui - last 7 days" },
  { name: "tui-today", range: "1", days: 1, width: 98, title: "aitimesheet tui - today" },
];

mkdirSync(join(ROOT, "docs"), { recursive: true });

for (const shot of shots) {
  const data = USE_REAL ? null : demoData({ days: shot.days });
  const frame = captureFrame({ range: shot.range, width: shot.width, data });
  const out = join(ROOT, "docs", `${shot.name}.html`);
  writeFileSync(out, toHtml(frame, { title: shot.title }));
  console.log(`wrote docs/${shot.name}.html`);
}
