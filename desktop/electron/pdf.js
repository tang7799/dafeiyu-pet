/* 轻量 PDF 文本提取：不依赖任何第三方库
   思路：拆对象 → 解 FlateDecode → 遍历页面内容流 → 按 Tj/TJ 取字符串 →
        用字体的 ToUnicode CMap 把 CID 还原成 Unicode。
   覆盖常见的中文 PDF（Identity-H + 嵌入子集字体 + ToUnicode）。
   不支持的：扫描件（无文字层）、加密 PDF、字体缺 ToUnicode 的（只能给出乱码提示）。 */

const fs = require("fs");
const zlib = require("zlib");

/* ---------------- 基础对象解析 ---------------- */

function decodeStream(dict, raw) {
  const filter = (dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/) || [])[1] || "";
  let data = raw;
  const filters = [...filter.matchAll(/\/(\w+)/g)].map((m) => m[1]);
  // 过滤器按顺序反向解
  for (const f of filters.reverse()) {
    if (f === "FlateDecode" || f === "Fl") {
      try { data = zlib.inflateSync(data); } catch (e) {
        try { data = zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch (e2) { return null; }
      }
    } else if (f === "ASCIIHexDecode") {
      const t = data.toString("latin1").replace(/[^0-9A-Fa-f]/g, "");
      const out = Buffer.alloc(Math.floor(t.length / 2));
      for (let i = 0; i < out.length; i++) out[i] = parseInt(t.substr(i * 2, 2), 16);
      data = out;
    } else if (f === "ASCII85Decode") {
      try { data = Buffer.from(data.toString("latin1").replace(/^<~|~>$/g, ""), "base64"); } catch (e) { return null; }
    } else {
      return null;      // 图片类过滤器（DCT/JPX）跟文字无关
    }
  }
  // PNG predictor 的 Flate 数据（少见）不额外处理
  return data;
}

function parseObjects(buf) {
  const s = buf.toString("latin1");
  const objs = new Map();
  const re = /(?:^|[\s>\]])(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  const starts = [];
  while ((m = re.exec(s))) starts.push({ num: Number(m[1]), at: m.index + m[0].indexOf(String(m[1])) });
  for (let i = 0; i < starts.length; i++) {
    const { num, at } = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1].at : s.length;
    let chunk = s.slice(at, Math.min(end, at + 8 * 1024 * 1024));
    const eo = chunk.lastIndexOf("endobj");
    if (eo > 0) chunk = chunk.slice(0, eo);
    const sm = /stream\r?\n?/.exec(chunk);
    if (sm && /\/Length|>>/.test(chunk.slice(0, sm.index))) {
      const dict = chunk.slice(0, sm.index);
      const dataStart = at + sm.index + sm[0].length;
      // 从原始 buffer 取流数据（latin1 与字节一一对应，偏移一致）
      const after = s.indexOf("endstream", dataStart);
      const objEnd = at + chunk.length;
      let dataEnd = after > 0 ? Math.min(after, objEnd) : objEnd;
      // 去掉 endstream 前的换行
      if (s[dataEnd - 1] === "\n") dataEnd--;
      if (s[dataEnd - 1] === "\r") dataEnd--;
      const raw = buf.slice(dataStart, dataEnd);
      objs.set(num, { dict, raw, data: null });
    } else {
      objs.set(num, { dict: chunk, raw: null, data: null });
    }
  }
  return objs;
}

function getStream(obj) {
  if (!obj) return null;
  if (obj.data !== null) return obj.data;
  if (!obj.raw) return null;
  obj.data = decodeStream(obj.dict, obj.raw);
  return obj.data;
}

function refNum(str) {
  const m = /(\d+)\s+\d+\s+R/.exec(str || "");
  return m ? Number(m[1]) : null;
}

/* ---------------- ToUnicode CMap ---------------- */

function hexToStr(h) {
  let out = "";
  for (let i = 0; i + 4 <= h.length; i += 4) {
    out += String.fromCharCode(parseInt(h.substr(i, 4), 16));
  }
  if (h.length % 4 === 2) out += String.fromCharCode(parseInt(h.substr(h.length - 2, 2), 16));
  return out;
}

function parseToUnicode(text) {
  const map = new Map();
  // bfchar：<src> <dst>
  for (const blk of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      map.set(parseInt(pair[1], 16), hexToStr(pair[2]));
    }
  }
  // bfrange：<lo> <hi> <dstStart> 或 <lo> <hi> [<d1> <d2> ...]
  for (const blk of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = blk[1];
    // 数组形式
    for (const m of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = parseInt(m[1], 16);
      const arr = [...m[3].matchAll(/<([0-9A-Fa-f]*)>/g)].map((x) => hexToStr(x[1]));
      arr.forEach((v, i) => map.set(lo + i, v));
    }
    // 连续形式（先剔除数组块，避免重复匹配）
    const plain = body.replace(/<[0-9A-Fa-f]+>\s*<[0-9A-Fa-f]+>\s*\[[\s\S]*?\]/g, "");
    for (const m of plain.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      const baseHex = m[3];
      const base = parseInt(baseHex, 16);
      const digits = baseHex.length;
      for (let c = lo; c <= hi && c - lo < 65536; c++) {
        let v = base + (c - lo);
        let hs = v.toString(16).toUpperCase().padStart(digits, "0");
        if (hs.length % 4) hs = hs.padStart(Math.ceil(hs.length / 4) * 4, "0");
        map.set(c, hexToStr(hs));
      }
    }
  }
  return map;
}

/* ---------------- 页面与内容流 ---------------- */

function resolveDict(objs, refOrInline) {
  if (!refOrInline) return null;
  const n = refNum(refOrInline);
  if (n !== null && objs.has(n)) return objs.get(n).dict;
  return refOrInline;
}

function collectPages(objs) {
  // 找 Catalog → Pages → Kids 递归
  let pages = [];
  let root = null;
  for (const [, o] of objs) {
    if (/\/Type\s*\/Catalog/.test(o.dict)) root = o.dict;
  }
  const walk = (dict, depth) => {
    if (!dict || depth > 24) return;
    if (/\/Type\s*\/Page\b/.test(dict) && !/\/Type\s*\/Pages/.test(dict)) { pages.push(dict); return; }
    const kids = /\/Kids\s*\[([\s\S]*?)\]/.exec(dict);
    if (!kids) return;
    for (const k of kids[1].matchAll(/(\d+)\s+\d+\s+R/g)) {
      const o = objs.get(Number(k[1]));
      if (o) walk(o.dict, depth + 1);
    }
  };
  const pagesRef = root ? /\/Pages\s+(\d+\s+\d+\s+R)/.exec(root) : null;
  if (pagesRef) {
    const o = objs.get(refNum(pagesRef[1]));
    if (o) walk(o.dict, 0);
  }
  if (!pages.length) {
    // 退化：按对象出现顺序抓 /Type /Page
    for (const [, o] of objs) if (/\/Type\s*\/Page\b/.test(o.dict) && !/\/Type\s*\/Pages/.test(o.dict)) pages.push(o.dict);
  }
  return pages;
}

function getContents(objs, pageDict) {
  const cm = /\/Contents\s*(\[[\s\S]*?\]|\d+\s+\d+\s+R)/.exec(pageDict);
  if (!cm) return [];
  const parts = [];
  for (const r of cm[1].matchAll(/(\d+)\s+\d+\s+R/g)) {
    const o = objs.get(Number(r[1]));
    const d = getStream(o);
    if (d) parts.push(d);
  }
  return parts;
}

/* 从字符串里取出 key 后面的完整 << ... >> 字典（按 << >> 配对，能处理嵌套） */
function extractDictAfter(str, key) {
  const i = str.indexOf(key);
  if (i < 0) return null;
  const j = str.indexOf("<<", i);
  if (j < 0) return null;
  let depth = 0;
  for (let k = j; k < str.length - 1; k++) {
    if (str.startsWith("<<", k)) { depth++; k++; }
    else if (str.startsWith(">>", k)) { depth--; k++; if (depth === 0) return str.slice(j, k + 1); }
  }
  return null;
}

function getPageFonts(objs, pageDict) {
  // Resources 可能是引用，也可能内联（内联时嵌套很深，必须配对取）
  let resDict = resolveDict(objs, (/\/Resources\s*(\d+\s+\d+\s+R)/.exec(pageDict) || [])[1]);
  if (!resDict || refNum(resDict) !== null) resDict = extractDictAfter(pageDict, "/Resources") || "";
  resDict = String(resDict);

  const fonts = new Map();          // /FT14 -> { twoByte, cmap }
  let fontDict = extractDictAfter(resDict, "/Font");
  if (!fontDict) {
    const fr = /\/Font\s*(\d+\s+\d+\s+R)/.exec(resDict);
    if (fr) fontDict = resolveDict(objs, fr[1]);
  }
  if (!fontDict) return fonts;
  for (const m of String(fontDict).matchAll(/\/([A-Za-z0-9_.+#-]+)\s+(\d+)\s+\d+\s+R/g)) {
    const name = "/" + m[1];
    const fo = objs.get(Number(m[2]));
    if (!fo) continue;
    const twoByte = /\/Subtype\s*\/Type0/.test(fo.dict) || /Identity-H/.test(fo.dict);
    let cmap = null;
    const tu = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(fo.dict);
    if (tu) {
      const cmObj = objs.get(Number(tu[1]));
      const cd = getStream(cmObj);
      if (cd) cmap = parseToUnicode(cd.toString("latin1"));
    }
    fonts.set(name, { twoByte, cmap });
  }
  return fonts;
}

/* ---------------- 内容流文字抽取 ---------------- */

function unescapePdfString(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (m, g) => {
    if (/^[0-7]+$/.test(g)) return String.fromCharCode(parseInt(g, 8));
    return { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" }[g] || g;
  });
}

function decodeText(bytes, font) {
  // bytes: 数组，每个元素 0-255
  const out = [];
  const two = font && font.twoByte;
  for (let i = 0; i < bytes.length;) {
    let code;
    if (two) { code = (bytes[i] << 8) | (bytes[i + 1] === undefined ? 0 : bytes[i + 1]); i += 2; }
    else { code = bytes[i]; i += 1; }
    const mapped = font && font.cmap ? font.cmap.get(code) : null;
    if (mapped !== undefined && mapped !== null) out.push(mapped);
    else if (!two && code >= 32 && code < 127) out.push(String.fromCharCode(code));
    else if (!two && code >= 0xa1) {
      // 单字节但非 ASCII：可能是 WinAnsi，尽力而为
      out.push(String.fromCharCode(code));
    } else out.push("");   // 拿不到映射就留空，避免输出乱码方块
  }
  return out.join("");
}

/* 把内容流拆成 token，按设备坐标把文字重组成行
   PDF 的文字位置经过 文本矩阵(Tm) × 图形变换矩阵(CTM) 两级变换，
   字号也会被缩放（很多导出工具用 0.1 的 cm 缩放，字号看着是 240 其实 24pt）。
   这里完整跟踪 q/Q/cm/Tm/Td/T*，换算出真实设备坐标和实际字号，
   否则判断换行会全部失效（整页挤成一行）。 */
function matMul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}
const IDENT = [1, 0, 0, 1, 0, 0];

function extractFromContent(content, fonts) {
  const text = content.toString("latin1");
  let cur = null;                       // 当前字体
  let size = 12;                        // Tf 字号（文本空间）
  let tmMat = IDENT.slice();            // 文本矩阵
  let leading = 14;
  let ctm = IDENT.slice();              // 图形变换矩阵
  const gsStack = [];                   // q/Q 栈
  const items = [];                     // { x, y, size, text }（设备坐标）

  const strToBytes = (s) => {
    const arr = [];
    for (let k = 0; k < s.length; k++) arr.push(s.charCodeAt(k) & 0xff);
    return arr;
  };
  const emit = (str) => {
    if (!str) return;
    const m = matMul(tmMat, ctm);
    const detTm = Math.abs(tmMat[0] * tmMat[3] - tmMat[1] * tmMat[2]);
    const detCt = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
    const effSize = size * Math.sqrt(detTm * detCt) || size;
    items.push({ x: m[4], y: m[5], size: effSize, text: str });
  };
  const translateTm = (tx, ty) => {
    tmMat = matMul([1, 0, 0, 1, tx, ty], tmMat);
  };

  let i = 0;
  const n = text.length;
  const stack = [];
  const arrStack = [];
  const push = (tok) => { stack.push(tok); if (arrStack.length) arrStack[arrStack.length - 1].v.push(tok); };

  const readLiteral = () => {
    let depth = 1, s = "", j = i + 1;
    while (j < n && depth > 0) {
      const ch = text[j];
      if (ch === "\\") { s += ch + (text[j + 1] || ""); j += 2; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) break; }
      s += ch; j++;
    }
    i = j + 1;
    return unescapePdfString(s);
  };
  const readHex = () => {
    const j = text.indexOf(">", i);
    const h = text.slice(i + 1, j < 0 ? n : j).replace(/[^0-9A-Fa-f]/g, "");
    i = j < 0 ? n : j + 1;
    return h;
  };

  while (i < n) {
    const ch = text[i];
    if (ch === "%") { const e = text.indexOf("\n", i); i = e < 0 ? n : e + 1; continue; }
    if (ch === "(") { push({ t: "str", v: readLiteral() }); continue; }
    if (ch === "<" && text[i + 1] !== "<") { push({ t: "hex", v: readHex() }); continue; }
    if (ch === "[") { const a = { t: "arr", v: [] }; i++; arrStack.push(a); push(a); continue; }
    if (ch === "]") { i++; arrStack.pop(); continue; }
    if (ch === "/") {
      const m = /^\/([A-Za-z0-9_.+#-]+)/.exec(text.slice(i, i + 80));
      push({ t: "name", v: m ? "/" + m[1] : "/" });
      i += m ? m[0].length : 1;
      continue;
    }
    if (/\s/.test(ch)) { i++; continue; }

    const om = /^([A-Za-z'"*]+|[-+]?\d*\.?\d+)/.exec(text.slice(i, i + 40));
    if (!om) { i++; continue; }
    const tok = om[1];
    i += tok.length;
    if (/^[-+]?\d*\.?\d+$/.test(tok)) { push({ t: "num", v: Number(tok) }); continue; }

    const pop = () => stack.pop();
    const numOf = (t) => (t && t.t === "num" ? t.v : 0);
    switch (tok) {
      case "q": gsStack.push({ ctm: ctm.slice() }); break;
      case "Q": { const g = gsStack.pop(); if (g) ctm = g.ctm; break; }
      case "cm": {
        const f = numOf(pop()), e = numOf(pop()), d = numOf(pop()), c = numOf(pop()), b = numOf(pop()), a = numOf(pop());
        ctm = matMul([a, b, c, d, e, f], ctm);
        break;
      }
      case "Tf": {
        const sz = pop(), name = pop();
        if (sz && sz.t === "num") size = sz.v;
        if (name && name.t === "name") cur = fonts.get(name.v) || null;
        break;
      }
      case "Tj": case "'": case '"': {
        const s = pop();
        if (tok !== "Tj") translateTm(0, -leading);
        if (s) {
          const bytes = s.t === "str" ? strToBytes(s.v) : s.t === "hex" ? hexToHexBytes(s.v) : [];
          emit(decodeText(bytes, cur));
        }
        break;
      }
      case "TJ": {
        const arr = pop();
        if (arr && arr.t === "arr") {
          for (const el of arr.v) {
            if (el.t === "num") {
              // 数字是 1/1000 em 的水平位移，负数=往右
              translateTm(-el.v / 1000 * size, 0);
            } else if (el.t === "str") emit(decodeText(strToBytes(el.v), cur));
            else if (el.t === "hex") emit(decodeText(hexToHexBytes(el.v), cur));
          }
        }
        break;
      }
      case "Td": case "TD": {
        const ty = numOf(pop()), tx = numOf(pop());
        translateTm(tx, ty);
        if (tok === "TD") leading = -ty;
        break;
      }
      case "TL": leading = Math.abs(numOf(pop())) || leading; break;
      case "T*": translateTm(0, -leading); break;
      case "Tm": {
        const f = numOf(pop()), e = numOf(pop()), d = numOf(pop()), c = numOf(pop()), b = numOf(pop()), a = numOf(pop());
        tmMat = [a, b, c, d, e, f];
        break;
      }
      case "BT": tmMat = IDENT.slice(); break;
      default: break;
    }
    if (stack.length > 60) stack.length = 0;
  }

  /* 按内容流顺序分组成行，再按「每行字符间距的中位数」判断哪里该补空格
     —— 中文/英文标题常是分散对齐（字距被均匀拉大），一律按间距补空格会变成
        「高 精 密 电 阻」，只有明显大于本行平均间距的间隔（表格列、词语间）才补。 */
  if (!items.length) return "";
  // 等宽近似：按字形宽窄估宽，统一 0.5em 会让窄字母（i/l）估宽、宽字母（m/W）估窄，间距算错
  const NARROW = "ijl.,;:'!|()[]{}`/\\\"";
  const WIDE = "mwMW@%&";
  const asciiW = (c) => {
    if (c === " ") return 0.278;
    if (NARROW.includes(c)) return 0.3;
    if (WIDE.includes(c)) return 0.85;
    if (/[A-Z]/.test(c)) return 0.68;
    if (/[a-z]/.test(c)) return 0.52;
    if (/[0-9]/.test(c)) return 0.556;
    return 0.5;
  };
  const charW = (c, sz) => (c.codePointAt(0) > 0x2e80 ? sz : sz * asciiW(c));
  const widthOf = (t, sz) => [...t].reduce((a, c) => a + charW(c, sz), 0);
  const median = (arr) => {
    if (!arr.length) return 0;
    const a = arr.slice().sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  };

  const lines = [];
  let curLine = null;
  for (const it of items) {
    const sz = it.size || 12;
    if (!curLine || Math.abs(it.y - curLine.y) > Math.max(1.5, (curLine.size || sz) * 0.6)) {
      curLine = { y: it.y, size: sz, items: [it] };
      lines.push(curLine);
    } else {
      curLine.items.push(it);
      curLine.size = Math.max(curLine.size, sz);
    }
  }

  const out = [];
  for (const ln of lines) {
    const gaps = [];
    for (let k = 1; k < ln.items.length; k++) {
      const prev = ln.items[k - 1];
      gaps.push(ln.items[k].x - (prev.x + widthOf(prev.text, prev.size)));
    }
    const med = median(gaps.filter((g) => g > -5));
    const avgSize = ln.size || 12;
    // 紧排（正常排版，字距≈0）：按小阈值保留词间空格和表格列间隔
    // 松排（分散对齐，字距被均匀拉大）：只有明显超出平均字距的间隔才算词/列边界
    const tight = med < avgSize * 0.12;
    let s = "";
    for (let k = 0; k < ln.items.length; k++) {
      const it = ln.items[k];
      if (k > 0) {
        const prev = ln.items[k - 1];
        const gap = it.x - (prev.x + widthOf(prev.text, prev.size));
        const thresh = tight ? Math.max(1.5, it.size * 0.2) : Math.max(med * 2.2, it.size * 1.1);
        if (gap > thresh) s += " ";
      }
      s += it.text;
    }
    const t = s.replace(/\s+$/, "");
    if (t.trim()) out.push(t);
  }
  return out.join("\n");
}

function hexToHexBytes(h) {
  const arr = [];
  for (let i = 0; i < h.length; i += 2) arr.push(parseInt(h.substr(i, 2) || "0", 16));
  return arr;
}

/* ---------------- 对外接口 ---------------- */

function readPdf(file, limitPages) {
  const buf = fs.readFileSync(file);
  if (buf.slice(0, 5).toString("latin1") !== "%PDF-") throw new Error("这不是有效的 PDF 文件（文件头不对）");
  if (/\/Encrypt\b/.test(buf.toString("latin1").slice(0, 4096))) {
    throw new Error("这份 PDF 加密了（有密码保护），读不出内容。可以让主人用 WPS 打开后另存一份不加密的");
  }
  const objs = parseObjects(buf);
  const pages = collectPages(objs);
  if (!pages.length) throw new Error("PDF 里找不到页面");
  const max = Math.min(pages.length, limitPages || 60);
  const parts = [];
  let emptyPages = 0;
  for (let i = 0; i < max; i++) {
    const fonts = getPageFonts(objs, pages[i]);
    const streams = getContents(objs, pages[i]);
    let t = "";
    for (const s of streams) t += extractFromContent(s, fonts);
    // 简单清洗：多余空行合并
    t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (t) parts.push("[第" + (i + 1) + "页]\n" + t);
    else emptyPages++;
  }
  return {
    pages: pages.length,
    readPages: max,
    text: parts.join("\n\n"),
    emptyPages,
  };
}

module.exports = { readPdf };
