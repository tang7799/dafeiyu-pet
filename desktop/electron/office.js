// 大肥鱼 · Office 文档模块
// 生成/读取真正的 docx、xlsx（OOXML 是 zip 包，绝不能当文本写）
// 不依赖第三方库：自带最小 zip 读写（STORED 方式，Word/WPS/Excel 都认）
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const TEMPLATE_DIR = path.join(process.env.APPDATA || path.join(require("os").homedir(), "AppData", "Roaming"), "dafeiyu-templates");

/* ---------------- CRC32 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------------- 读 zip ---------------- */
function readZip(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 Office/zip 文件（可能已损坏）");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    const lnameLen = buf.readUInt16LE(localOff + 26);
    const lextraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lnameLen + lextraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    let data;
    try {
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = zlib.inflateRawSync(raw);
      else if (method === 9) throw new Error("不支持 deflate64 压缩");
      else throw new Error("不支持的压缩方式：" + method);
    } catch (e) {
      data = Buffer.alloc(0);
    }
    entries.push({ name, data });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

/* ---------------- 写 zip（全 STORE） ---------------- */
function writeZip(entries) {
  const chunks = [];
  const centrals = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const data = e.data || Buffer.alloc(0);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);       // 文件名 UTF-8
    lh.writeUInt16LE(0, 8);            // STORE
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

/* ---------------- 通用 ---------------- */
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
    // 去掉 XML 不接受的控制字符
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

function loadTemplate(kind) {
  const p = path.join(TEMPLATE_DIR, "blank." + kind);
  try { return readZip(p); } catch (e) { return null; }
}

/* ---------------- 排版基础：字号 / 字体 / 段落 ---------------- */
// 中文字号 → pt（Word 里那套"小四""三号"）
const SIZE_NAMES = {
  初号: 42, 小初: 36, 一号: 26, 小一: 24, 二号: 22, 小二: 18,
  三号: 16, 小三: 15, 四号: 14, 小四: 12, 五号: 10.5, 小五: 9,
  六号: 7.5, 小六: 6.5, 七号: 5.5, 八号: 5,
};
const ALIGN_MAP = {
  左: "left", 左对齐: "left", left: "left",
  居中: "center", 中间: "center", 中: "center", center: "center",
  右: "right", 右对齐: "right", right: "right",
  两端: "both", 两端对齐: "both", both: "both", justify: "both",
  分散: "distribute", 分散对齐: "distribute", distribute: "distribute",
};
const COLOR_NAMES = {
  红: "FF0000", 红色: "FF0000", 蓝: "0070C0", 蓝色: "0070C0", 绿: "00B050", 绿色: "00B050",
  灰: "808080", 灰色: "808080", 浅灰: "A6A6A6", 黑: "000000", 黑色: "000000", 橙: "ED7D31",
};

function toPt(v) {
  const s = String(v === undefined || v === null ? "" : v).trim().replace(/[pP][tT]$/, "");
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  if (SIZE_NAMES[s]) return SIZE_NAMES[s];
  return 0;
}

function toColor(v) {
  const s = String(v || "").trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(s)) return s.toUpperCase();
  return COLOR_NAMES[s] || "";
}

function defaultStyle() {
  return {
    font: "微软雅黑", size: 12, line: 1.5, before: 0, after: 4,
    align: "", firstLine: 0, left: 0, color: "",
    titleFont: "", titleSize: 20, titleAlign: "center",
  };
}

/* 段落级覆盖：{16|居中|缩进2|加粗|行距1.5} 这种花括号前缀 */
function parseInlineOpts(spec) {
  const o = {};
  const parts = String(spec).split(/[|｜,，;；\s]+/).filter(Boolean);
  let m;
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    if ((m = /^(字号|size)[:：]?(.+)$/i.exec(p))) { const v = toPt(m[2]); if (v) o.size = v; continue; }
    if ((m = /^(字体|font)[:：]?(.+)$/i.exec(p))) { o.font = m[2].trim(); continue; }
    if ((m = /^(颜色|color)[:：]?(.+)$/i.exec(p))) { const c = toColor(m[2]); if (c) o.color = c; continue; }
    if ((m = /^行距([\d.]+)$/.exec(p)) || (m = /^line[:：]?([\d.]+)$/i.exec(p))) { const v = Number(m[1] || m[2]); if (v > 0) o.line = v; continue; }
    if ((m = /^段前([\d.]+)$/.exec(p))) { o.before = Number(m[1]); continue; }
    if ((m = /^段后([\d.]+)$/.exec(p))) { o.after = Number(m[1]); continue; }
    if ((m = /^左缩进([\d.]+)$/.exec(p))) { o.left = Number(m[1]); continue; }
    if ((m = /^缩进([\d.]+)$/.exec(p))) { o.firstLine = Number(m[1]); continue; }
    if (/^\d+(\.\d+)?(pt)?$/i.test(p)) { o.size = Number(p.replace(/pt$/i, "")); continue; }
    if (SIZE_NAMES[p]) { o.size = SIZE_NAMES[p]; continue; }
    if (ALIGN_MAP[p] || ALIGN_MAP[p.toLowerCase()]) { o.align = ALIGN_MAP[p] || ALIGN_MAP[p.toLowerCase()]; continue; }
    if (/^(加粗|粗体|bold|b)$/i.test(p)) { o.bold = true; continue; }
    if (/^(斜体|italic|i)$/i.test(p)) { o.italic = true; continue; }
    if (/^(下划线|underline|u)$/i.test(p)) { o.underline = true; continue; }
    if (/^(删除线|strike|del)$/i.test(p)) { o.strike = true; continue; }
  }
  return o;
}

/* 整篇指令行：!字号 12 / !行距 1.75 / !首行缩进 2 ... 不占正文 */
function applyDirective(st, line) {
  const m = /^\s*[!！@]\s*([^\s:：]{1,8})\s*[:：]?\s*(.*)$/.exec(line);
  if (!m) return false;
  const k = m[1].toLowerCase();
  const v = m[2].trim();
  const ptv = toPt(v);
  const align = ALIGN_MAP[v] || ALIGN_MAP[v.toLowerCase()];
  if (["字体", "font"].includes(k)) { if (v) st.font = v; return true; }
  if (["字号", "size"].includes(k)) { if (ptv) st.size = ptv; return true; }
  if (["标题字体", "titlefont"].includes(k)) { if (v) st.titleFont = v; return true; }
  if (["标题字号", "titlesize"].includes(k)) { if (ptv) st.titleSize = ptv; return true; }
  if (["标题对齐", "titlealign"].includes(k)) { if (align) st.titleAlign = align; return true; }
  if (["行距", "line"].includes(k)) { if (ptv) st.line = ptv; return true; }
  if (["段前", "before"].includes(k)) { if (ptv) st.before = ptv; return true; }
  if (["段后", "after"].includes(k)) { if (ptv) st.after = ptv; return true; }
  if (["首行缩进", "缩进", "indent"].includes(k)) { if (ptv) st.firstLine = ptv; return true; }
  if (["左缩进", "left"].includes(k)) { if (ptv) st.left = ptv; return true; }
  if (["对齐", "align"].includes(k)) { if (align) st.align = align; return true; }
  if (["颜色", "color"].includes(k)) { const c = toColor(v); if (c) st.color = c; return true; }
  return false;
}

/* ---------------- docx ---------------- */
function runProps(o) {
  const font = o.font || "微软雅黑";
  const sz = Math.max(1, Math.round((o.size || 12) * 2));       // 半磅
  let s = '<w:rPr><w:rFonts w:ascii="' + esc(font) + '" w:eastAsia="' + esc(font) + '" w:hAnsi="' + esc(font) + '"/>';
  if (o.bold) s += "<w:b/><w:bCs/>";
  if (o.italic) s += "<w:i/><w:iCs/>";
  if (o.underline) s += '<w:u w:val="single"/>';
  if (o.strike) s += "<w:strike/>";
  if (o.color) s += '<w:color w:val="' + o.color + '"/>';
  s += '<w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/></w:rPr>';
  return s;
}

/* 行内标记：**加粗**  *斜体*  __下划线__  ~~删除线~~ */
function parseInline(str) {
  const out = [];
  const re = /\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+?)\*|~~([\s\S]+?)~~/g;
  let last = 0, m;
  while ((m = re.exec(str))) {
    if (m.index > last) out.push({ text: str.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ text: m[1], bold: true });
    else if (m[2] !== undefined) out.push({ text: m[2], underline: true });
    else if (m[3] !== undefined) out.push({ text: m[3], italic: true });
    else if (m[4] !== undefined) out.push({ text: m[4], strike: true });
    last = re.lastIndex;
  }
  if (last < str.length) out.push({ text: str.slice(last) });
  return out.length ? out : [{ text: "" }];
}

function paraXml(text, opt) {
  const o = opt || {};
  const size = o.size || 12;
  const line = o.line || 1.5;
  const before = Math.round((o.before || 0) * 20);
  const after = Math.round((o.after == null ? 4 : o.after) * 20);
  const jc = o.align ? '<w:jc w:val="' + o.align + '"/>' : "";
  let indAttr = "";
  if (o.firstLine) {
    indAttr += ' w:firstLine="' + Math.round(o.firstLine * size * 20) + '" w:firstLineChars="' + Math.round(o.firstLine * 100) + '"';
  }
  if (o.left) {
    indAttr += ' w:left="' + Math.round(o.left * size * 20) + '" w:leftChars="' + Math.round(o.left * 100) + '"';
  }
  const ind = indAttr ? "<w:ind" + indAttr + "/>" : "";
  const pPr = '<w:pPr><w:spacing w:before="' + before + '" w:after="' + after +
    '" w:line="' + Math.round(240 * line) + '" w:lineRule="auto"/>' + ind + jc + "</w:pPr>";
  const body = String(text === undefined || text === null ? "" : text);
  if (!body) return "<w:p>" + pPr + "</w:p>";
  const runs = body.split("\n").map((seg, i) => {
    const br = i ? "<w:r><w:br/></w:r>" : "";
    const r = parseInline(seg).map((piece) =>
      '<w:r>' + runProps(Object.assign({}, o, piece)) +
      '<w:t xml:space="preserve">' + esc(piece.text) + "</w:t></w:r>").join("");
    return br + r;
  }).join("");
  return "<w:p>" + pPr + runs + "</w:p>";
}

function renderBody(text, style) {
  const st = style || defaultStyle();
  const base = () => ({
    font: st.font, size: st.size, line: st.line,
    before: st.before, after: st.after,
    firstLine: st.firstLine, left: st.left,
    align: st.align, color: st.color,
  });
  const lines = String(text === undefined || text === null ? "" : text).replace(/\r\n/g, "\n").split("\n");
  const out = [];

  for (const raw of lines) {
    // 每行都重新算：指令行会改动 st，后面的段落要立刻用上新设置
    const tSize = st.titleSize || 20;
    const tFont = st.titleFont || st.font;
    let line = raw.replace(/\s+$/, "");
    if (!line.trim()) { out.push(paraXml("", Object.assign(base(), { before: 0, after: 0 }))); continue; }
    if (applyDirective(st, line)) continue;                 // 指令行只改设置，不进正文

    // 单段覆盖：{16|居中} 前缀
    const bm = /^\s*\{([^{}]{1,120})\}\s*/.exec(line);
    const ov = bm ? parseInlineOpts(bm[1]) : {};
    if (bm) line = line.slice(bm[0].length);
    const o = Object.assign(base(), ov);
    // 居中/右对齐的段落不该再带首行缩进
    if (o.align && o.align !== "left" && o.align !== "both" && ov.firstLine === undefined) o.firstLine = 0;

    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      const lvl = m[1].length;
      const sizes = [tSize, Math.max(tSize - 4, 12), Math.max(tSize - 6, 10.5),
        Math.max(tSize - 7, 10), Math.max(tSize - 8, 10), Math.max(tSize - 9, 9)];
      out.push(paraXml(m[2], Object.assign({}, o, {
        font: tFont, size: sizes[lvl - 1], bold: true, firstLine: 0, left: 0,
        align: lvl === 1 ? (st.titleAlign || "center") : (ov.align || st.align),
        before: lvl <= 2 ? 10 : 8, after: lvl === 1 ? 12 : 6,
      })));
    } else if ((m = /^[-*+•]\s+(.*)$/.exec(line))) {
      out.push(paraXml("• " + m[1], Object.assign({}, o, { left: st.left + 1.5, firstLine: 0, after: 2 })));
    } else if ((m = /^(\d+[.、)])\s+(.*)$/.exec(line))) {
      out.push(paraXml(m[1] + " " + m[2], Object.assign({}, o, { left: st.left + 1.5, firstLine: 0, after: 2 })));
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      out.push(paraXml(m[1], Object.assign({}, o, { left: st.left + 2, firstLine: 0, color: o.color || "595959", after: 2 })));
    } else if (/^[-=]{3,}$/.test(line.trim())) {
      out.push(paraXml("————————————————————", Object.assign({}, o, { align: "center", firstLine: 0, after: 6 })));
    } else {
      out.push(paraXml(line, o));
    }
  }
  return out.join("");
}

function buildDocx(text, opts) {
  let entries = loadTemplate("docx");
  if (!entries) entries = minimalDocxEntries();
  const doc = entries.find((e) => e.name === "word/document.xml");
  if (!doc) throw new Error("docx 模板缺少 word/document.xml");
  let xml = doc.data.toString("utf8");
  const m = /(<w:body[^>]*>)([\s\S]*)(<\/w:body>)/.exec(xml);
  if (!m) throw new Error("docx 模板结构无法识别");
  const sect = /<w:sectPr[\s\S]*?<\/w:sectPr>/.exec(m[2]);
  const style = defaultStyle();
  if (opts && typeof opts === "object") {
    if (opts.font) style.font = String(opts.font);
    if (toPt(opts.size || opts.fontSize)) style.size = toPt(opts.size || opts.fontSize);
    if (toPt(opts.line || opts.lineSpacing)) style.line = toPt(opts.line || opts.lineSpacing);
    if (toPt(opts.indent) || opts.indent === 0) style.firstLine = toPt(opts.indent);
    const al = ALIGN_MAP[opts.align] || ALIGN_MAP[String(opts.align || "").toLowerCase()];
    if (al) style.align = al;
  }
  const body = renderBody(text, style) + (sect ? sect[0] : "");
  xml = xml.slice(0, m.index) + m[1] + body + m[3] + xml.slice(m.index + m[0].length);
  doc.data = Buffer.from(xml, "utf8");
  return writeZip(entries);
}

function minimalDocxEntries() {
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  const doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"/></w:sectPr></w:body></w:document>';
  return [
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rels, "utf8") },
    { name: "word/document.xml", data: Buffer.from(doc, "utf8") },
  ];
}

/* ---------------- xlsx ---------------- */
function colName(i) {
  let s = "", n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return w;
}

function buildXlsx(text, opts) {
  let entries = loadTemplate("xlsx");
  if (!entries) throw new Error("找不到 xlsx 模板，无法生成表格");
  const sheet = entries.find((e) => e.name === "xl/worksheets/sheet1.xml");
  const styles = entries.find((e) => e.name === "xl/styles.xml");
  if (!sheet) throw new Error("xlsx 模板缺少 sheet1.xml");

  const o = opts || {};
  const size = Number(o.size) || Number(o.fontSize) || 11;
  const border = o.border !== false;                  // 默认带细边框
  const headerBold = o.headerBold !== false;          // 默认首行加粗

  // 样式下标：0 普通 / 1 普通+边框 / 2 粗+边框+居中 / 3 粗+居中 / 4 普通+边框
  const idHead = border ? 2 : 3;
  const idBody = border ? 1 : 0;

  const rows = String(text === undefined || text === null ? "" : text)
    .replace(/\r\n/g, "\n").split("\n").map((l) => l.split("\t"));
  let maxCol = 1;
  const widths = [];
  const rowsXml = rows.map((cells, ri) => {
    maxCol = Math.max(maxCol, cells.length);
    cells.forEach((c, ci) => {
      widths[ci] = Math.max(widths[ci] || 8, Math.min(dispWidth(String(c)) + 4, 60));
    });
    const isHead = ri === 0 && headerBold && cells.some((c) => String(c).trim());
    const s = isHead ? idHead : idBody;
    const cs = cells.map((c, ci) => {
      const v = String(c);
      const ref = colName(ci) + (ri + 1);
      if (!v.trim()) return '<c r="' + ref + '" s="' + s + '"/>';
      if (/^-?\d+(\.\d+)?$/.test(v.trim()) && Math.abs(Number(v)) < 1e15) {
        return '<c r="' + ref + '" s="' + s + '"><v>' + v.trim() + "</v></c>";
      }
      return '<c r="' + ref + '" s="' + s + '" t="inlineStr"><is><t xml:space="preserve">' + esc(v) + "</t></is></c>";
    }).join("");
    return '<row r="' + (ri + 1) + '">' + cs + "</row>";
  }).join("");

  let xml = sheet.data.toString("utf8");
  const dim = "A1:" + colName(maxCol - 1) + Math.max(1, rows.length);
  if (/<dimension[^>]*\/>/.test(xml)) xml = xml.replace(/<dimension[^>]*\/>/, '<dimension ref="' + dim + '"/>');
  else xml = xml.replace(/(<worksheet[^>]*>)/, "$1" + '<dimension ref="' + dim + '"/>');

  // 列宽按内容估：中文字符算 2 个宽度
  const colsXml = "<cols>" + widths.map((w, i) =>
    '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + Math.max(6, w) + '" customWidth="1"/>'
  ).join("") + "</cols>";
  xml = xml.replace(/<cols>[\s\S]*?<\/cols>/g, "");
  if (/<sheetData\s*\/>/.test(xml)) {
    xml = xml.replace(/<sheetData\s*\/>/, colsXml + "<sheetData>" + rowsXml + "</sheetData>");
  } else {
    xml = xml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, colsXml + "<sheetData>" + rowsXml + "</sheetData>");
  }
  sheet.data = Buffer.from(xml, "utf8");

  // 重写样式表：字号、表头加粗、细边框
  if (styles) {
    const fonts = '<fonts count="2">' +
      '<font><sz val="' + size + '"/><name val="Calibri"/><name val="微软雅黑"/></font>' +
      '<font><b/><sz val="' + size + '"/><name val="Calibri"/><name val="微软雅黑"/></font>' +
      "</fonts>";
    const fills = '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>';
    const edge = ['left', 'right', 'top', 'bottom'].map((k) =>
      "<" + k + ' style="thin"><color indexed="64"/></' + k + ">").join("");
    const borders = '<borders count="2"><border/><border>' + edge + "<diagonal/></border></borders>";
    const styleXfs = '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>';
    const xfs = '<cellXfs count="5">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>' +
      "</cellXfs>";
    const cellStyles = '<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>';
    const st = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      fonts + fills + borders + styleXfs + xfs + cellStyles + "</styleSheet>";
    styles.data = Buffer.from(st, "utf8");
  }
  return writeZip(entries);
}

/* ---------------- 读取 ---------------- */
function readDocx(file) {
  const entries = readZip(file);
  const doc = entries.find((e) => e.name === "word/document.xml");
  if (!doc) throw new Error("不是有效的 docx");
  const xml = doc.data.toString("utf8");
  const out = [];
  const paras = xml.split(/<\/w:p>/);
  for (const p of paras) {
    const texts = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]);
    const brs = (p.match(/<w:br\s*\/>/g) || []).length;
    let line = texts.join("").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    if (line || brs) out.push(line);
    else out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function readXlsx(file) {
  const entries = readZip(file);
  const shared = entries.find((e) => e.name === "xl/sharedStrings.xml");
  let sharedList = [];
  if (shared) {
    sharedList = [...shared.data.toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
      [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join("")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    );
  }
  const out = [];
  for (const e of entries) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)) continue;
    const xml = e.data.toString("utf8");
    out.push("[" + e.name.split("/").pop() + "]");
    for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cm of rm[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const tm = /\st="([^"]*)"/.exec(cm[1]);
        const type = tm ? tm[1] : "";
        const body = cm[2];
        let v = "";
        if (type === "inlineStr") {
          v = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join("");
        } else {
          const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
          v = vm ? vm[1] : "";
          if (type === "s") v = sharedList[Number(v)] || "";
        }
        cells.push(String(v).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
      }
      out.push(cells.join("\t"));
    }
  }
  return out.join("\n");
}

/* ---------------- pptx ---------------- */
/* 版式策略：不用模板里的占位符（那是「标题幻灯片」版式，正文会居中一团），
   直接自绘两个文本框——标题在上居中、正文在下左对齐，每页都稳定。 */
const EMU = 914400;                     // 1 英寸
function pptTextSp(id, name, x, y, cx, cy, paras, anchor) {
  const bodyPr = '<a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="' + (anchor || "t") + '"><a:normAutofit/></a:bodyPr>';
  return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + esc(name) + '"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
    + '<p:spPr><a:xfrm><a:off x="' + Math.round(x) + '" y="' + Math.round(y) + '"/><a:ext cx="' + Math.round(cx) + '" cy="' + Math.round(cy) + '"/></a:xfrm>'
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>'
    + '<p:txBody>' + bodyPr + '<a:lstStyle/>' + paras + '</p:txBody></p:sp>';
}

function pptPara(text, opt) {
  const o = opt || {};
  const sz = Math.round((o.size || 20) * 100);
  const pPr = o.bullet
    ? '<a:pPr marL="285750" indent="-285750"><a:spcBef><a:spcPts val="600"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>'
    : '<a:pPr><a:spcBef><a:spcPts val="' + (o.before == null ? 600 : o.before) + '"/></a:spcBef><a:buNone/></a:pPr>';
  const rPr = '<a:rPr lang="zh-CN" altLang="en-US" sz="' + sz + '"' + (o.bold ? ' b="1"' : "")
    + (o.color ? '><a:solidFill><a:srgbClr val="' + o.color + '"/></a:solidFill></a:rPr>' : "/>");
  return '<a:p>' + pPr + '<a:r>' + rPr + '<a:t>' + esc(text) + '</a:t></a:r></a:p>';
}

function pptSlideXml(slide, isCover) {
  const W = 12192000, H = 6858000;
  const margin = Math.round(EMU * 0.75);
  const parasTitle = pptPara(slide.title || "", { size: isCover ? 40 : 32, bold: true });
  // 正文自动缩字号：行多就小一点，避免溢出
  const n = slide.body.length;
  const bodySize = n > 9 ? 14 : n > 6 ? 16 : 18;
  const parasBody = slide.body.map((l) => {
    if (/^[-*+•]\s+/.test(l)) return pptPara(l.replace(/^[-*+•]\s+/, ""), { size: bodySize, bullet: true });
    return pptPara(l, { size: bodySize, before: 300 });
  }).join("");

  const titleY = isCover ? Math.round(H * 0.32) : Math.round(EMU * 0.42);
  const titleH = isCover ? EMU * 1.6 : EMU * 1.0;
  const bodyY = isCover ? Math.round(H * 0.52) : Math.round(EMU * 1.75);
  const bodyH = H - bodyY - margin;

  const shapes = pptTextSp(2, "标题", margin, titleY, W - margin * 2, titleH, parasTitle, "ctr")
    + (parasBody ? pptTextSp(3, "正文", margin, bodyY, W - margin * 2, bodyH, parasBody, "t") : "");

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
    + '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
    + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
    + '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
    + shapes
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
}

/* 文本 → 幻灯片数组：`# 标题` 开新页，`---` 强制分页，`- 要点` 变成项目符号 */
function parseSlides(text) {
  const lines = String(text === undefined || text === null ? "" : text).replace(/\r\n/g, "\n").split("\n");
  const slides = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (/^-{3,}\s*$/.test(line.trim())) { cur = null; continue; }
    if (/^!/.test(line.trim())) continue;              // 排版指令行不放进 PPT
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (m) { cur = { title: m[1].trim(), body: [] }; slides.push(cur); continue; }
    if (!cur) { cur = { title: "", body: [] }; slides.push(cur); }
    cur.body.push(line.trim());
  }
  return slides.filter((s) => s.title || s.body.length);
}

function buildPptx(text) {
  let entries = loadTemplate("pptx");
  if (!entries) throw new Error("找不到 pptx 模板（" + path.join(TEMPLATE_DIR, "blank.pptx") + "）");
  const slides = parseSlides(text);
  if (!slides.length) throw new Error("内容为空，没有可生成的幻灯片");

  const tpl = entries.find((e) => e.name === "ppt/slides/slide1.xml");
  if (!tpl) throw new Error("pptx 模板缺少 slide1.xml");
  const tplRels = entries.find((e) => e.name === "ppt/slides/_rels/slide1.xml.rels");
  const layoutTarget = tplRels
    ? (/Target="([^"]*slideLayout\d+\.xml)"/.exec(tplRels.data.toString("utf8")) || [])[1] || "../slideLayouts/slideLayout1.xml"
    : "../slideLayouts/slideLayout1.xml";

  // 1) 写每页 slide xml
  slides.forEach((s, i) => {
    const name = "ppt/slides/slide" + (i + 1) + ".xml";
    const data = Buffer.from(pptSlideXml(s, i === 0 && slides.length > 1), "utf8");
    const old = entries.find((e) => e.name === name);
    if (old) old.data = data;
    else entries.push({ name, data });
  });
  // 2) 每页 rels：只保留指向 layout 的关系（模板里的 tags 关系不要了）
  slides.forEach((s, i) => {
    const name = "ppt/slides/_rels/slide" + (i + 1) + ".xml.rels";
    const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="' + layoutTarget + '"/>'
      + "</Relationships>";
    const data = Buffer.from(rels, "utf8");
    const old = entries.find((e) => e.name === name);
    if (old) old.data = data;
    else entries.push({ name, data });
  });

  // 3) presentation.xml：重建 sldIdLst
  const pres = entries.find((e) => e.name === "ppt/presentation.xml");
  if (!pres) throw new Error("pptx 模板缺少 presentation.xml");
  let presXml = pres.data.toString("utf8");
  const presRels = entries.find((e) => e.name === "ppt/_rels/presentation.xml.rels");
  if (!presRels) throw new Error("pptx 模板缺少 presentation.xml.rels");
  let relsXml = presRels.data.toString("utf8");

  // 找出已被占用的 rId 编号，新的从最大 +1 开始
  const usedIds = [...relsXml.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  let nextRid = (usedIds.length ? Math.max(...usedIds) : 0) + 1;

  const sldIds = [];
  slides.forEach((s, i) => {
    const rid = "rId" + nextRid++;
    sldIds.push('<p:sldId id="' + (256 + i) + '" r:id="' + rid + '"/>');
    relsXml = relsXml.replace("</Relationships>",
      '<Relationship Id="' + rid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide' + (i + 1) + '.xml"/></Relationships>');
  });
  presXml = /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/.test(presXml)
    ? presXml.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, "<p:sldIdLst>" + sldIds.join("") + "</p:sldIdLst>")
    : presXml.replace("<p:sldMasterIdLst>", "<p:sldIdLst>" + sldIds.join("") + "</p:sldIdLst><p:sldMasterIdLst>");
  pres.data = Buffer.from(presXml, "utf8");
  presRels.data = Buffer.from(relsXml, "utf8");

  // 4) [Content_Types].xml：给每页加 Override
  const ct = entries.find((e) => e.name === "[Content_Types].xml");
  if (ct) {
    let ctXml = ct.data.toString("utf8");
    slides.forEach((s, i) => {
      const part = "/ppt/slides/slide" + (i + 1) + ".xml";
      if (!ctXml.includes('PartName="' + part + '"')) {
        ctXml = ctXml.replace("</Types>",
          '<Override PartName="' + part + '" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>');
      }
    });
    ct.data = Buffer.from(ctXml, "utf8");
  }

  // 5) 删掉多余的 slide（原模板只有 1 页，若生成页数更少要清理）
  const keep = new Set(slides.map((s, i) => "ppt/slides/slide" + (i + 1) + ".xml"));
  entries = entries.filter((e) => {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(e.name) && !keep.has(e.name)) return false;
    if (/^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(e.name)) {
      const n = e.name.replace("_rels/", "").replace(".rels", "");
      return keep.has("ppt/slides/" + n);
    }
    return true;
  });

  return writeZip(entries);
}

function readOffice(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".docx") return readDocx(file);
  if (ext === ".xlsx") return readXlsx(file);
  if (ext === ".pptx") {
    const entries = readZip(file);
    const out = [];
    const slides = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
    slides.forEach((s, i) => {
      const xml = s.data.toString("utf8");
      const t = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join("\n");
      if (t.trim()) out.push("[第" + (i + 1) + "页]\n" + t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
    });
    return out.join("\n\n");
  }
  throw new Error("不支持的格式：" + ext);
}

module.exports = { buildDocx, buildXlsx, buildPptx, readOffice, readZip, writeZip, parseSlides, TEMPLATE_DIR };
