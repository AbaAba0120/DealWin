/* 成交喜报海报生成器 — 渲染引擎 + 表单 + 贴纸/排版交互 */
"use strict";

/* ================= 字体 ================= */
const FONT_FAMILIES = {
  heavy: "PosterHeavy",
  medium: "PosterMedium",
  light: "PosterLight",
};

async function loadFonts() {
  const defs = [
    ["PosterHeavy", "fonts/SourceHanSansCN-Heavy-subset.woff2"],
    ["PosterMedium", "fonts/SourceHanSansCN-Medium-subset.woff2"],
    ["PosterLight", "fonts/SourceHanSansCN-Light-subset.woff2"],
  ];
  await Promise.all(
    defs.map(async ([name, url]) => {
      const face = new FontFace(name, `url(${url})`);
      await face.load();
      document.fonts.add(face);
    })
  );
}
/* ================= 版面常量 ================= */
// 成交照片区域 [x0,y0,x1,y1]
const DEAL_RECT = [1239, 658, 2342, 1318];
// 4 个项目照片模块区域
const MODULE_RECTS = [
  [138, 2523, 691, 3071],
  [691, 2523, 1241, 3071],
  [1241, 2523, 1792, 3071],
  [1792, 2523, 2341, 3071],
];
const MODULE_NAMES = ["线下门店推广", "线上推广拍摄", "空看OPEN HOUSE", "客户带看"];
const TILE_GAP = 8; // 模块内多图间隙(画布像素)
const MAX_MODULE_PHOTOS = 12; // 每个项目照片模块最多显示的照片数

// 预设网格:行配置,数字为该行的格子数
const GRID_PRESETS = {
  auto: null,
  full: [1],
  "2h": [2],
  "2v": [1, 1],
  "1+2": [1, 2],
  "2x2": [2, 2],
  "3x2": [3, 3],
  "3x3": [3, 3, 3],
  "4x4": [4, 4, 4],
};
const PRESET_LABELS = {
  auto: "自动",
  full: "满幅",
  "2h": "左右两格",
  "2v": "上下两格",
  "1+2": "上一下二",
  "2x2": "田字四格",
  "3x2": "六宫格",
  "3x3": "九宫格",
  "4x4": "十二宫格",
};

function autoPattern(n) {
  if (n <= 1) return [1];
  if (n === 2) return [2];
  if (n === 3) return [1, 2];
  if (n === 4) return [2, 2];
  if (n <= 6) return [3, 3];
  if (n === 7) return [3, 2, 2];
  if (n === 8) return [3, 3, 2];
  if (n === 9) return [3, 3, 3];
  if (n === 10) return [4, 3, 3];
  if (n === 11) return [4, 4, 3];
  return [4, 4, 4];
}

/* 按行配置把模块矩形切成格子 */
function gridRects(rect, pattern) {
  const [x0, y0, x1, y1] = rect;
  const rows = pattern.length;
  const rh = (y1 - y0 - TILE_GAP * (rows - 1)) / rows;
  const cells = [];
  pattern.forEach((cols, ri) => {
    const cw = (x1 - x0 - TILE_GAP * (cols - 1)) / cols;
    for (let ci = 0; ci < cols; ci++) {
      cells.push([
        x0 + ci * (cw + TILE_GAP),
        y0 + ri * (rh + TILE_GAP),
        cw,
        rh,
      ]);
    }
  });
  return cells;
}

/* ================= 表单字段配置 ================= */
const DEAL_IDS = {
  address: "项目信息/组 3/新陆花苑四平路460 弄1号1XXX室",
  price: "项目信息/组 3/775",
  period: "项目信息/组 3/11",
  bid: "项目信息/组 3/720",
  premium: "项目信息/组 3/55",
  premiumRate: "项目信息/组 3/7.64",
  dealDate: "项目信息/成交日期：2026年7月26日",
  rating: "对比信息/组 6/小区评级：C",
};
const ROW_LABELS = [
  "挂牌时长", "推广门店量", "影响经纪人数量", "短视频邀约拍摄量",
  "曝光量", "带看量", "出价量", "谈判量", "是否成交",
];

/* 把「标签：值」拆成固定前缀和可编辑值 */
function splitPrefix(text) {
  const candidates = [text.indexOf("："), text.indexOf(":")].filter((i) => i >= 0);
  if (!candidates.length) return null;
  const i = Math.min(...candidates);
  return [text.slice(0, i + 1), text.slice(i + 1)];
}

/* ================= 全局状态 ================= */
const NO_SHRINK_IDS = new Set(); // 禁用自动缩字号的文字图层 id
const state = {
  values: {},        // 文字图层 id -> 最终绘制文本
  dealPhoto: null,   // ImageBitmap
  stickers: [],      // {img, x, y, w, h, angle, el}
  modules: MODULE_RECTS.map(() => ({ photos: [], preset: "auto" })),
  mosaic: {
    enabled: false,
    brushSize: 80,   // 画布像素
    strokes: [],     // [{points: [[x,y],...], size}]
    maskCanvas: null,
    maskCtx: null,
  },
};
let layout, bgImg;
let scaleFactor = 1;
let overlayInner;

/* ================= 文字绘制 ================= */
/* 倒影文字(垂直翻转的图层):离屏绘制后加向下渐隐,再翻转贴回 */
function drawReflectedText(ctx, t, value, family) {
  const [xx, xy, yx, yy] = t.matrix;
  const size = t.fontSize;
  const pad = 20;
  const meas = document.createElement("canvas").getContext("2d");
  meas.font = `${size}px "${family}"`;
  const tw = Math.ceil(meas.measureText(value).width * Math.abs(xx)) + pad * 2;
  const th = Math.ceil(size * 1.35) + pad * 2;
  const tmp = document.createElement("canvas");
  tmp.width = tw;
  tmp.height = th;
  const tctx = tmp.getContext("2d");
  tctx.font = `${size}px "${family}"`;
  tctx.fillStyle = t.color;
  tctx.textBaseline = "alphabetic";
  tctx.fillText(value, pad, pad + size);
  // 离基线越远越透明(翻转后表现为倒影向下渐隐)
  const grad = tctx.createLinearGradient(0, 0, 0, pad + size);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,1)");
  tctx.globalCompositeOperation = "destination-in";
  tctx.fillStyle = grad;
  tctx.fillRect(0, 0, tw, th);
  ctx.save();
  ctx.globalAlpha = t.opacity;
  ctx.setTransform(xx, xy, yx, yy, t.x - xx * pad, t.y - yy * (pad + size));
  ctx.drawImage(tmp, 0, 0);
  ctx.restore();
}

function drawTexts(ctx) {
  for (const t of layout.texts) {
    const value = state.values[t.id] !== undefined ? state.values[t.id] : t.text;
    if (!value) continue;
    const [xx, xy, yx, yy] = t.matrix;
    const family = FONT_FAMILIES[t.font] || FONT_FAMILIES.medium;
    if (yy < 0) {
      drawReflectedText(ctx, t, value, family);
      continue;
    }
    ctx.save();
    ctx.globalAlpha = t.opacity;
    ctx.transform(xx, xy, yx, yy, t.x, t.y);
    ctx.fillStyle = t.color;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = t.align || "left";
    let size = t.fontSize;
    ctx.font = `${size}px "${family}"`;
    const maxW = (t.bbox[2] - t.bbox[0]) * 1.06;
    const w = ctx.measureText(value).width;
    if (!NO_SHRINK_IDS.has(t.id) && w > maxW && w > 0) {
      size = (size * maxW) / w;
      ctx.font = `${size}px "${family}"`;
    }
    ctx.fillText(value, 0, 0);
    ctx.restore();
  }
}

function drawCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale;
  const sh = h / scale;
  const sx = (img.width - sw) / 2;
  const sy = (img.height - sh) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  ctx.restore();
}

/* 预览画布:背景 + 文字(照片和贴纸以 DOM 层显示) */
function redraw() {
  const canvas = document.getElementById("poster");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, layout.width, layout.height);
  ctx.drawImage(bgImg, 0, 0);
  drawTexts(ctx);
}

/* 导出完整海报 */
function applyMosaic(ctx, canvas) {
  if (!state.mosaic.maskCanvas || !state.mosaic.strokes.length) return;
  const w = canvas.width, h = canvas.height;
  const mask = state.mosaic.maskCanvas;

  // 1. 复制当前 canvas 内容（背景+照片）到临时 canvas
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext("2d");
  tctx.drawImage(canvas, 0, 0);

  // 2. 像素化：缩小再放大，关闭平滑
  const pixelSize = 16;
  const small = document.createElement("canvas");
  small.width = Math.ceil(w / pixelSize);
  small.height = Math.ceil(h / pixelSize);
  const sctx = small.getContext("2d");
  sctx.imageSmoothingEnabled = false;
  sctx.drawImage(tmp, 0, 0, small.width, small.height);
  tctx.imageSmoothingEnabled = false;
  tctx.clearRect(0, 0, w, h);
  tctx.drawImage(small, 0, 0, w, h);

  // 3. 用 mask 做遮罩，只保留涂抹区域
  const masked = document.createElement("canvas");
  masked.width = w;
  masked.height = h;
  const mctx = masked.getContext("2d");
  mctx.drawImage(tmp, 0, 0);
  mctx.globalCompositeOperation = "destination-in";
  mctx.drawImage(mask, 0, 0);

  // 4. 画回主 canvas
  ctx.drawImage(masked, 0, 0);
}

function composePoster() {
  const canvas = document.createElement("canvas");
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bgImg, 0, 0);
  if (state.dealPhoto) {
    drawCover(ctx, state.dealPhoto, ...rectToXYWH(DEAL_RECT));
  }
  for (const mod of state.modules) {
    for (const p of mod.photos) {
      drawCover(ctx, p.img, p.x, p.y, p.w, p.h);
    }
  }
  applyMosaic(ctx, canvas);
  for (const s of state.stickers) {
    ctx.save();
    ctx.translate(s.x + s.w / 2, s.y + s.h / 2);
    if (s.angle) ctx.rotate((s.angle * Math.PI) / 180);
    ctx.drawImage(s.img, -s.w / 2, -s.h / 2, s.w, s.h);
    ctx.restore();
  }
  drawTexts(ctx);
  return canvas;
}

function rectToXYWH([x0, y0, x1, y1]) {
  return [x0, y0, x1 - x0, y1 - y0];
}

/* ================= DOM 交互层 ================= */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function updateScale() {
  const stage = document.getElementById("stage");
  scaleFactor = stage.clientWidth / layout.width;
  overlayInner.style.transform = `scale(${scaleFactor})`;
}

function toCanvasDelta(dx, dy) {
  return [dx / scaleFactor, dy / scaleFactor];
}

/* 可拖拽/可缩放的通用元素(贴纸与照片格共用) */
function makeInteractive(el, obj, opts) {
  // 拖拽移动
  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".ctl")) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    selectEl(el);
    const sx = e.clientX, sy = e.clientY, ox = obj.x, oy = obj.y;
    const move = (ev) => {
      const [dx, dy] = toCanvasDelta(ev.clientX - sx, ev.clientY - sy);
      obj.x = ox + dx;
      obj.y = oy + dy;
      if (opts.clamp) {
        const [cx0, cy0, cx1, cy1] = opts.clamp;
        obj.x = Math.min(Math.max(obj.x, cx0), cx1 - obj.w);
        obj.y = Math.min(Math.max(obj.y, cy0), cy1 - obj.h);
      }
      positionEl(el, obj);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  });
  // 右下角缩放
  const handle = el.querySelector(".resize");
  if (handle) {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const sx = e.clientX, ow = obj.w;
      const ratio = obj.h / obj.w;
      const move = (ev) => {
        const [dx] = toCanvasDelta(ev.clientX - sx, 0);
        obj.w = Math.max(opts.minW || 60, ow + dx);
        obj.h = obj.w * ratio;
        positionEl(el, obj);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }
  // 左下角旋转
  const rotHandle = el.querySelector(".rotate");
  if (rotHandle) {
    rotHandle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      rotHandle.setPointerCapture(e.pointerId);
      const rect = overlayInner.getBoundingClientRect();
      const cxScreen = rect.left + (obj.x + obj.w / 2) * scaleFactor;
      const cyScreen = rect.top + (obj.y + obj.h / 2) * scaleFactor;
      const startAngle = Math.atan2(e.clientY - cyScreen, e.clientX - cxScreen);
      const startObjAngle = obj.angle || 0;
      const move = (ev) => {
        const curAngle = Math.atan2(ev.clientY - cyScreen, ev.clientX - cxScreen);
        let delta = (curAngle - startAngle) * 180 / Math.PI;
        obj.angle = (startObjAngle + delta) % 360;
        positionEl(el, obj);
      };
      const up = () => {
        rotHandle.removeEventListener("pointermove", move);
        rotHandle.removeEventListener("pointerup", up);
      };
      rotHandle.addEventListener("pointermove", move);
      rotHandle.addEventListener("pointerup", up);
    });
  }
}

function positionEl(el, obj) {
  el.style.left = obj.x + "px";
  el.style.top = obj.y + "px";
  el.style.width = obj.w + "px";
  el.style.height = obj.h + "px";
  if (obj.angle !== undefined) {
    el.style.transform = `rotate(${obj.angle}deg)`;
  }
}

function selectEl(el) {
  overlayInner.querySelectorAll(".selected").forEach((n) => n.classList.remove("selected"));
  if (el) el.classList.add("selected");
}

function addControls(el, onDelete, keepRatio) {
  const del = document.createElement("button");
  del.className = "ctl del";
  del.textContent = "×";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    onDelete();
  });
  el.appendChild(del);
  if (keepRatio !== false) {
    const rs = document.createElement("div");
    rs.className = "ctl resize";
    el.appendChild(rs);
    const rot = document.createElement("div");
    rot.className = "ctl rotate";
    el.appendChild(rot);
  }
}

/* ---------- 贴纸 ---------- */
async function addSticker(img, x, y, w) {
  const h = (w * img.naturalHeight || img.height) / (img.naturalWidth || img.width);
  const s = { img, x, y, w, h, angle: 0 };
  state.stickers.push(s);
  const el = document.createElement("div");
  el.className = "sticker";
  const im = document.createElement("img");
  im.src = img.src;
  im.draggable = false;
  el.appendChild(im);
  s.el = el;
  addControls(el, () => {
    state.stickers.splice(state.stickers.indexOf(s), 1);
    el.remove();
  });
  makeInteractive(el, s, { clamp: null, minW: 40 });
  positionEl(el, s);
  overlayInner.appendChild(el);
  selectEl(el);
}

/* ---------- 图片上传(文件选择/粘贴/拖拽共用) ---------- */
let statusTimer = null;
function showStatus(msg) {
  const el = document.getElementById("status");
  el.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (el.textContent = ""), 4000);
}

async function setDealPhotoFile(file) {
  state.dealPhoto = await createImageBitmap(file);
  state.dealPhotoUrl = URL.createObjectURL(file);
  renderDealPhoto();
}

async function addModulePhotoFile(mi, file) {
  if (state.modules[mi].photos.length >= MAX_MODULE_PHOTOS) {
    showStatus(`「${MODULE_NAMES[mi]}」最多 ${MAX_MODULE_PHOTOS} 张照片,多余图片已忽略`);
    return;
  }
  const bmp = await createImageBitmap(file);
  addModulePhoto(mi, bmp, URL.createObjectURL(file));
}

/* 从拖拽/粘贴事件里取图片文件 */
function pickImageFiles(fileList) {
  const files = [...(fileList || [])].filter((f) => f.type.startsWith("image/"));
  if (!files.length) showStatus("未识别到图片文件");
  return files;
}

/* 让某个元素成为拖拽落点 */
function makeDropTarget(el, onFiles) {
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    el.classList.add("drop-hover");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drop-hover"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("drop-hover");
    const files = pickImageFiles(e.dataTransfer?.files);
    if (files.length) onFiles(files);
  });
}

/* 粘贴目标:点击分区里的激活条后,Ctrl+V 的图片进入该分区 */
let pasteTarget = null;
function makePasteZone(fs, onFiles) {
  const zone = document.createElement("div");
  zone.className = "paste-zone";
  zone.textContent = "点击激活后,可 Ctrl+V 粘贴图片;也可直接把图片拖到这个分区";
  zone.addEventListener("click", () => {
    document.querySelectorAll(".paste-zone.active").forEach((z) => z.classList.remove("active"));
    zone.classList.add("active");
    pasteTarget = onFiles;
  });
  fs.appendChild(zone);
}

/* ---------- 成交照片 ---------- */
function renderDealPhoto() {
  let el = overlayInner.querySelector(".deal-tile");
  if (state.dealPhoto) {
    if (!el) {
      el = document.createElement("div");
      el.className = "tile deal-tile";
      overlayInner.insertBefore(el, overlayInner.firstChild);
    }
    const [x, y, w, h] = rectToXYWH(DEAL_RECT);
    positionEl(el, { x, y, w, h });
    el.style.backgroundImage = `url(${state.dealPhotoUrl})`;
    el.classList.remove("placeholder");
    el.textContent = "";
  } else if (el) {
    el.remove();
  }
}

/* ---------- 项目照片模块 ---------- */
function layoutModule(mi) {
  const mod = state.modules[mi];
  const n = mod.photos.length;
  if (!n) return;
  let pattern = GRID_PRESETS[mod.preset];
  const cellsNeeded = pattern ? pattern.reduce((a, b) => a + b, 0) : 0;
  if (!pattern || cellsNeeded < n) pattern = autoPattern(n);
  const cells = gridRects(MODULE_RECTS[mi], pattern);
  mod.photos.forEach((p, i) => {
    const c = cells[Math.min(i, cells.length - 1)];
    [p.x, p.y, p.w, p.h] = c;
    if (p.el) positionEl(p.el, p);
  });
}

function addModulePhoto(mi, img, url) {
  const mod = state.modules[mi];
  const p = { img, x: 0, y: 0, w: 10, h: 10 };
  mod.photos.push(p);
  const el = document.createElement("div");
  el.className = "tile module-tile";
  el.style.backgroundImage = `url(${url})`;
  p.el = el;
  addControls(el, () => {
    mod.photos.splice(mod.photos.indexOf(p), 1);
    el.remove();
    layoutModule(mi);
    renderModulePlaceholder(mi);
  });
  makeInteractive(el, p, { clamp: MODULE_RECTS[mi], minW: 80 });
  overlayInner.appendChild(el);
  layoutModule(mi);
  renderModulePlaceholder(mi);
}

function renderModulePlaceholder(mi) {
  const old = overlayInner.querySelector(`.module-ph[data-mi="${mi}"]`);
  if (old) old.remove();
  if (state.modules[mi].photos.length) return;
  const [x, y, w, h] = rectToXYWH(MODULE_RECTS[mi]);
  const el = document.createElement("div");
  el.className = "tile placeholder module-ph";
  el.dataset.mi = mi;
  el.textContent = `「${MODULE_NAMES[mi]}」\n在左侧上传照片`;
  positionEl(el, { x, y, w, h });
  overlayInner.appendChild(el);
}

/* ================= 表单 ================= */
/* 行模板:{} 为输入框,其余为固定单位/分隔符;def 为默认值 */
const XQ_ROWS = [ // 小区信息,按行顺序
  { tpl: "{}/{}/{}", def: ["虹口", "临平路", "新陆花苑"] },
  { tpl: "{}", def: ["1973-1994"] },
  { tpl: "{}/{}", def: ["塔楼", "商品房"] },
  { tpl: "{}/{}", def: ["632", "5"] },
  { tpl: "{}/{}%", def: ["3.2", "10"] },
  { tpl: "{}/{}", def: ["30", "1:0"] },
  { tpl: "{}（套）", def: ["2"] },
  { tpl: "{} 元/平米", def: ["59149"] },
  { tpl: "{}（套）", def: ["6"] },
  { tpl: "{} 元/平米", def: ["60643"] },
];
const FW_ROWS = [ // 房屋信息;"floor" 表示楼层行(高中低下拉),null 表示装修行(折价联动),均单独处理
  { tpl: "{}平米", def: ["159"] },
  { tpl: "{}", def: ["3室2厅1厨2卫，2阳台；"] },
  "floor",
  { tpl: "{}", def: ["南"] },
  null,
  { tpl: "{}", def: ["无"] },
  { tpl: "{}（套）", def: ["2"] },
  { tpl: "{}（套）", def: ["10"] },
];
const WT_TPLS = [ // 委托前/后共用模板;null 表示是否成交(下拉)
  "{}（天）", "{}（家）", "{}（人）", "{}（人）",
  "{}万（人次）", "{}（组）", "{}（组）", "{}（次）", null,
];
const WT_BEFORE = ["142", "3", "40", "1", "2", "1", "0", "0", "否"];
const WT_AFTER = ["11", "40", "130", "6", "6.5", "4", "1", "1", "是"];

function buildForm() {
  const form = document.getElementById("form");
  const byId = {};
  layout.texts.forEach((t) => {
    if (t.text && !byId[t.id]) byId[t.id] = t;
  });
  const setValue = (id, v) => {
    state.values[id] = v;
    redraw();
  };

  const newSection = (title) => {
    const fs = document.createElement("fieldset");
    const lg = document.createElement("legend");
    lg.textContent = title;
    fs.appendChild(lg);
    form.appendChild(fs);
    return fs;
  };

  const makeRow = (fs, label) => {
    const row = document.createElement("div");
    row.className = "field";
    if (label) {
      const span = document.createElement("span");
      span.textContent = label;
      row.appendChild(span);
    }
    fs.appendChild(row);
    return row;
  };

  const makeInput = (def, cls) => {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = cls || "mini";
    inp.value = def;
    inp.dataset.default = def;
    return inp;
  };

  const makeEm = (text) => {
    const em = document.createElement("em");
    em.textContent = text;
    return em;
  };

  /* 在输入框所在行下方加滑动条,与输入值双向同步 */
  const addSliderRow = (inp, { min, max, apply, read, fmt }) => {
    const anchor = inp.closest(".field");
    const row = document.createElement("div");
    row.className = "field slider-field";
    row.appendChild(document.createElement("span")); // 占位,与上方输入框对齐
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = min;
    slider.max = max;
    const lab = document.createElement("em");
    lab.className = "slider-val";
    row.appendChild(slider);
    row.appendChild(lab);
    anchor.insertAdjacentElement("afterend", row);
    const sync = () => {
      const pos = read();
      if (pos === null || pos === undefined || isNaN(pos)) return;
      slider.value = Math.min(Math.max(pos, min), max);
      lab.textContent = fmt(pos);
    };
    slider.addEventListener("input", () => {
      const pos = parseFloat(slider.value);
      apply(pos);
      lab.textContent = fmt(pos);
    });
    sync();
    return { row, slider, sync };
  };

  /* 单值输入(整句或前缀+值) */
  const addTextField = (fs, id, label, prefix, defaultVal) => {
    const row = makeRow(fs, label);
    const inp = makeInput(defaultVal, "wide");
    inp.dataset.id = id;
    inp.addEventListener("input", () => setValue(id, prefix + inp.value));
    row.appendChild(inp);
    setValueSilent(id, prefix + defaultVal);
    return inp;
  };

  /* 模板输入:{} 处为输入框,其余为固定单位,自动拼接 */
  const addTemplateField = (fs, id, label, prefix, tpl, def) => {
    const row = makeRow(fs, label);
    const segments = tpl.split("{}");
    const inputs = def.map((d) => makeInput(d));
    inputs.forEach((inp) => (inp.dataset.id = id));
    const compose = () => {
      let out = segments[0];
      inputs.forEach((inp, i) => {
        out += inp.value + segments[i + 1];
      });
      setValue(id, prefix + out);
    };
    inputs.forEach((inp, i) => {
      row.appendChild(inp);
      inp.addEventListener("input", compose);
      const tail = segments[i + 1];
      if (tail) row.appendChild(makeEm(tail));
    });
    compose();
    return inputs;
  };

  /* 下拉选择 */
  const addSelectField = (fs, id, label, prefix, options, def) => {
    const row = makeRow(fs, label);
    const sel = document.createElement("select");
    options.forEach((op) => {
      const o = document.createElement("option");
      o.value = o.textContent = op;
      sel.appendChild(o);
    });
    sel.value = def;
    sel.dataset.default = def;
    sel.dataset.id = id;
    sel.addEventListener("change", () => setValue(id, prefix + sel.value));
    row.appendChild(sel);
    setValueSilent(id, prefix + def);
    return sel;
  };

  /* --- 成交信息 --- */
  const fs1 = newSection("成交信息");
  addTextField(fs1, DEAL_IDS.address, "房屋地址", "", byId[DEAL_IDS.address].text);

  // 成交日期:年月日三个框
  {
    const t = byId[DEAL_IDS.dealDate].text;
    const prefix = splitPrefix(t)[0];
    const m = t.match(/(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/);
    const [dy, dm, dd] = m ? [m[1], m[2], m[3]] : ["2026", "1", "1"];
    const row = makeRow(fs1, "成交日期");
    row.classList.add("date-field");
    const inputs = [];
    [["年", dy], ["月", dm], ["日", dd]].forEach(([unit, val]) => {
      const inp = document.createElement("input");
      inp.type = "number";
      inp.value = val;
      inp.dataset.default = val;
      inputs.push(inp);
      row.appendChild(inp);
      row.appendChild(makeEm(unit));
    });
    const compose = () =>
      setValue(DEAL_IDS.dealDate, `${prefix}${inputs[0].value}年${inputs[1].value}月${inputs[2].value}日`);
    inputs.forEach((inp) => inp.addEventListener("input", compose));
    compose();
  }

  // 成交价 / 成交周期 / 客户出价;溢价与溢价率自动计算
  const priceInp = addTextField(fs1, DEAL_IDS.price, "成交价(万)", "", byId[DEAL_IDS.price].text);
  addTextField(fs1, DEAL_IDS.period, "成交周期(天)", "", byId[DEAL_IDS.period].text);
  const bidInp = addTextField(fs1, DEAL_IDS.bid, "客户出价(万)", "", byId[DEAL_IDS.bid].text);
  let premView, rateView;
  {
    const row1 = makeRow(fs1, "谈判溢价(万)");
    premView = makeInput("", "mini");
    premView.readOnly = true;
    premView.classList.add("readonly");
    row1.appendChild(premView);
    row1.appendChild(makeEm("= 成交价 − 客户出价"));
    const row2 = makeRow(fs1, "谈判溢价率(%)");
    rateView = makeInput("", "mini");
    rateView.readOnly = true;
    rateView.classList.add("readonly");
    row2.appendChild(rateView);
    row2.appendChild(makeEm("= 溢价 ÷ 客户出价"));
  }
  const updateDerived = () => {
    const price = parseFloat(priceInp.value);
    const bid = parseFloat(bidInp.value);
    let prem = "", rate = "";
    if (!isNaN(price) && !isNaN(bid) && bid !== 0) {
      prem = String(parseFloat((price - bid).toFixed(2)));
      rate = (((price - bid) / bid) * 100).toFixed(2);
    }
    premView.value = prem;
    rateView.value = rate;
    setValue(DEAL_IDS.premium, prem);
    setValue(DEAL_IDS.premiumRate, rate);
  };
  priceInp.addEventListener("input", updateDerived);
  bidInp.addEventListener("input", updateDerived);
  updateDerived();

  // 客户出价:默认成交价的 92%,可在 85%-97% 之间修改,超出自动夹取
  let syncBidSlider = () => {};
  const autoFillBid = () => {
    const price = parseFloat(priceInp.value);
    if (isNaN(price)) return;
    bidInp.value = String(Math.round(price * 0.92));
    setValue(DEAL_IDS.bid, bidInp.value);
    updateDerived();
    syncBidSlider();
  };
  priceInp.addEventListener("input", autoFillBid);
  bidInp.addEventListener("change", () => {
    const price = parseFloat(priceInp.value);
    const bid = parseFloat(bidInp.value);
    if (isNaN(price) || isNaN(bid)) return;
    const clamped = Math.min(Math.max(bid, Math.round(price * 0.85)), Math.round(price * 0.97));
    if (clamped !== bid) {
      bidInp.value = String(clamped);
      setValue(DEAL_IDS.bid, bidInp.value);
      updateDerived();
      bidInp.style.borderColor = "#e53935";
      setTimeout(() => (bidInp.style.borderColor = ""), 1200);
      syncBidSlider();
    }
  });
  // 出价比例滑条(85%-97%)
  const pctFmt = (p) => `${Math.round(p * 10) / 10}%`;
  const bidSlider = addSliderRow(bidInp, {
    min: 85,
    max: 97,
    apply: (pct) => {
      const price = parseFloat(priceInp.value);
      if (isNaN(price)) return;
      bidInp.value = String(Math.round((price * pct) / 100));
      bidInp.dispatchEvent(new Event("input"));
    },
    read: () => {
      const price = parseFloat(priceInp.value);
      const bid = parseFloat(bidInp.value);
      return !isNaN(price) && !isNaN(bid) && price > 0 ? (bid / price) * 100 : null;
    },
    fmt: pctFmt,
  });
  bidInp.addEventListener("input", bidSlider.sync);
  syncBidSlider = bidSlider.sync;
  autoFillBid();
  bidInp.dataset.default = bidInp.value; // 恢复默认时回到 92% 而非 PSD 里的旧值

  {
    const [prefix, val] = splitPrefix(byId[DEAL_IDS.rating].text);
    addTextField(fs1, DEAL_IDS.rating, "小区评级", prefix, val);
  }

  let wtAfterAgents = null, wtAfterExposure = null, wtAfterShopInp = null;
  let wtView = null, wtBid = null, wtNego = null; // 委托-后:带看量/出价量/谈判量(随机+可修改)
  let wtShootInp = null; // 委托-后:拍摄人数输入框
  let syncWtSliders = () => {}; // 重随机后同步各滑条
  const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

  /* --- 分区按模板生成(行数与 PSD 图层一一对应,对不上则退化为整值输入) --- */
  const groupTexts = (g) =>
    layout.texts.filter((t) => t.text && t.id.startsWith("对比信息/" + g + "/"));

  const addSpecSection = (title, groupPrefix, specs, rowLabel) => {
    const fs = newSection(title);
    const texts = groupTexts(groupPrefix);
    texts.forEach((t, i) => {
      const [prefix, val] = splitPrefix(t.text) || ["", t.text];
      const spec = specs[i];
      if (spec) {
        addTemplateField(fs, t.id, rowLabel ? rowLabel(t, i) : prefix, prefix, spec.tpl, spec.def);
      } else {
        addTextField(fs, t.id, rowLabel ? rowLabel(t, i) : prefix, prefix, val);
      }
    });
    return { fs, texts };
  };

  addSpecSection("小区信息(只填数值,单位固定)", "组 7", XQ_ROWS);

  // 房屋信息:装修行带「是否有折价」联动
  {
    const fs = newSection("房屋信息(只填数值,单位固定)");
    const texts = groupTexts("组 7 拷贝");
    texts.forEach((t, i) => {
      const [prefix, val] = splitPrefix(t.text) || ["", t.text];
      const spec = FW_ROWS[i];
      if (spec === "floor") {
        // 楼层行:高/中/低 下拉,输出"楼层：X楼层"
        const row = makeRow(fs, "楼层");
        const sel = document.createElement("select");
        ["高", "中", "低"].forEach((op) => {
          const o = document.createElement("option");
          o.value = o.textContent = op;
          sel.appendChild(o);
        });
        sel.value = "高";
        sel.dataset.default = "高";
        sel.dataset.id = t.id;
        sel.addEventListener("change", () => setValue(t.id, `楼层：${sel.value}楼层`));
        row.appendChild(sel);
        row.appendChild(makeEm("楼层"));
        setValueSilent(t.id, "楼层：高楼层");
      } else if (spec) {
        addTemplateField(fs, t.id, prefix, prefix, spec.tpl, spec.def);
      } else {
        // 装修行:是否有折价
        NO_SHRINK_IDS.add(t.id); // 选"是"后文本变长,仍保持与其他行一致的字号
        const row = makeRow(fs, "装修");
        const sel = document.createElement("select");
        ["否", "是"].forEach((op) => {
          const o = document.createElement("option");
          o.value = o.textContent = op;
          sel.appendChild(o);
        });
        sel.value = "否";
        sel.dataset.default = "否";
        sel.dataset.id = t.id + "#discount";
        const zhuang = makeInput(val);
        zhuang.dataset.id = t.id;
        const slash = makeEm("/");
        const zhe = makeInput("50万");
        zhe.dataset.id = t.id + "#zhe";
        slash.style.display = "none";
        zhe.style.display = "none";
        const compose = () => {
          if (sel.value === "是") {
            setValue(t.id, `装修/折价：${zhuang.value}/${zhe.value}`);
          } else {
            setValue(t.id, `${prefix}${zhuang.value}`);
          }
        };
        sel.addEventListener("change", () => {
          const on = sel.value === "是";
          slash.style.display = on ? "" : "none";
          zhe.style.display = on ? "" : "none";
          compose();
        });
        zhuang.addEventListener("input", compose);
        zhe.addEventListener("input", compose);
        row.appendChild(sel);
        row.appendChild(zhuang);
        row.appendChild(slash);
        row.appendChild(zhe);
        const tip = makeEm("是否有折价");
        tip.className = "hint-inline";
        row.appendChild(tip);
        compose();
      }
    });
  }

  /* --- 委托前/后 --- */
  const setTplValue = (rec, suffix, val) => {
    rec.inp.value = val;
    setValue(rec.id, val + suffix);
  };
  let wtAgentsDigit = 0; // 影响经纪人数量 = 门店量×5 + 随机个位数(滑块可调)
  const updateWtAgents = () => {
    if (!wtAfterAgents) return;
    const shopCount = parseFloat(wtAfterShopInp?.value) || 0;
    const val = Math.round(shopCount * 5) + wtAgentsDigit;
    wtAfterAgents.inp.value = val;
    setValue(wtAfterAgents.id, val + "（人）");
  };
  const updateWtAfterDerived = () => {
    const shopCount = parseFloat(wtAfterShopInp?.value) || 0;
    wtAgentsDigit = randInt(0, 9);
    updateWtAgents();
    if (wtAfterExposure) {
      let val = (shopCount * 0.3).toFixed(2);
      val = val.replace(/\.?0+$/, "");
      wtAfterExposure.inp.value = val;
      setValue(wtAfterExposure.id, val + "万（人次）");
    }
    // 带看量 = 门店量 × 30%-120% 随机,取整
    if (wtView) {
      const ratio = 0.3 + Math.random() * 0.9;
      setTplValue(wtView, "（组）", Math.round(shopCount * ratio));
    }
    // 出价量:0-5 随机
    if (wtBid) setTplValue(wtBid, "（组）", randInt(0, 5));
    // 谈判量:1-10 随机
    if (wtNego) setTplValue(wtNego, "（次）", randInt(1, 10));
    syncWtSliders();
  };

  ["组 7 拷贝 3", "组 7 拷贝 4"].forEach((g, gi) => {
    const fs = newSection(gi === 0 ? "销售数据 · 委托-前(只填数值)" : "销售数据 · 委托-后(只填数值)");
    const defs = gi === 0 ? WT_BEFORE : WT_AFTER;
    groupTexts(g).forEach((t, i) => {
      const label = ROW_LABELS[i] || "";
      const tpl = WT_TPLS[i];
      if (gi === 1 && i === 1) {
        // 委托-后 推广门店量
        const inputs = addTemplateField(fs, t.id, label, "", tpl, [defs[i]]);
        wtAfterShopInp = inputs[0];
        wtAfterShopInp.addEventListener("input", updateWtAfterDerived);
      } else if (gi === 1 && i === 2) {
        // 委托-后 影响经纪人数量 - 只读
        const row = makeRow(fs, label);
        const inp = makeInput("", "mini");
        inp.readOnly = true;
        inp.classList.add("readonly");
        row.appendChild(inp);
        row.appendChild(makeEm("（人）"));
        wtAfterAgents = { inp, id: t.id };
      } else if (gi === 1 && i === 4) {
        // 委托-后 曝光量 - 只读
        const row = makeRow(fs, label);
        const inp = makeInput("", "mini");
        inp.readOnly = true;
        inp.classList.add("readonly");
        row.appendChild(inp);
        row.appendChild(makeEm("万（人次）"));
        wtAfterExposure = { inp, id: t.id };
      } else if (gi === 1 && i === 3) {
        // 拍摄人数:15-30 随机,可修改
        const inputs = addTemplateField(fs, t.id, label, "", tpl, [String(randInt(15, 30))]);
        wtShootInp = inputs[0];
      } else if (gi === 1 && i === 5) {
        // 带看量:门店量 30%-120% 随机取整,可修改
        const inputs = addTemplateField(fs, t.id, label, "", tpl, [defs[i]]);
        wtView = { inp: inputs[0], id: t.id };
      } else if (gi === 1 && i === 6) {
        // 出价量:0-5 随机,可修改
        const inputs = addTemplateField(fs, t.id, label, "", tpl, [defs[i]]);
        wtBid = { inp: inputs[0], id: t.id };
      } else if (gi === 1 && i === 7) {
        // 谈判量:1-10 随机,可修改
        const inputs = addTemplateField(fs, t.id, label, "", tpl, [defs[i]]);
        wtNego = { inp: inputs[0], id: t.id };
      } else if (tpl === null) {
        addSelectField(fs, t.id, label, "", ["否", "是"], defs[i]);
      } else if (tpl) {
        addTemplateField(fs, t.id, label, "", tpl, [defs[i]]);
      } else {
        addTextField(fs, t.id, label, "", t.text);
      }
    });
    if (gi === 1) updateWtAfterDerived();
  });

  /* --- 委托-后:比例/范围滑条 --- */
  if (wtShootInp && wtView && wtBid && wtNego && wtAfterAgents) {
    // 影响经纪人数量:门店量×5 + 个位数(0-9)
    const agentsSlider = addSliderRow(wtAfterAgents.inp, {
      min: 0,
      max: 9,
      apply: (v) => {
        wtAgentsDigit = v;
        updateWtAgents();
      },
      read: () => wtAgentsDigit,
      fmt: (v) => `+${v}人`,
    });
    // 拍摄人数 15-30
    const shootSlider = addSliderRow(wtShootInp, {
      min: 15,
      max: 30,
      apply: (v) => {
        wtShootInp.value = String(v);
        wtShootInp.dispatchEvent(new Event("input"));
      },
      read: () => parseFloat(wtShootInp.value),
      fmt: (v) => `${v}人`,
    });
    wtShootInp.addEventListener("input", shootSlider.sync);
    // 带看量 = 门店量的 30%-120%
    const viewSlider = addSliderRow(wtView.inp, {
      min: 30,
      max: 120,
      apply: (pct) => {
        const shop = parseFloat(wtAfterShopInp?.value) || 0;
        wtView.inp.value = String(Math.round((shop * pct) / 100));
        wtView.inp.dispatchEvent(new Event("input"));
      },
      read: () => {
        const shop = parseFloat(wtAfterShopInp?.value) || 0;
        const v = parseFloat(wtView.inp.value);
        return shop > 0 && !isNaN(v) ? (v / shop) * 100 : null;
      },
      fmt: pctFmt,
    });
    wtView.inp.addEventListener("input", viewSlider.sync);
    // 出价量 0-5
    const bidSlider2 = addSliderRow(wtBid.inp, {
      min: 0,
      max: 5,
      apply: (v) => {
        wtBid.inp.value = String(v);
        wtBid.inp.dispatchEvent(new Event("input"));
      },
      read: () => parseFloat(wtBid.inp.value),
      fmt: (v) => `${v}组`,
    });
    wtBid.inp.addEventListener("input", bidSlider2.sync);
    // 谈判量 1-10
    const negoSlider = addSliderRow(wtNego.inp, {
      min: 1,
      max: 10,
      apply: (v) => {
        wtNego.inp.value = String(v);
        wtNego.inp.dispatchEvent(new Event("input"));
      },
      read: () => parseFloat(wtNego.inp.value),
      fmt: (v) => `${v}次`,
    });
    wtNego.inp.addEventListener("input", negoSlider.sync);

    syncWtSliders = () => {
      agentsSlider.sync();
      shootSlider.sync();
      viewSlider.sync();
      bidSlider2.sync();
      negoSlider.sync();
    };
    syncWtSliders();
  }

  /* --- 成交照片 --- */
  const fsDeal = newSection("成交照片(右上大图)");
  {
    const onFiles = (files) => setDealPhotoFile(files[0]);
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/*";
    inp.addEventListener("change", async () => {
      if (inp.files[0]) await setDealPhotoFile(inp.files[0]);
      inp.value = "";
    });
    fsDeal.appendChild(inp);
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "上传后照片自动填入海报右上区域。";
    fsDeal.appendChild(hint);
    makeDropTarget(fsDeal, onFiles);
    makePasteZone(fsDeal, onFiles);
  }
  /* --- 项目照片模块 --- */
  MODULE_NAMES.forEach((name, mi) => {
    const fs = newSection(`项目照片 · ${name}`);
    const onFiles = (files) => files.forEach((f) => addModulePhotoFile(mi, f));
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/*";
    inp.multiple = true;
    inp.addEventListener("change", async () => {
      for (const f of inp.files) await addModulePhotoFile(mi, f);
      inp.value = "";
    });
    fs.appendChild(inp);

    const row = document.createElement("div");
    row.className = "field";
    const span = document.createElement("span");
    span.textContent = "排版";
    row.appendChild(span);
    const sel = document.createElement("select");
    Object.entries(PRESET_LABELS).forEach(([k, v]) => {
      const op = document.createElement("option");
      op.value = k;
      op.textContent = v;
      sel.appendChild(op);
    });
    sel.addEventListener("change", () => {
      state.modules[mi].preset = sel.value;
      layoutModule(mi);
    });
    row.appendChild(sel);
    fs.appendChild(row);
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = `最多 ${MAX_MODULE_PHOTOS} 张;照片格可直接拖动位置、右下角缩放微调。`;
    fs.appendChild(hint);
    makeDropTarget(fs, onFiles);
    makePasteZone(fs, onFiles);
  });

  // Ctrl+V 粘贴:图片进入当前激活的分区
  document.addEventListener("paste", (e) => {
    if (!pasteTarget) return;
    const files = pickImageFiles(e.clipboardData?.files);
    if (!files.length) return;
    e.preventDefault();
    pasteTarget(files);
  });

  /* --- 贴纸·马赛克（所有照片通用） --- */
  const fsSticker = newSection("贴纸·马赛克（所有照片通用）");
  {
    // 内置贴纸
    const pal = document.createElement("div");
    pal.className = "palette";
    STICKERS.forEach((s) => {
      const im = document.createElement("img");
      im.src = s.data;
      im.title = "点击添加贴纸";
      im.addEventListener("click", () => {
        const w = 200;
        addSticker(im, layout.width / 2 - w / 2, layout.height / 2 - w / 2, w);
      });
      pal.appendChild(im);
    });
    // 常用 emoji
    ["😂", "🥰", "😎", "🤩"].forEach((ch) => {
      const url = emojiToDataURL(ch);
      const im = document.createElement("img");
      im.src = url;
      im.title = "点击添加 emoji";
      im.addEventListener("click", () => {
        const w = 200;
        addSticker(im, layout.width / 2 - w / 2, layout.height / 2 - w / 2, w);
      });
      pal.appendChild(im);
    });
    fsSticker.appendChild(pal);

    // 上传自定义贴纸
    const upHint = document.createElement("p");
    upHint.className = "hint";
    upHint.textContent = "上传自定义贴纸（可多选），上传后自动添加到画布中央并加入上方贴纸库。";
    fsSticker.appendChild(upHint);
    const upInp = document.createElement("input");
    upInp.type = "file";
    upInp.accept = "image/*";
    upInp.multiple = true;
    upInp.addEventListener("change", async () => {
      for (const f of upInp.files) {
        const url = URL.createObjectURL(f);
        const img = await loadImage(url);
        const thumb = document.createElement("img");
        thumb.src = url;
        thumb.title = "自定义贴纸";
        thumb.addEventListener("click", () => {
          const w = 200;
          addSticker(img, layout.width / 2 - w / 2, layout.height / 2 - w / 2, w);
        });
        pal.appendChild(thumb);
        const w = 200;
        addSticker(img, layout.width / 2 - w / 2, layout.height / 2 - w / 2, w);
      }
      upInp.value = "";
    });
    fsSticker.appendChild(upInp);

    // 马赛克画笔工具
    const mosaicBar = document.createElement("div");
    mosaicBar.className = "mosaic-bar";

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "mosaic-btn";
    toggleBtn.textContent = "马赛克画笔";
    toggleBtn.addEventListener("click", () => toggleMosaicMode(toggleBtn));
    mosaicBar.appendChild(toggleBtn);

    const brushGroup = document.createElement("div");
    brushGroup.className = "brush-group";
    const LABELS = ["小", "中", "大"];
    [40, 80, 120].forEach((size, idx) => {
      const btn = document.createElement("button");
      btn.className = "brush-btn" + (size === 80 ? " active" : "");
      btn.dataset.brush = size;
      btn.title = LABELS[idx];
      btn.addEventListener("click", () => setBrushSize(size));
      brushGroup.appendChild(btn);
    });
    mosaicBar.appendChild(brushGroup);

    const undoBtn = document.createElement("button");
    undoBtn.className = "mosaic-btn";
    undoBtn.textContent = "撤销上一笔";
    undoBtn.addEventListener("click", () => undoMosaicStroke());
    mosaicBar.appendChild(undoBtn);

    const clearBtn = document.createElement("button");
    clearBtn.className = "mosaic-btn";
    clearBtn.textContent = "清除全部";
    clearBtn.addEventListener("click", () => clearMosaic());
    mosaicBar.appendChild(clearBtn);

    fsSticker.appendChild(mosaicBar);

    const mosaicHint = document.createElement("p");
    mosaicHint.className = "mosaic-hint";
    mosaicHint.textContent = "提示：开启画笔后预览区变为十字光标，涂抹区域以半透明白色显示；导出时才是真正马赛克效果。画错可用「撤销」或「清除」。";
    fsSticker.appendChild(mosaicHint);
  }
}


function setValueSilent(id, v) {
  state.values[id] = v;
}

/* 把 emoji 字符渲染成贴纸图 */
function emojiToDataURL(ch) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d");
  ctx.font = "220px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(ch, 128, 138);
  return c.toDataURL("image/png");
}

/* ================= 初始化 ================= */
async function init() {
  const status = document.getElementById("status");
  try {
    status.textContent = "字体加载中…";
    await loadFonts();
    layout = LAYOUT;
    bgImg = await loadImage(BG_DATA);

    const canvas = document.getElementById("poster");
    canvas.width = layout.width;
    canvas.height = layout.height;

    overlayInner = document.getElementById("overlayInner");
    overlayInner.style.width = layout.width + "px";
    overlayInner.style.height = layout.height + "px";

    // 马赛克蒙版初始化
    state.mosaic.maskCanvas = document.createElement("canvas");
    state.mosaic.maskCanvas.width = layout.width;
    state.mosaic.maskCanvas.height = layout.height;
    state.mosaic.maskCtx = state.mosaic.maskCanvas.getContext("2d");
    const mosaicPreview = document.createElement("img");
    mosaicPreview.id = "mosaicPreview";
    mosaicPreview.style.display = "none";
    overlayInner.appendChild(mosaicPreview);

    updateScale();
    window.addEventListener("resize", updateScale);

    // 点击空白处取消选中（马赛克模式下进入绘制）
    overlayInner.addEventListener("pointerdown", (e) => {
      if (state.mosaic.enabled) {
        onMosaicPointerDown(e);
        return;
      }
      if (e.target === overlayInner) selectEl(null);
    });

    // 预览区拖拽上传:按落点坐标路由到成交照片或对应项目照片模块
    overlayInner.addEventListener("dragover", (e) => e.preventDefault());
    overlayInner.addEventListener("drop", (e) => {
      e.preventDefault();
      const files = pickImageFiles(e.dataTransfer?.files);
      if (!files.length) return;
      const rect = overlayInner.getBoundingClientRect();
      const cx = (e.clientX - rect.left) / scaleFactor;
      const cy = (e.clientY - rect.top) / scaleFactor;
      const inRect = (r) => cx >= r[0] && cx <= r[2] && cy >= r[1] && cy <= r[3];
      if (inRect(DEAL_RECT)) {
        setDealPhotoFile(files[0]);
        return;
      }
      const mi = MODULE_RECTS.findIndex(inRect);
      if (mi >= 0) files.forEach((f) => addModulePhotoFile(mi, f));
      else showStatus("请把图片拖到照片区域内");
    });


    buildForm();
    MODULE_RECTS.forEach((_, mi) => renderModulePlaceholder(mi));
    redraw();

    document.getElementById("download").addEventListener("click", () => {
      const canvas = composePoster();
      canvas.toBlob((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `成交喜报-${new Date().toISOString().slice(0, 10)}.png`;
        a.click();
        URL.revokeObjectURL(a.href);
      }, "image/png");
    });
    document.getElementById("reset").addEventListener("click", () => {
      document.querySelectorAll("#form [data-default]").forEach((el) => {
        el.value = el.dataset.default;
        el.dispatchEvent(new Event("input"));
        el.dispatchEvent(new Event("change"));
      });
      state.stickers.slice().forEach((s) => s.el.querySelector(".del").click());
      state.modules.forEach((mod, mi) => {
        mod.photos.slice().forEach((p) => p.el.querySelector(".del").click());
      });
state.dealPhoto = null; renderDealPhoto(); clearMosaic(); if (state.mosaic.enabled) { const btn = document.querySelector(`.mosaic-btn.active`); if (btn) btn.classList.remove(`active`); state.mosaic.enabled = false; overlayInner.classList.remove(`mosaic-mode`); } redraw(); });
    status.textContent = "";
    // 测试钩子
    window.__poster = { state, composePoster, redraw, layoutModule, redrawMosaicMask, updateMosaicPreview };
  } catch (e) {
    status.textContent = "加载失败:" + e.message;
    console.error(e);
  }
}

/* ================= 马赛克画笔 ================= */
function toggleMosaicMode(btn) {
  state.mosaic.enabled = !state.mosaic.enabled;
  if (btn) btn.classList.toggle("active", state.mosaic.enabled);
  overlayInner.classList.toggle("mosaic-mode", state.mosaic.enabled);
}

function setBrushSize(size) {
  state.mosaic.brushSize = size;
  document.querySelectorAll(".brush-btn").forEach((b) => {
    b.classList.toggle("active", parseInt(b.dataset.brush) === size);
  });
}

function undoMosaicStroke() {
  if (!state.mosaic.strokes.length) return;
  state.mosaic.strokes.pop();
  redrawMosaicMask();
}

function clearMosaic() {
  state.mosaic.strokes = [];
  redrawMosaicMask();
}

function redrawMosaicMask() {
  const ctx = state.mosaic.maskCtx;
  if (!ctx) return;
  ctx.clearRect(0, 0, layout.width, layout.height);
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#fff";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const stroke of state.mosaic.strokes) {
    if (stroke.points.length < 2) continue;
    ctx.lineWidth = stroke.size;
    ctx.beginPath();
    ctx.moveTo(stroke.points[0][0], stroke.points[0][1]);
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i][0], stroke.points[i][1]);
    }
    ctx.stroke();
  }
  updateMosaicPreview();
}

function updateMosaicPreview() {
  const preview = document.getElementById("mosaicPreview");
  if (!preview) return;
  if (!state.mosaic.strokes.length) {
    preview.style.display = "none";
  } else {
    preview.style.display = "";
    preview.src = state.mosaic.maskCanvas.toDataURL();
  }
}

function onMosaicPointerDown(e) {
  if (!state.mosaic.enabled) return;
  e.preventDefault();
  overlayInner.setPointerCapture(e.pointerId);

  const rect = overlayInner.getBoundingClientRect();
  const x = (e.clientX - rect.left) / scaleFactor;
  const y = (e.clientY - rect.top) / scaleFactor;
  const stroke = { points: [[x, y]], size: state.mosaic.brushSize };
  state.mosaic.strokes.push(stroke);

  const move = (ev) => {
    const mx = (ev.clientX - rect.left) / scaleFactor;
    const my = (ev.clientY - rect.top) / scaleFactor;
    stroke.points.push([mx, my]);
    const ctx = state.mosaic.maskCtx;
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#fff";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = stroke.size;
    ctx.beginPath();
    const pts = stroke.points;
    ctx.moveTo(pts[pts.length - 2][0], pts[pts.length - 2][1]);
    ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    ctx.stroke();
    updateMosaicPreview();
  };

  const up = () => {
    overlayInner.removeEventListener("pointermove", move);
    overlayInner.removeEventListener("pointerup", up);
  };
  overlayInner.addEventListener("pointermove", move);
  overlayInner.addEventListener("pointerup", up);
}

window.addEventListener("DOMContentLoaded", init);
