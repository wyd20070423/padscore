const DB_NAME = "ipad-score-library";
const DB_VERSION = 1;
const ROOT_ID = "root";
const RENDER_DPR = Math.min(window.devicePixelRatio || 1, 2.25);
const $ = (id) => document.getElementById(id);
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

const els = {
  storageStatus: $("storageStatus"),
  folderTree: $("folderTree"),
  searchInput: $("searchInput"),
  scoreGrid: $("scoreGrid"),
  currentTitle: $("currentTitle"),
  currentPath: $("currentPath"),
  crumbs: $("crumbs"),
  fileInput: $("fileInput"),
  restoreInput: $("restoreInput"),
  dropZone: $("dropZone"),
  importProgress: $("importProgress"),
  importProgressTitle: $("importProgressTitle"),
  importProgressDetail: $("importProgressDetail"),
  importProgressBar: $("importProgressBar"),
  viewer: $("viewer"),
  viewerTitle: $("viewerTitle"),
  pageStatus: $("pageStatus"),
  pages: $("pages"),
  fitBtn: $("fitBtn"),
  organizer: $("organizer"),
  pageSorter: $("pageSorter"),
  promptDialog: $("promptDialog"),
  promptTitle: $("promptTitle"),
  promptInput: $("promptInput"),
  helpDialog: $("helpDialog")
};

let db;
let dbAvailable = false;
let data = {
  folders: [{ id: ROOT_ID, name: "未整理", parentId: null, createdAt: Date.now() }],
  scores: [],
  settings: { selectedFolderId: ROOT_ID, fit: "auto", thumbnails: false, expandedFolderIds: [ROOT_ID] }
};

let currentBook = null;
let currentScore = null;
let currentPage = 0;
let draggingSortId = null;
let fileInputMode = "import";

const pdfCache = new Map();
const urlCache = new Map();
const pageCanvasCache = new Map();
const pageRenderJobs = new Map();
let renderRunId = 0;
let preloadRunId = 0;
let pdfjsLib = null;

async function ensurePdfLib() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import("./vendor/pdf.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.mjs";
  return pdfjsLib;
}

async function ensureZipLib() {
  if (window.JSZip) return window.JSZip;
  await new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-lib="jszip"]');
    if (existing) {
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", () => reject(new Error("JSZip 加载失败")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "./vendor/jszip.min.js?v=13";
    script.dataset.lib = "jszip";
    script.onload = resolve;
    script.onerror = () => reject(new Error("JSZip 加载失败"));
    document.head.append(script);
  });
  if (!window.JSZip) throw new Error("JSZip 没有加载成功");
  return window.JSZip;
}

function openDb() {
  if (!("indexedDB" in window)) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const next = request.result;
      if (!next.objectStoreNames.contains("meta")) next.createObjectStore("meta");
      if (!next.objectStoreNames.contains("files")) next.createObjectStore("files");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    setTimeout(() => reject(new Error("IndexedDB 初始化超时")), 6000);
  });
}

function tx(storeName, mode = "readonly") {
  if (!db) throw new Error("这个浏览器没有可用的本地数据库");
  return db.transaction(storeName, mode).objectStore(storeName);
}

function idbGet(storeName, key) {
  return new Promise((resolve, reject) => {
    const request = tx(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbPut(storeName, value, key) {
  return new Promise((resolve, reject) => {
    const request = tx(storeName, "readwrite").put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function idbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const request = tx(storeName, "readwrite").delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function idbClear(storeName) {
  return new Promise((resolve, reject) => {
    const request = tx(storeName, "readwrite").clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function load() {
  try {
    db = await openDb();
    dbAvailable = Boolean(db);
  } catch (error) {
    console.warn(error);
    db = null;
    dbAvailable = false;
  }
  const params = new URLSearchParams(location.search);
  if (params.get("reset") === "1" && confirm("清空这个浏览器里的谱库数据？")) {
    if (dbAvailable) {
      await idbClear("meta");
      await idbClear("files");
    }
    localStorage.removeItem(`${DB_NAME}:library`);
    location.href = location.pathname;
    return;
  }

  const stored = dbAvailable ? await idbGet("meta", "library") : loadLocalMeta();
  if (stored) data = stored;
  data.folders ||= [];
  data.scores ||= [];
  data.settings ||= {};
  data.settings.selectedFolderId ||= ROOT_ID;
  data.settings.fit ||= "auto";
  data.settings.thumbnails = false;
  data.settings.expandedFolderIds ||= [ROOT_ID];
  delete data.annotations;

  if (!data.folders.some((folder) => folder.id === ROOT_ID)) {
    data.folders.unshift({ id: ROOT_ID, name: "未整理", parentId: null, createdAt: Date.now() });
  }
}

async function save() {
  data.updatedAt = Date.now();
  if (dbAvailable) await idbPut("meta", data, "library");
  else saveLocalMeta();
  updateStorageStatus();
}

function loadLocalMeta() {
  try {
    const raw = localStorage.getItem(`${DB_NAME}:library`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveLocalMeta() {
  localStorage.setItem(`${DB_NAME}:library`, JSON.stringify(data));
}

async function updateStorageStatus() {
  if (!dbAvailable) {
    els.storageStatus.textContent = "本地数据库不可用";
    return;
  }
  if (!navigator.storage?.estimate) return;
  const estimate = await navigator.storage.estimate();
  const used = estimate.usage ? (estimate.usage / 1024 / 1024).toFixed(0) : "0";
  els.storageStatus.textContent = `本地 ${used} MB ♡`;
}

function selectedFolder() {
  return data.folders.find((folder) => folder.id === data.settings.selectedFolderId) || data.folders[0];
}

function childFolders(parentId) {
  return data.folders
    .filter((folder) => folder.parentId === parentId)
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function folderScores(folderId) {
  return data.scores
    .filter((score) => score.folderId === folderId)
    .sort((a, b) => (a.title || "").localeCompare(b.title || "", "zh-CN", { numeric: true }));
}

function folderScoresDeep(folderId) {
  const ids = new Set(descendantFolderIds(folderId));
  return data.scores
    .filter((score) => ids.has(score.folderId))
    .sort((a, b) => (a.title || "").localeCompare(b.title || "", "zh-CN", { numeric: true }));
}

function folderPath(folderId) {
  const path = [];
  let next = data.folders.find((folder) => folder.id === folderId);
  while (next) {
    path.unshift(next);
    next = data.folders.find((folder) => folder.id === next.parentId);
  }
  return path;
}

function descendantFolderIds(folderId) {
  const ids = [folderId];
  for (const child of childFolders(folderId)) ids.push(...descendantFolderIds(child.id));
  return ids;
}

function render() {
  renderFolders();
  renderLibrary();
}

function renderFolders() {
  els.folderTree.innerHTML = "";
  const expanded = new Set(data.settings.expandedFolderIds || [ROOT_ID]);

  const addFolderButton = (folder, depth, icon) => {
    const row = document.createElement("div");
    const children = childFolders(folder.id);
    row.className = `folder-row ${folder.id === data.settings.selectedFolderId ? "active" : ""}`;
    row.style.paddingLeft = `${8 + depth * 18}px`;
    row.innerHTML = `
      <button class="twisty" type="button" aria-label="${expanded.has(folder.id) ? "折叠" : "展开"}">${children.length ? (expanded.has(folder.id) ? "⌄" : ">") : icon}</button>
      <button class="folder-name" type="button"><span class="name"></span><span class="count">${folderScoresDeep(folder.id).length}</span></button>`;
    row.querySelector(".name").textContent = folder.name;
    row.querySelector(".folder-name").addEventListener("click", () => selectFolder(folder.id));
    row.querySelector(".twisty").addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!children.length) {
        await selectFolder(folder.id);
        return;
      }
      toggleFolder(folder.id);
    });
    els.folderTree.append(row);
  };

  const renderBranch = (parentId, depth) => {
    for (const folder of childFolders(parentId)) {
      addFolderButton(folder, depth, "୨୧");
      if (expanded.has(folder.id)) renderBranch(folder.id, depth + 1);
    }
  };

  addFolderButton(data.folders.find((folder) => folder.id === ROOT_ID), 0, "♡");
  if (expanded.has(ROOT_ID)) renderBranch(ROOT_ID, 1);
}

async function toggleFolder(folderId) {
  const ids = new Set(data.settings.expandedFolderIds || [ROOT_ID]);
  if (ids.has(folderId)) ids.delete(folderId);
  else ids.add(folderId);
  ids.add(ROOT_ID);
  data.settings.expandedFolderIds = [...ids];
  await save();
  renderFolders();
}

function renderLibrary() {
  const folder = selectedFolder();
  const query = els.searchInput.value.trim().toLowerCase();
  const path = folderPath(folder.id);
  els.currentTitle.textContent = folder.name;
  els.currentPath.textContent = `${path.map((item) => item.name).join(" / ")}  ·  点任意页即可目录连翻`;

  els.crumbs.innerHTML = "";
  for (const item of path) {
    const crumb = document.createElement("button");
    crumb.type = "button";
    crumb.className = "subtle";
    crumb.textContent = item.name;
    crumb.addEventListener("click", () => selectFolder(item.id));
    els.crumbs.append(crumb);
  }

  const visibleScores = query
    ? data.scores.filter((score) => `${score.title} ${score.sourceName}`.toLowerCase().includes(query))
    : folderScoresDeep(folder.id);

  els.scoreGrid.innerHTML = "";
  if (!visibleScores.length) {
    const empty = document.createElement("div");
    empty.className = "score-card empty";
    empty.innerHTML = `<div class="thumb">=^..^=</div><strong>${query ? "没找到喔" : "这里还没有谱子"}</strong><span>${query ? "换个名字试试" : "点导入，先把谱子放进来 ♡"}</span>`;
    els.scoreGrid.append(empty);
    return;
  }

  for (const score of visibleScores) {
    const card = document.createElement("article");
    card.className = "score-card";
    card.innerHTML = `
      <button class="thumb subtle" type="button">${score.pages?.[0]?.type === "pdf" ? "PDF" : "图片"}</button>
      <strong></strong>
      <span class="meta">${score.pages.length} 页 · ${scoreLocation(score)}</span>
      <div class="card-actions">
        <button class="open" type="button">打开</button>
        <button class="move subtle" type="button">移动</button>
        <button class="rename subtle" type="button">改名</button>
        <button class="remove danger subtle" type="button">删除</button>
      </div>`;
    card.querySelector("strong").textContent = score.title;
    card.querySelector(".thumb").addEventListener("click", () => openScore(score.id));
    card.querySelector(".open").addEventListener("click", () => openScore(score.id));
    card.querySelector(".move").addEventListener("click", () => moveScore(score.id));
    card.querySelector(".rename").addEventListener("click", () => renameScore(score.id));
    card.querySelector(".remove").addEventListener("click", () => deleteScore(score.id));
    els.scoreGrid.append(card);
  }
}

function scoreLocation(score) {
  const path = folderPath(score.folderId).map((item) => item.name).join(" / ");
  return `${path}${score.sourceName ? ` · ${score.sourceName}` : ""}`;
}

async function selectFolder(folderId) {
  data.settings.selectedFolderId = folderId;
  const pathIds = folderPath(folderId).map((folder) => folder.id);
  data.settings.expandedFolderIds = [...new Set([...(data.settings.expandedFolderIds || []), ...pathIds, ROOT_ID])];
  await save();
  document.body.classList.remove("sidebar-open");
  render();
}

async function promptText(title, value = "") {
  els.promptTitle.textContent = title;
  els.promptInput.value = value;
  els.promptDialog.showModal();
  requestAnimationFrame(() => els.promptInput.focus());
  return new Promise((resolve) => {
    els.promptDialog.addEventListener(
      "close",
      () => resolve(els.promptDialog.returnValue === "ok" ? els.promptInput.value.trim() : ""),
      { once: true }
    );
  });
}

async function addFolder() {
  const name = await promptText("新目录名称");
  if (!name) return;
  data.folders.push({ id: uid(), name, parentId: selectedFolder().id, createdAt: Date.now() });
  data.settings.expandedFolderIds = [...new Set([...(data.settings.expandedFolderIds || []), selectedFolder().id, ROOT_ID])];
  await save();
  render();
}

async function renameFolder() {
  const folder = selectedFolder();
  const name = await promptText("目录改名", folder.name);
  if (!name) return;
  folder.name = name;
  await save();
  render();
}

async function deleteFolder() {
  const folder = selectedFolder();
  if (folder.id === ROOT_ID) return alert("未整理不能删除。");
  const ids = descendantFolderIds(folder.id);
  const count = data.scores.filter((score) => ids.includes(score.folderId)).length;
  if (!confirm(`删除“${folder.name}”和里面的 ${count} 个谱子？`)) return;
  for (const score of data.scores.filter((score) => ids.includes(score.folderId))) await deleteScoreFiles(score);
  data.scores = data.scores.filter((score) => !ids.includes(score.folderId));
  data.folders = data.folders.filter((item) => !ids.includes(item.id));
  data.settings.selectedFolderId = ROOT_ID;
  await save();
  render();
}

async function deleteScoreFiles(score) {
  for (const fileId of [...new Set(score.pages.map((page) => page.fileId))]) await idbDelete("files", fileId);
}

function cleanTitle(name) {
  return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || name;
}

function isPdf(file) {
  return /pdf/i.test(file.type) || /\.pdf$/i.test(file.name);
}

function isImage(file) {
  return /image\/(jpeg|png)/.test(file.type) || /\.(jpe?g|png)$/i.test(file.name);
}

async function importFiles(fileList, folderId = selectedFolder().id) {
  if (!dbAvailable) {
    alert("这个浏览器没有可用的本地数据库，不能保存谱子。请用 iPad Safari 打开，或检查 Safari 是否允许网站数据。");
    return;
  }
  const files = [...fileList].filter((file) => isPdf(file) || isImage(file));
  if (!files.length) return;
  const failures = [];
  showImportProgress(`导入 0 / ${files.length}`, "准备文件", 0, files.length);

  const imageFiles = files.filter(isImage);
  const pdfFiles = files.filter(isPdf);

  if (imageFiles.length > 1 && !pdfFiles.length) {
    try {
      showImportProgress("合成多页图片谱", "多张图片会变成一首可翻页曲子", 0, imageFiles.length);
      const score = {
        id: uid(),
        title: cleanTitle(imageFiles[0].name).replace(/\s*\d+$/, ""),
        sourceName: `${imageFiles.length} 张图片`,
        folderId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        pages: []
      };
      for (const [index, file] of imageFiles.entries()) {
        showImportProgress(`导入 ${index + 1} / ${imageFiles.length}`, file.name, index, imageFiles.length);
        const fileId = uid();
        await idbPut("files", file, fileId);
        score.pages.push({ pageId: uid(), fileId, type: "image", sourceName: file.name });
      }
      data.scores.push(score);
      await save();
    } catch (error) {
      console.error(error);
      failures.push("多页图片谱");
    }
  } else {
    for (const [index, file] of files.entries()) {
      try {
        showImportProgress(`导入 ${index + 1} / ${files.length}`, file.name, index, files.length);
        const fileId = uid();
        await idbPut("files", file, fileId);
        const score = {
          id: uid(),
          title: cleanTitle(file.name),
          sourceName: file.name,
          folderId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          pages: []
        };

        if (isPdf(file)) {
          const pdfLib = await ensurePdfLib();
          const pdf = await pdfLib.getDocument({ data: await file.arrayBuffer() }).promise;
          for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
            score.pages.push({ pageId: uid(), fileId, type: "pdf", pageNumber, sourceName: file.name });
          }
        } else {
          score.pages.push({ pageId: uid(), fileId, type: "image", sourceName: file.name });
        }
        data.scores.push(score);
        await save();
      } catch (error) {
        console.error(error);
        failures.push(file.name);
      }
    }
  }

  showImportProgress("导入完成", failures.length ? `${failures.length} 个失败，可重新选一次` : "全部保存好啦 ♡", files.length, files.length);
  render();
  setTimeout(hideImportProgress, 2200);
  if (failures.length) alert(`这些文件没导入成功：\n\n${failures.join("\n")}`);
}

function showImportProgress(title, detail, value, max) {
  els.importProgress.classList.remove("hidden");
  els.importProgressTitle.textContent = title;
  els.importProgressDetail.textContent = detail;
  els.importProgressBar.max = max || 1;
  els.importProgressBar.value = value || 0;
  els.storageStatus.textContent = title;
}

function hideImportProgress() {
  els.importProgress.classList.add("hidden");
  updateStorageStatus();
}

async function appendFilesToScore(fileList) {
  if (!currentScore) return;
  const before = data.scores.length;
  await importFiles(fileList, currentScore.folderId);
  const added = data.scores.splice(before);
  for (const score of added) currentScore.pages.push(...score.pages);
  currentScore.updatedAt = Date.now();
  await save();
  renderOrganizer();
}

async function moveScore(scoreId) {
  const score = data.scores.find((item) => item.id === scoreId);
  const choices = data.folders.map((folder) => `${folderPath(folder.id).map((item) => item.name).join(" / ")} [${folder.id}]`).join("\n");
  const picked = prompt(`输入目标目录最后方括号里的 ID：\n\n${choices}`);
  if (!picked) return;
  const match = picked.match(/\[?([a-z0-9-]+)\]?$/i);
  const folder = match && data.folders.find((item) => item.id === match[1]);
  if (!folder) return alert("没找到这个目录。");
  score.folderId = folder.id;
  score.updatedAt = Date.now();
  await save();
  render();
}

async function renameScore(scoreId) {
  const score = data.scores.find((item) => item.id === scoreId);
  const title = await promptText("曲目改名", score.title);
  if (!title) return;
  score.title = title;
  score.updatedAt = Date.now();
  await save();
  render();
}

async function deleteScore(scoreId) {
  const score = data.scores.find((item) => item.id === scoreId);
  if (!score) return;
  if (!confirm(`删除“${score.title}”？`)) return;
  await deleteScoreFiles(score);
  data.scores = data.scores.filter((item) => item.id !== scoreId);
  await save();
  render();
}

async function getFileBlob(fileId) {
  if (!dbAvailable) throw new Error("这个浏览器没有可用的本地数据库");
  const blob = await idbGet("files", fileId);
  if (!blob) throw new Error("文件不存在，请从备份恢复。");
  return blob;
}

async function getPdf(fileId) {
  if (pdfCache.has(fileId)) return pdfCache.get(fileId);
  const pdfLib = await ensurePdfLib();
  const blob = await getFileBlob(fileId);
  const pdf = await pdfLib.getDocument({ data: await blob.arrayBuffer() }).promise;
  pdfCache.set(fileId, pdf);
  return pdf;
}

async function loadImage(fileId) {
  if (!urlCache.has(fileId)) {
    const blob = await getFileBlob(fileId);
    urlCache.set(fileId, URL.createObjectURL(blob));
  }
  const image = new Image();
  image.src = urlCache.get(fileId);
  await image.decode();
  return image;
}

function pageCacheKey(pageRef, maxWidth, maxHeight) {
  return `${pageRef.pageId}:${Math.round(maxWidth)}x${Math.round(maxHeight)}:${data.settings.fit}:${RENDER_DPR}`;
}

async function renderPageToCanvas(pageRef, maxWidth, maxHeight) {
  const cacheKey = pageCacheKey(pageRef, maxWidth, maxHeight);
  if (pageCanvasCache.has(cacheKey)) return copyCanvas(pageCanvasCache.get(cacheKey));
  if (pageRenderJobs.has(cacheKey)) return copyCanvas(await pageRenderJobs.get(cacheKey));

  const job = renderPageToCanvasUncached(pageRef, maxWidth, maxHeight).then((canvas) => {
    pageCanvasCache.set(cacheKey, copyCanvas(canvas));
    pageRenderJobs.delete(cacheKey);
    trimPageCache();
    return canvas;
  }).catch((error) => {
    pageRenderJobs.delete(cacheKey);
    throw error;
  });
  pageRenderJobs.set(cacheKey, job);
  return copyCanvas(await job);
}

async function renderPageToCanvasUncached(pageRef, maxWidth, maxHeight) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  let cssWidth = 1;
  let cssHeight = 1;

  if (pageRef.type === "pdf") {
    const pdf = await getPdf(pageRef.fileId);
    const page = await pdf.getPage(pageRef.pageNumber);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(maxWidth / base.width, maxHeight / base.height);
    const cssViewport = page.getViewport({ scale });
    const renderViewport = page.getViewport({ scale: scale * RENDER_DPR });
    cssWidth = Math.max(1, Math.floor(cssViewport.width));
    cssHeight = Math.max(1, Math.floor(cssViewport.height));
    canvas.width = Math.max(1, Math.floor(renderViewport.width));
    canvas.height = Math.max(1, Math.floor(renderViewport.height));
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
  } else {
    const image = await loadImage(pageRef.fileId);
    const scale = Math.min(maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
    cssWidth = Math.max(1, Math.floor(image.naturalWidth * scale));
    cssHeight = Math.max(1, Math.floor(image.naturalHeight * scale));
    canvas.width = Math.max(1, Math.floor(cssWidth * RENDER_DPR));
    canvas.height = Math.max(1, Math.floor(cssHeight * RENDER_DPR));
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  }

  canvas.dataset.cssWidth = String(cssWidth);
  canvas.dataset.cssHeight = String(cssHeight);
  return canvas;
}

function copyCanvas(source) {
  const copy = document.createElement("canvas");
  copy.width = source.width;
  copy.height = source.height;
  copy.style.width = source.style.width;
  copy.style.height = source.style.height;
  copy.dataset.cssWidth = source.dataset.cssWidth;
  copy.dataset.cssHeight = source.dataset.cssHeight;
  copy.getContext("2d", { alpha: false }).drawImage(source, 0, 0);
  return copy;
}

function trimPageCache() {
  const maxPages = 24;
  while (pageCanvasCache.size > maxPages) {
    pageCanvasCache.delete(pageCanvasCache.keys().next().value);
  }
}

function buildFolderBook(scoreId) {
  const startScore = data.scores.find((score) => score.id === scoreId);
  const selectedId = data.settings.selectedFolderId || startScore.folderId;
  const rootFolderId = descendantFolderIds(selectedId).includes(startScore.folderId) ? selectedId : startScore.folderId;
  const scores = folderScoresDeep(rootFolderId);
  const pages = [];
  for (const score of scores) {
    for (const page of score.pages) pages.push({ ...page, scoreId: score.id, title: score.title });
  }
  const startIndex = Math.max(0, pages.findIndex((page) => page.scoreId === scoreId));
  return {
    title: `${data.folders.find((folder) => folder.id === rootFolderId)?.name || "目录"} · 连续翻页`,
    folderId: rootFolderId,
    pages,
    startIndex
  };
}

async function openScore(scoreId) {
  currentScore = data.scores.find((score) => score.id === scoreId);
  currentBook = buildFolderBook(scoreId);
  currentPage = currentBook.startIndex;
  els.viewerTitle.textContent = currentBook.title;
  els.viewer.classList.remove("hidden");
  await renderViewerPages();
  preloadBookPages();
}

function pageCountForView() {
  if (data.settings.fit === "single") return 1;
  if (data.settings.fit === "double") return 2;
  return matchMedia("(orientation: landscape) and (min-width: 900px)").matches ? 2 : 1;
}

function getRenderBounds() {
  const count = pageCountForView();
  const stageRect = $("stage").getBoundingClientRect();
  const gap = count === 2 ? 18 : 0;
  return {
    count,
    maxWidth: Math.max(220, (stageRect.width - 36 - gap) / count),
    maxHeight: Math.max(260, stageRect.height - 36)
  };
}

async function renderViewerPages() {
  if (!currentBook) return;
  const runId = ++renderRunId;
  els.pages.innerHTML = "";
  els.pages.innerHTML = `<div class="page-loading">加载中 ♡</div>`;
  const { count, maxWidth, maxHeight } = getRenderBounds();
  const pageRefs = currentBook.pages.slice(currentPage, currentPage + count);
  const first = currentBook.pages[currentPage];
  els.pageStatus.textContent = `${Math.min(currentPage + 1, currentBook.pages.length)} / ${currentBook.pages.length} · ${first?.title || ""}`;

  const shells = [];
  for (const pageRef of pageRefs) {
    const baseCanvas = await renderPageToCanvas(pageRef, maxWidth, maxHeight);
    if (runId !== renderRunId) return;
    const shell = document.createElement("div");
    shell.className = "page-shell";
    const cssWidth = Number(baseCanvas.dataset.cssWidth) || baseCanvas.width;
    const cssHeight = Number(baseCanvas.dataset.cssHeight) || baseCanvas.height;
    shell.style.width = `${cssWidth}px`;
    shell.style.height = `${cssHeight}px`;
    shell.append(baseCanvas);
    shells.push(shell);
  }
  if (runId !== renderRunId) return;
  els.pages.innerHTML = "";
  els.pages.append(...shells);
}

async function preloadBookPages() {
  if (!currentBook) return;
  const runId = ++preloadRunId;
  const { maxWidth, maxHeight } = getRenderBounds();
  const first = currentBook.pages[currentPage];
  const order = preloadOrder(currentPage, currentBook.pages.length);
  for (const index of order) {
    if (!currentBook || runId !== preloadRunId) return;
    await renderPageToCanvas(currentBook.pages[index], maxWidth, maxHeight);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  if (currentBook) {
    els.pageStatus.textContent = `${currentPage + 1} / ${currentBook.pages.length} · ${first?.title || "预加载完成 ♡"}`;
  }
}

function preloadOrder(start, total) {
  const order = [];
  for (let distance = 0; distance < total; distance++) {
    const forward = start + distance;
    const backward = start - distance;
    if (forward < total) order.push(forward);
    if (distance && backward >= 0) order.push(backward);
  }
  return [...new Set(order)];
}

async function changePage(delta) {
  const count = pageCountForView();
  currentPage = Math.min(Math.max(0, currentPage + delta * count), Math.max(0, currentBook.pages.length - 1));
  await renderViewerPages();
  preloadBookPages();
}

async function toggleFit() {
  const order = ["auto", "single", "double"];
  const index = order.indexOf(data.settings.fit || "auto");
  data.settings.fit = order[(index + 1) % order.length];
  els.fitBtn.textContent = data.settings.fit === "auto" ? "适配" : data.settings.fit === "single" ? "单页" : "双页";
  pageCanvasCache.clear();
  pageRenderJobs.clear();
  await save();
  await renderViewerPages();
  preloadBookPages();
}

function openOrganizer() {
  if (!currentScore) return;
  els.organizer.classList.remove("hidden");
  renderOrganizer();
}

async function renderOrganizer() {
  els.pageSorter.innerHTML = "";
  for (const [index, pageRef] of currentScore.pages.entries()) {
    const card = document.createElement("article");
    card.className = "sort-card";
    card.draggable = true;
    card.dataset.pageId = pageRef.pageId;
    card.innerHTML = `
      <div class="preview">加载中</div>
      <footer>
        <span>第 ${index + 1} 页</span>
        <button class="up subtle" type="button">前移</button>
        <button class="down subtle" type="button">后移</button>
        <button class="delete danger subtle" type="button">删除</button>
      </footer>`;
    card.querySelector(".up").disabled = index === 0;
    card.querySelector(".down").disabled = index === currentScore.pages.length - 1;
    card.querySelector(".up").addEventListener("click", async () => movePage(index, index - 1));
    card.querySelector(".down").addEventListener("click", async () => movePage(index, index + 1));
    card.querySelector(".delete").addEventListener("click", async () => {
      if (currentScore.pages.length <= 1) return alert("至少保留一页。");
      if (!confirm("删除这一页？")) return;
      currentScore.pages.splice(index, 1);
      currentScore.updatedAt = Date.now();
      pageCanvasCache.clear();
      await save();
      renderOrganizer();
    });
    card.addEventListener("dragstart", () => {
      draggingSortId = pageRef.pageId;
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => {
      draggingSortId = null;
      card.classList.remove("dragging");
    });
    card.addEventListener("dragover", (event) => event.preventDefault());
    card.addEventListener("drop", async () => {
      const from = currentScore.pages.findIndex((page) => page.pageId === draggingSortId);
      const to = currentScore.pages.findIndex((page) => page.pageId === pageRef.pageId);
      if (from >= 0 && to >= 0 && from !== to) await movePage(from, to);
    });
    els.pageSorter.append(card);
    const canvas = await renderPageToCanvas(pageRef, 120, 156);
    const preview = card.querySelector(".preview");
    preview.innerHTML = "";
    preview.append(canvas);
  }
}

async function movePage(from, to) {
  const [moved] = currentScore.pages.splice(from, 1);
  currentScore.pages.splice(to, 0, moved);
  currentScore.updatedAt = Date.now();
  pageCanvasCache.clear();
  await save();
  renderOrganizer();
}

async function exportBackup() {
  const Zip = await ensureZipLib();
  const zip = new Zip();
  zip.file("library.json", JSON.stringify(data, null, 2));
  const fileIds = [...new Set(data.scores.flatMap((score) => score.pages.map((page) => page.fileId)))];
  for (const fileId of fileIds) zip.file(`files/${fileId}`, await getFileBlob(fileId));
  const blob = await zip.generateAsync({ type: "blob" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `score-library-backup-${new Date().toISOString().slice(0, 10)}.zip`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function restoreBackup(file) {
  if (!dbAvailable) {
    alert("这个浏览器没有可用的本地数据库，不能恢复谱子文件。请用 iPad Safari 打开。");
    return;
  }
  if (!confirm("恢复备份会覆盖当前这个网址里的本地谱库。继续吗？")) return;
  try {
    const Zip = await ensureZipLib();
    showImportProgress("恢复备份中", "正在读取 zip", 0, 1);
    const zip = await Zip.loadAsync(file);
    const libraryFile = zip.file("library.json");
    if (!libraryFile) throw new Error("这个备份包里没有 library.json");

    const nextData = normalizeLibrary(JSON.parse(await libraryFile.async("string")));
    const fileEntries = Object.values(zip.files).filter((item) => item.name.startsWith("files/") && !item.dir);
    const neededFileIds = new Set(nextData.scores.flatMap((score) => score.pages.map((page) => page.fileId)));
    const missing = [...neededFileIds].filter((fileId) => !zip.file(`files/${fileId}`));
    if (missing.length) throw new Error(`备份包缺少 ${missing.length} 个谱子文件`);

    showImportProgress("恢复备份中", "清理旧数据", 0, fileEntries.length || 1);
    await idbClear("files");
    for (const [index, entry] of fileEntries.entries()) {
      const fileId = entry.name.replace("files/", "");
      showImportProgress("恢复备份中", `正在恢复 ${index + 1} / ${fileEntries.length}`, index, fileEntries.length);
      await idbPut("files", await entry.async("blob"), fileId);
    }

    data = nextData;
    pdfCache.clear();
    pageCanvasCache.clear();
    pageRenderJobs.clear();
    for (const url of urlCache.values()) URL.revokeObjectURL(url);
    urlCache.clear();
    await save();
    render();
    showImportProgress("恢复完成", `恢复了 ${data.folders.length} 个目录、${data.scores.length} 首谱子`, fileEntries.length, fileEntries.length || 1);
    setTimeout(hideImportProgress, 2400);
    alert(`恢复完成：${data.folders.length} 个目录，${data.scores.length} 首谱子。`);
  } catch (error) {
    console.error(error);
    hideImportProgress();
    alert(`恢复失败：${error.message}`);
  }
}

function normalizeLibrary(nextData) {
  nextData ||= {};
  nextData.folders = Array.isArray(nextData.folders) ? nextData.folders : [];
  nextData.scores = Array.isArray(nextData.scores) ? nextData.scores : [];
  nextData.settings ||= {};
  if (!nextData.folders.some((folder) => folder.id === ROOT_ID)) {
    nextData.folders.unshift({ id: ROOT_ID, name: "未整理", parentId: null, createdAt: Date.now() });
  }
  for (const folder of nextData.folders) {
    folder.name ||= "未命名目录";
    if (folder.id === ROOT_ID) folder.parentId = null;
  }
  nextData.scores = nextData.scores.filter((score) => Array.isArray(score.pages) && score.pages.length);
  for (const score of nextData.scores) {
    score.title ||= score.sourceName || "未命名谱子";
    score.folderId ||= ROOT_ID;
    if (!nextData.folders.some((folder) => folder.id === score.folderId)) score.folderId = ROOT_ID;
  }
  nextData.settings.selectedFolderId = ROOT_ID;
  nextData.settings.fit ||= "auto";
  nextData.settings.thumbnails = false;
  nextData.settings.expandedFolderIds = nextData.folders.map((folder) => folder.id);
  delete nextData.annotations;
  return nextData;
}

function bindEvents() {
  $("addFolderBtn").addEventListener("click", addFolder);
  $("renameFolderBtn").addEventListener("click", renameFolder);
  $("deleteFolderBtn").addEventListener("click", deleteFolder);
  $("importBtn").addEventListener("click", () => els.fileInput.click());
  $("dropImportBtn").addEventListener("click", () => els.fileInput.click());
  $("restoreBtn").addEventListener("click", () => els.restoreInput.click());
  $("backupBtn").addEventListener("click", exportBackup);
  $("sidebarToggle").addEventListener("click", () => document.body.classList.toggle("sidebar-open"));
  $("installHelpBtn").addEventListener("click", () => els.helpDialog.showModal());
  els.searchInput.addEventListener("input", renderLibrary);
  els.fileInput.addEventListener("change", async () => {
    if (fileInputMode === "append") await appendFilesToScore(els.fileInput.files);
    else await importFiles(els.fileInput.files);
    fileInputMode = "import";
    els.fileInput.value = "";
  });
  els.restoreInput.addEventListener("change", async () => {
    if (els.restoreInput.files[0]) await restoreBackup(els.restoreInput.files[0]);
    els.restoreInput.value = "";
  });
  for (const eventName of ["dragenter", "dragover"]) {
    els.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropZone.classList.add("dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    els.dropZone.addEventListener(eventName, () => els.dropZone.classList.remove("dragging"));
  }
  els.dropZone.addEventListener("drop", async (event) => {
    event.preventDefault();
    await importFiles(event.dataTransfer.files);
  });
  $("closeViewerBtn").addEventListener("click", () => {
    els.viewer.classList.add("hidden");
    currentBook = null;
    currentScore = null;
    render();
  });
  $("prevPageBtn").addEventListener("click", () => changePage(-1));
  $("nextPageBtn").addEventListener("click", () => changePage(1));
  $("fitBtn").addEventListener("click", toggleFit);
  $("organizeBtn").addEventListener("click", openOrganizer);
  $("closeOrganizerBtn").addEventListener("click", async () => {
    els.organizer.classList.add("hidden");
    await save();
    if (currentScore) {
      currentBook = buildFolderBook(currentScore.id);
      currentPage = currentBook.startIndex;
      await renderViewerPages();
      preloadBookPages();
    }
  });
  $("addMorePagesBtn").addEventListener("click", () => {
    fileInputMode = "append";
    els.fileInput.click();
  });
  addEventListener("resize", () => {
    pageCanvasCache.clear();
    if (currentBook && !els.viewer.classList.contains("hidden")) renderViewerPages();
  });
  addEventListener("keydown", (event) => {
    if (!currentBook) return;
    if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") changePage(1);
    if (event.key === "ArrowLeft" || event.key === "PageUp") changePage(-1);
  });
}

async function init() {
  await load();
  bindEvents();
  render();
  updateStorageStatus();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
}

init().catch((error) => {
  console.error(error);
  alert(`启动失败：${error.message}`);
});
