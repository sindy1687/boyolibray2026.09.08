import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const sourcePath = "C:/Users/Boyo/.codex/attachments/b375ab7b-a8f4-4b3b-8f8d-ac44a89edf96/pasted-text.txt";
const outputDir = "outputs/book-title-format";
const outputPath = `${outputDir}/整理後書名.xlsx`;

function normalizeBookTitle(value) {
  let title = String(value || "").trim();
  if (!title) return "";

  title = title
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[﹕∶:]/g, "：")
    .replace(/[;；]/g, "；")
    .replace(/[,，]/g, "，")
    .replace(/[?？]/g, "？")
    .replace(/[!！]/g, "！")
    .replace(/([\u3400-\u9fffA-Za-z0-9）】》])\s*[-－–—]\s*([\u3400-\u9fffA-Za-z0-9（【《])/g, "$1：$2")
    .replace(/^(.+[0-9０-９]{1,3})\s+([^\s].+)$/u, "$1：$2")
    .replace(/\s*：\s*/g, "：")
    .replace(/\s*，\s*/g, "，")
    .replace(/\s*；\s*/g, "；")
    .replace(/\s*？\s*/g, "？")
    .replace(/\s*！\s*/g, "！")
    .replace(/[「『]\s*/g, "《")
    .replace(/\s*[」』]/g, "》")
    .replace(/[\[\(（]\s*/g, "（")
    .replace(/\s*[\]\)）]/g, "）")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  return title;
}

const raw = await fs.readFile(sourcePath, "utf8");
const titles = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const rows = titles.map((title, index) => {
  const fixed = normalizeBookTitle(title);
  return [index + 1, title, fixed, title === fixed ? "" : "已整理"];
});

await fs.mkdir(outputDir, { recursive: true });

const workbook = Workbook.create();
const sheet = workbook.worksheets.add("整理後書名");
sheet.showGridLines = false;
sheet.tabColor = "#1E3A8A";

sheet.getRange("A1:D1").values = [["序號", "原書名", "整理後書名", "狀態"]];
sheet.getRangeByIndexes(1, 0, rows.length, 4).values = rows;

const used = sheet.getRangeByIndexes(0, 0, rows.length + 1, 4);
used.format.font = { name: "Arial", size: 10, color: "#1F2937" };
used.format.verticalAlignment = "center";
sheet.getRange("A1:D1").format = {
  fill: "#1E3A8A",
  font: { name: "Arial", bold: true, color: "#FFFFFF" },
};
sheet.getRange("A1:D1").format.borders = { preset: "all", style: "thin", color: "#FFFFFF" };
sheet.getRangeByIndexes(1, 0, rows.length, 4).format.borders = { preset: "insideHorizontal", style: "thin", color: "#E5E7EB" };
sheet.getRangeByIndexes(1, 0, rows.length, 1).format.horizontalAlignment = "center";
sheet.getRangeByIndexes(1, 3, rows.length, 1).format.horizontalAlignment = "center";
sheet.getRange("A:A").format.columnWidthPx = 58;
sheet.getRange("B:B").format.columnWidthPx = 360;
sheet.getRange("C:C").format.columnWidthPx = 360;
sheet.getRange("D:D").format.columnWidthPx = 90;
sheet.getRangeByIndexes(0, 1, rows.length + 1, 2).format.wrapText = false;
sheet.freezePanes.freezeRows(1);

workbook.recalculate();

await workbook.inspect({
  kind: "table",
  sheetId: "整理後書名",
  range: "A1:D12",
  include: "values",
  tableMaxRows: 12,
  tableMaxCols: 4,
});

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

console.log(JSON.stringify({
  outputPath,
  total: titles.length,
  changed: rows.filter(row => row[3]).length,
}));
