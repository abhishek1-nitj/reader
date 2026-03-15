import React, { useEffect, useMemo, useRef, useState } from "react";

const STORAGE_KEY = "reader-library-v1";
const SETTINGS_KEY = "reader-settings-v1";
const LIBRARY_DB_NAME = "reader-library-db";
const LIBRARY_STORE_NAME = "reader-library-store";
const LIBRARY_RECORD_KEY = "library-state";
const CHROME_REVEAL_HEIGHT = 90;
const IMPORT_STATUS_TIMEOUT_MS = 5000;
const MIN_SIZE = 14;
const MAX_SIZE = 72;
const MIN_LINE_HEIGHT = 1;
const MAX_LINE_HEIGHT = 2.4;
const FONT_STEP = 1;
const LINE_HEIGHT_STEP = 0.02;

let pdfJsLoader = null;

async function loadPdfJs() {
  if (!pdfJsLoader) {
    pdfJsLoader = import("pdfjs-dist").then((module) => {
      module.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      return module;
    });
  }

  return pdfJsLoader;
}

function normalizeText(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/\t/g, "    ").replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildReaderHtml(text, highlight) {
  const safeText = text || "";
  if (!highlight || typeof highlight.start !== "number" || typeof highlight.end !== "number") {
    return escapeHtml(safeText).replace(/\n/g, "<br>");
  }

  const start = Math.max(0, Math.min(safeText.length, highlight.start));
  const end = Math.max(start, Math.min(safeText.length, highlight.end));
  const before = escapeHtml(safeText.slice(0, start));
  const middle = escapeHtml(safeText.slice(start, end));
  const after = escapeHtml(safeText.slice(end));
  return `${before}<mark>${middle}</mark>${after}`.replace(/\n/g, "<br>");
}

function loadLibraryState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return {
      novels: Array.isArray(parsed.novels) ? parsed.novels : [],
      activeNovelId: typeof parsed.activeNovelId === "string" ? parsed.activeNovelId : null
    };
  } catch {
    return { novels: [], activeNovelId: null };
  }
}

let libraryDatabasePromise = null;

function openLibraryDatabase() {
  if (!libraryDatabasePromise) {
    libraryDatabasePromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(LIBRARY_DB_NAME, 1);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(LIBRARY_STORE_NAME)) {
          database.createObjectStore(LIBRARY_STORE_NAME);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Unable to open IndexedDB."));
    });
  }

  return libraryDatabasePromise;
}

async function readLibraryStateFromIndexedDb() {
  const database = await openLibraryDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(LIBRARY_STORE_NAME, "readonly");
    const store = transaction.objectStore(LIBRARY_STORE_NAME);
    const request = store.get(LIBRARY_RECORD_KEY);

    request.onsuccess = () => {
      const parsed = request.result;
      resolve({
        novels: Array.isArray(parsed?.novels) ? parsed.novels : [],
        activeNovelId: typeof parsed?.activeNovelId === "string" ? parsed.activeNovelId : null
      });
    };
    request.onerror = () => reject(request.error || new Error("Unable to read library from IndexedDB."));
  });
}

async function writeLibraryStateToIndexedDb(nextState) {
  const database = await openLibraryDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(LIBRARY_STORE_NAME, "readwrite");
    const store = transaction.objectStore(LIBRARY_STORE_NAME);
    store.put(nextState, LIBRARY_RECORD_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Unable to save library to IndexedDB."));
    transaction.onabort = () => reject(transaction.error || new Error("Saving library to IndexedDB was aborted."));
  });
}

function loadAppSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveAppSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function clampFontSize(value) {
  if (Number.isNaN(value)) return 17;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, value));
}

function clampLineHeight(value) {
  if (Number.isNaN(value)) return 1.35;
  return Math.min(MAX_LINE_HEIGHT, Math.max(MIN_LINE_HEIGHT, value));
}

function createNovel(title) {
  const settings = loadAppSettings();
  const now = Date.now();
  return {
    id: `novel-${now}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    content: "",
    scrollTop: 0,
    highlight: null,
    fontSize: clampFontSize(parseInt(String(settings.fontSize || 17), 10)),
    lineHeight: clampLineHeight(parseFloat(String(settings.lineHeight || 1.35))),
    updatedAt: now
  };
}

function cleanPdfTitle(value) {
  if (typeof value !== "string") return "";
  const title = normalizeText(value.replace(/\0/g, " ")).replace(/\s+/g, " ").trim();
  if (!title) return "";

  const lowered = title.toLowerCase();
  if (["untitled", "microsoft word", "default", "document", "pdf"].includes(lowered)) {
    return "";
  }

  return title.length > 160 ? title.slice(0, 160).trim() : title;
}

function titleFromFilename(filename) {
  const base = (filename || "").replace(/\.pdf$/i, "");
  return cleanPdfTitle(base.replace(/[_-]+/g, " "));
}

function inferTitleFromText(text) {
  const candidates = normalizeText(text)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return (
    candidates.find((line) => line.length >= 4 && line.length <= 120 && line.split(/\s+/).length <= 14) ||
    candidates.find((line) => line.length <= 160) ||
    ""
  );
}

function derivePdfTitle(metadata, text, filename) {
  const metadataTitle =
    cleanPdfTitle(metadata?.info?.Title) ||
    cleanPdfTitle(metadata?.metadata?.get?.("dc:title")) ||
    cleanPdfTitle(metadata?.contentDispositionFilename);

  return metadataTitle || cleanPdfTitle(inferTitleFromText(text)) || titleFromFilename(filename) || "Imported PDF";
}

function joinPdfLineSegments(segments) {
  return segments.reduce((line, segment, index) => {
    const text = segment.str.replace(/\s+/g, " ").trim();
    if (!text) return line;
    if (index === 0) return text;

    const previous = segments[index - 1];
    const previousText = previous.str.replace(/\s+/g, " ").trim();
    const previousRight = Number(previous.transform?.[4] || 0) + Number(previous.width || 0);
    const currentLeft = Number(segment.transform?.[4] || 0);
    const gap = currentLeft - previousRight;
    const needsSpace =
      gap > 1.5 &&
      !/[-/(\[]$/.test(previousText) &&
      !/^[,.;:!?%)\]]/.test(text);

    return `${line}${needsSpace ? " " : ""}${text}`;
  }, "");
}

function extractPageText(textContent) {
  const positionedItems = textContent.items
    .filter((item) => typeof item?.str === "string" && item.str.trim())
    .map((item) => ({
      ...item,
      y: Math.round(Number(item.transform?.[5] || 0) * 10) / 10,
      x: Number(item.transform?.[4] || 0)
    }));

  if (positionedItems.length === 0) return "";

  const linesByY = new Map();
  positionedItems.forEach((item) => {
    const key = String(item.y);
    const existing = linesByY.get(key) || [];
    existing.push(item);
    linesByY.set(key, existing);
  });

  const lines = Array.from(linesByY.entries())
    .map(([y, items]) => ({
      y: Number(y),
      text: joinPdfLineSegments(items.sort((a, b) => a.x - b.x))
    }))
    .filter((line) => line.text)
    .sort((a, b) => b.y - a.y);

  if (lines.length === 0) return "";

  const gaps = [];
  for (let index = 1; index < lines.length; index += 1) {
    gaps.push(Math.abs(lines[index - 1].y - lines[index].y));
  }
  const sortedGaps = gaps.slice().sort((a, b) => a - b);
  const baselineGap = sortedGaps[Math.floor(sortedGaps.length / 2)] || 12;

  return lines
    .map((line, index) => {
      if (index === 0) return line.text;
      const gap = Math.abs(lines[index - 1].y - line.y);
      return `${gap > baselineGap * 1.45 ? "\n\n" : "\n"}${line.text}`;
    })
    .join("");
}

function getTextOffset(root, node, nodeOffset) {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, nodeOffset);
  return range.toString().length;
}

function buildReaderHash(novelId) {
  return `#reader=${encodeURIComponent(novelId)}`;
}

function getNovelIdFromHash() {
  const hash = window.location.hash || "";
  if (!hash.startsWith("#reader=")) return null;
  const encodedNovelId = hash.slice("#reader=".length);
  return encodedNovelId ? decodeURIComponent(encodedNovelId) : null;
}

export default function App() {
  const initialSettings = useMemo(() => loadAppSettings(), []);
  const [novels, setNovels] = useState([]);
  const [activeNovelId, setActiveNovelId] = useState(null);
  const [viewMode, setViewMode] = useState("library");
  const [titleInput, setTitleInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const [fontSize, setFontSize] = useState(clampFontSize(parseInt(String(initialSettings.fontSize || 17), 10)));
  const [lineHeight, setLineHeight] = useState(clampLineHeight(parseFloat(String(initialSettings.lineHeight || 1.35))));
  const [showChrome, setShowChrome] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [highlightMenu, setHighlightMenu] = useState({ visible: false, x: 0, y: 0, start: 0, end: 0, content: "" });
  const [supabaseUrlInput, setSupabaseUrlInput] = useState(initialSettings.supabaseUrl || "");
  const [supabaseAnonKeyInput, setSupabaseAnonKeyInput] = useState(initialSettings.supabaseAnonKey || "");
  const [settingsStatus, setSettingsStatus] = useState(initialSettings.lastSyncMessage || "");
  const [pageMetrics, setPageMetrics] = useState({ current: 1, total: 1 });
  const [pdfImportStatus, setPdfImportStatus] = useState("");
  const [isImportingPdf, setIsImportingPdf] = useState(false);
  const [isLibraryReady, setIsLibraryReady] = useState(false);

  const readerRef = useRef(null);
  const pdfInputRef = useRef(null);
  const previousRenderedNovelIdRef = useRef(null);
  const saveTimerRef = useRef(null);
  const scrollTimerRef = useRef(null);
  const syncTimerRef = useRef(null);
  const importStatusTimerRef = useRef(null);
  const routeInitializedRef = useRef(false);
  const syncInFlightRef = useRef(false);
  const syncingSuppressedRef = useRef(false);
  const deletedNovelIdsRef = useRef(Array.isArray(initialSettings.deletedNovelIds) ? initialSettings.deletedNovelIds : []);

  const activeNovel = novels.find((novel) => novel.id === activeNovelId) || null;

  const sortedNovels = useMemo(
    () => [...novels].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    [novels]
  );

  const matchingNovels = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (!normalizedQuery) return sortedNovels.slice(0, 8);
    return sortedNovels.filter((novel) => (novel.title || "").toLowerCase().includes(normalizedQuery)).slice(0, 8);
  }, [searchQuery, sortedNovels]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateLibrary() {
      try {
        const indexedState = await readLibraryStateFromIndexedDb();
        const legacyState = loadLibraryState();
        const shouldMigrateLegacy = indexedState.novels.length === 0 && legacyState.novels.length > 0;
        const nextState = shouldMigrateLegacy ? legacyState : indexedState;

        if (shouldMigrateLegacy) {
          await writeLibraryStateToIndexedDb(nextState);
          localStorage.removeItem(STORAGE_KEY);
        }

        if (cancelled) return;
        setNovels(nextState.novels);
        setActiveNovelId(nextState.activeNovelId);
      } catch (error) {
        if (cancelled) return;
        const legacyState = loadLibraryState();
        setNovels(legacyState.novels);
        setActiveNovelId(legacyState.activeNovelId);
        setPdfImportStatus(error instanceof Error ? error.message : "Unable to load saved books.");
      } finally {
        if (!cancelled) {
          setIsLibraryReady(true);
        }
      }
    }

    void hydrateLibrary();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isLibraryReady) return;

    void writeLibraryStateToIndexedDb({
      novels,
      activeNovelId
    }).catch((error) => {
      setPdfImportStatus(error instanceof Error ? error.message : "Unable to save the library.");
    });
  }, [activeNovelId, isLibraryReady, novels]);

  useEffect(() => {
    saveAppSettings({
      ...loadAppSettings(),
      fontSize,
      lineHeight,
      supabaseUrl: supabaseUrlInput.trim(),
      supabaseAnonKey: supabaseAnonKeyInput.trim(),
      lastSyncMessage: settingsStatus,
      deletedNovelIds: deletedNovelIdsRef.current
    });
  }, [fontSize, lineHeight, settingsStatus, supabaseUrlInput, supabaseAnonKeyInput]);

  useEffect(() => {
    if (activeNovel) {
      setTitleInput(activeNovel.title || "");
    } else if (viewMode === "library") {
      setTitleInput("");
    }
  }, [activeNovel, viewMode]);

  useEffect(() => {
    if (!activeNovel) return;
    setFontSize(clampFontSize(parseInt(String(activeNovel.fontSize || 17), 10)));
    setLineHeight(clampLineHeight(parseFloat(String(activeNovel.lineHeight || 1.35))));
  }, [activeNovel?.id, activeNovel?.fontSize, activeNovel?.lineHeight]);

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader) return;

    const desiredContent = activeNovel?.content || "";
    const desiredHighlight = activeNovel?.highlight || null;
    const desiredMarkedText = desiredHighlight ? desiredContent.slice(desiredHighlight.start, desiredHighlight.end) : null;
    const currentContent = normalizeText(reader.innerText || "");
    const currentMarkedText = reader.querySelector("mark")?.innerText ?? null;
    const novelChanged = previousRenderedNovelIdRef.current !== (activeNovel?.id || null);

    if (novelChanged || currentContent !== desiredContent || currentMarkedText !== desiredMarkedText) {
      reader.innerHTML = buildReaderHtml(desiredContent, desiredHighlight);
    }

    if (novelChanged) {
      reader.scrollTop = activeNovel?.scrollTop || 0;
    }

    previousRenderedNovelIdRef.current = activeNovel?.id || null;
    updatePageMetrics();
  }, [activeNovel?.content, activeNovel?.highlight, activeNovel?.id]);

  useEffect(() => {
    const handleBeforeUnload = () => flushPendingSaves();
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        flushPendingSaves();
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", handleBeforeUnload);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("pagehide", handleBeforeUnload);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  useEffect(() => {
    window.clearTimeout(importStatusTimerRef.current);
    if (!pdfImportStatus || isImportingPdf) return undefined;

    importStatusTimerRef.current = window.setTimeout(() => {
      setPdfImportStatus("");
    }, IMPORT_STATUS_TIMEOUT_MS);

    return () => {
      window.clearTimeout(importStatusTimerRef.current);
    };
  }, [isImportingPdf, pdfImportStatus]);

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (event.target.closest(".highlight-menu")) return;
      setHighlightMenu((current) => (current.visible ? { visible: false, x: 0, y: 0, start: 0, end: 0, content: "" } : current));
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, []);

  useEffect(() => {
    if (!isLibraryReady) return;
    setViewMode("library");
    if (!getNovelIdFromHash()) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    if (getSyncConfig().isConfigured) {
      void syncWithSupabase();
    }
  }, [isLibraryReady]);

  useEffect(() => {
    if (!isLibraryReady) return undefined;

    const applyRoute = () => {
      const novelId = getNovelIdFromHash();
      if (novelId && novels.some((novel) => novel.id === novelId)) {
        setActiveNovelId(novelId);
        setViewMode("reader");
        setShowChrome(false);
        setHighlightMenu({ visible: false, x: 0, y: 0, start: 0, end: 0, content: "" });
      } else {
        flushPendingSaves();
        showLibraryView();
      }
    };

    if (!routeInitializedRef.current) {
      routeInitializedRef.current = true;
      applyRoute();
    }

    window.addEventListener("hashchange", applyRoute);
    return () => {
      window.removeEventListener("hashchange", applyRoute);
    };
  }, [isLibraryReady, novels]);

  function getSettingsWithDeviceId() {
    const settings = loadAppSettings();
    if (!settings.deviceId) {
      settings.deviceId = window.crypto.randomUUID();
      saveAppSettings(settings);
    }
    return settings;
  }

  function getSyncConfig() {
    const settings = getSettingsWithDeviceId();
    const supabaseUrl = (supabaseUrlInput || settings.supabaseUrl || "").trim().replace(/\/+$/, "");
    const supabaseAnonKey = (supabaseAnonKeyInput || settings.supabaseAnonKey || "").trim();
    return {
      ...settings,
      supabaseUrl,
      supabaseAnonKey,
      isConfigured: Boolean(supabaseUrl && supabaseAnonKey)
    };
  }

  function updatePageMetrics() {
    const reader = readerRef.current;
    if (!reader) return;
    const total = Math.max(1, Math.ceil(reader.scrollHeight / Math.max(reader.clientHeight, 1)));
    const current = Math.min(total, Math.max(1, Math.floor(reader.scrollTop / Math.max(reader.clientHeight, 1)) + 1));
    setPageMetrics({ current, total });
  }

  function updateNovelById(id, updater) {
    setNovels((current) =>
      current.map((novel) => {
        if (novel.id !== id) return novel;
        return updater(novel);
      })
    );
  }

  function clearPendingTimers() {
    window.clearTimeout(saveTimerRef.current);
    window.clearTimeout(scrollTimerRef.current);
    window.clearTimeout(syncTimerRef.current);
  }

  function persistLibrarySnapshot(nextNovels, nextActiveNovelId) {
    if (!isLibraryReady) {
      return Promise.resolve();
    }

    return writeLibraryStateToIndexedDb({
      novels: nextNovels,
      activeNovelId: nextActiveNovelId
    }).catch((error) => {
      setPdfImportStatus(error instanceof Error ? error.message : "Unable to save the library.");
    });
  }

  function persistDeletedNovelIds(nextDeletedNovelIds) {
    deletedNovelIdsRef.current = nextDeletedNovelIds;
    saveAppSettings({
      ...loadAppSettings(),
      fontSize,
      lineHeight,
      supabaseUrl: supabaseUrlInput.trim(),
      supabaseAnonKey: supabaseAnonKeyInput.trim(),
      lastSyncMessage: settingsStatus,
      deletedNovelIds: nextDeletedNovelIds
    });
  }

  function commitLibraryState(nextNovels, nextActiveNovelId = activeNovelId) {
    setNovels(nextNovels);
    setActiveNovelId(nextActiveNovelId);
    return persistLibrarySnapshot(nextNovels, nextActiveNovelId);
  }

  function getSelectionHighlightRange() {
    const reader = readerRef.current;
    const selection = window.getSelection();
    if (!reader || !selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!reader.contains(range.commonAncestorContainer)) return null;
    const selectedText = selection.toString();
    if (!selectedText.trim()) return null;

    const start = getTextOffset(reader, range.startContainer, range.startOffset);
    const end = getTextOffset(reader, range.endContainer, range.endOffset);
    if (end <= start) return null;

    const content = normalizeText(reader.innerText || "");
    const middle = content.slice(start, end);
    if (!middle.trim()) return null;

    return {
      start,
      end,
      content
    };
  }

  function applyFontSize(nextValue) {
    const next = clampFontSize(nextValue);
    setFontSize(next);
    if (activeNovel) {
      updateNovelById(activeNovel.id, (novel) => ({
        ...novel,
        fontSize: next,
        updatedAt: Date.now()
      }));
      queueAutoSync();
    }
  }

  function applyLineHeight(nextValue) {
    const next = clampLineHeight(nextValue);
    setLineHeight(next);
    if (activeNovel) {
      updateNovelById(activeNovel.id, (novel) => ({
        ...novel,
        lineHeight: next,
        updatedAt: Date.now()
      }));
      queueAutoSync();
    }
  }

  function queueAutoSync() {
    const config = getSyncConfig();
    if (!config.isConfigured || syncingSuppressedRef.current) return;
    window.clearTimeout(syncTimerRef.current);
    syncTimerRef.current = window.setTimeout(() => {
      void syncWithSupabase();
    }, 700);
  }

  function flushPendingSaves() {
    clearPendingTimers();
    const snapshot = persistSnapshotToStorage();
    saveCurrentNovelFromReader();
    return snapshot;
  }

  function buildCurrentSnapshot() {
    if (!activeNovel || !readerRef.current) {
      return { nextNovels: novels, nextActiveNovelId: activeNovelId };
    }

    const content = normalizeText(readerRef.current.innerText || "");
    const now = Date.now();
    const nextNovels = novels.map((novel) =>
      novel.id === activeNovel.id
        ? {
            ...novel,
            title: (titleInput || novel.title || "Untitled Novel").trim(),
            content,
            scrollTop: readerRef.current.scrollTop,
            fontSize,
            lineHeight,
            updatedAt: now
          }
        : novel
    );

    return {
      nextNovels,
      nextActiveNovelId: activeNovelId
    };
  }

  function persistSnapshotToStorage() {
    const snapshot = buildCurrentSnapshot();
    void persistLibrarySnapshot(snapshot.nextNovels, snapshot.nextActiveNovelId);
    return snapshot;
  }

  function saveCurrentNovelFromReader() {
    if (!activeNovel || !readerRef.current) return;
    const snapshot = buildCurrentSnapshot();
    void commitLibraryState(snapshot.nextNovels, snapshot.nextActiveNovelId);
    queueAutoSync();
  }

  function queueSave() {
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveCurrentNovelFromReader();
    }, 180);
  }

  function queueScrollSave() {
    window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(() => {
      if (!activeNovel || !readerRef.current) return;
      updateNovelById(activeNovel.id, (novel) => ({
        ...novel,
        scrollTop: readerRef.current.scrollTop,
        updatedAt: Date.now()
      }));
      queueAutoSync();
    }, 120);
  }

  function ensureActiveNovel() {
    if (activeNovel) return activeNovel;
    const novel = createNovel((titleInput || "").trim() || `Novel ${novels.length + 1}`);
    novel.fontSize = fontSize;
    novel.lineHeight = lineHeight;
    commitLibraryState([...novels, novel], novel.id);
    return novel;
  }

  function showLibraryView() {
    setViewMode("library");
    setShowChrome(false);
    setHighlightMenu({ visible: false, x: 0, y: 0, start: 0, end: 0, content: "" });
  }

  function openNovel(id, { updateHash = true, skipFlush = false } = {}) {
    if (!skipFlush) {
      flushPendingSaves();
    }
    setActiveNovelId(id);
    setViewMode("reader");
    setShowChrome(false);
    setHighlightMenu({ visible: false, x: 0, y: 0, start: 0, end: 0, content: "" });

    if (updateHash && window.location.hash !== buildReaderHash(id)) {
      window.location.hash = buildReaderHash(id);
    }
  }

  function handleOpenNovel(id) {
    openNovel(id);
  }

  function handleBackToLibrary() {
    flushPendingSaves();
    if (getNovelIdFromHash()) {
      window.history.back();
      return;
    }

    showLibraryView();
  }

  function handleNewNovel() {
    flushPendingSaves();
    setActiveNovelId(null);
    setTitleInput("");
    if (readerRef.current) {
      readerRef.current.innerHTML = "";
      readerRef.current.scrollTop = 0;
    }
    previousRenderedNovelIdRef.current = null;
    showLibraryView();
    updatePageMetrics();
  }

  function handleDeleteNovel(id) {
    const novelToDelete = novels.find((novel) => novel.id === id);
    if (!novelToDelete) return;

    const confirmed = window.confirm(`Delete "${novelToDelete.title || "Untitled Novel"}"?`);
    if (!confirmed) return;

    clearPendingTimers();
    const snapshot = activeNovelId === id ? { nextNovels: novels, nextActiveNovelId: activeNovelId } : buildCurrentSnapshot();
    const nextNovels = snapshot.nextNovels.filter((novel) => novel.id !== id);
    const nextActiveNovelId = activeNovelId === id ? null : activeNovelId;
    const nextDeletedNovelIds = Array.from(new Set([...deletedNovelIdsRef.current, id]));

    persistDeletedNovelIds(nextDeletedNovelIds);
    commitLibraryState(nextNovels, nextActiveNovelId);
    setHighlightMenu({ visible: false, x: 0, y: 0, start: 0, end: 0, content: "" });

    if (activeNovelId === id) {
      showLibraryView();
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      setTitleInput("");
      if (readerRef.current) {
        readerRef.current.innerHTML = "";
        readerRef.current.scrollTop = 0;
      }
      previousRenderedNovelIdRef.current = null;
      updatePageMetrics();
    }

    queueAutoSync();
  }

  function handleRenameNovel(id) {
    const novelToRename = novels.find((novel) => novel.id === id);
    if (!novelToRename) return;

    const nextTitle = window.prompt("Edit book title", novelToRename.title || "Untitled Novel");
    if (nextTitle == null) return;

    const trimmedTitle = nextTitle.trim() || "Untitled Novel";
    const nextNovels = novels.map((novel) =>
      novel.id === id
        ? {
            ...novel,
            title: trimmedTitle,
            updatedAt: Date.now()
          }
        : novel
    );
    void commitLibraryState(nextNovels, activeNovelId);

    if (activeNovelId === id) {
      setTitleInput(trimmedTitle);
    }

    setPdfImportStatus(`Renamed to "${trimmedTitle}".`);
    queueAutoSync();
  }

  async function extractPdfBook(file, onProgress) {
    const { getDocument } = await loadPdfJs();
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = getDocument({
      data: arrayBuffer,
      useWorkerFetch: false,
      isEvalSupported: false
    });

    const pdf = await loadingTask.promise;
    const metadata = await pdf.getMetadata().catch(() => null);
    const pages = [];

    onProgress?.(`Reading 0 of ${pdf.numPages} pages...`);

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageText = extractPageText(textContent);
      if (pageText) {
        pages.push(pageText);
      }

      if (pageNumber === pdf.numPages || pageNumber % 20 === 0) {
        onProgress?.(`Reading ${pageNumber} of ${pdf.numPages} pages...`);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }

    const content = normalizeText(pages.join("\n\n"));
    if (!content) {
      throw new Error("No readable text was found in this PDF.");
    }

    return {
      title: derivePdfTitle(metadata, content, file.name),
      content
    };
  }

  async function handlePdfSelection(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    flushPendingSaves();
    setIsImportingPdf(true);
    setPdfImportStatus(`Importing ${file.name}...`);

    try {
      const importedBook = await extractPdfBook(file, (message) => {
        setPdfImportStatus(`${file.name}: ${message}`);
      });
      const novel = createNovel(importedBook.title);
      novel.title = importedBook.title;
      novel.content = importedBook.content;
      novel.updatedAt = Date.now();

      const nextNovels = [...novels, novel];
      await commitLibraryState(nextNovels, novel.id);
      setTitleInput(novel.title);
      setSearchQuery("");
      previousRenderedNovelIdRef.current = null;
      openNovel(novel.id, { skipFlush: true });
      setPdfImportStatus(`Imported "${novel.title}".`);
      queueAutoSync();
    } catch (error) {
      const message = error instanceof Error ? error.message : "PDF import failed.";
      setPdfImportStatus(message);
    } finally {
      setIsImportingPdf(false);
    }
  }

  function handleSaveNovel() {
    const title = (titleInput || "").trim() || "Untitled Novel";
    if (!activeNovel) {
      const novel = createNovel(title);
      novel.content = normalizeText(readerRef.current?.innerText || "");
      novel.fontSize = fontSize;
      novel.lineHeight = lineHeight;
      void commitLibraryState([...novels, novel], novel.id);
      queueAutoSync();
      return;
    }

    saveCurrentNovelFromReader();
    const nextNovels = novels.map((novel) =>
      novel.id === activeNovel.id
        ? {
            ...novel,
            title,
            updatedAt: Date.now()
          }
        : novel
    );
    void commitLibraryState(nextNovels, activeNovel.id);
    queueAutoSync();
  }

  function handleTitleChange(value) {
    setTitleInput(value);
    if (!activeNovel) return;
    const nextNovels = novels.map((novel) =>
      novel.id === activeNovel.id
        ? {
            ...novel,
            title: (value || novel.title || "Untitled Novel").trim(),
            updatedAt: Date.now()
          }
        : novel
    );
    void commitLibraryState(nextNovels, activeNovel.id);
    queueAutoSync();
  }

  function handleReaderInput() {
    const novel = ensureActiveNovel();
    if (!novel) return;
    setHighlightMenu({ visible: false, x: 0, y: 0, start: 0, end: 0, content: "" });
    updateNovelById(novel.id, (current) => ({
      ...current,
      updatedAt: Date.now()
    }));
    queueSave();
    updatePageMetrics();
  }

  function handleReaderPaste(event) {
    event.preventDefault();
    const text = normalizeText(event.clipboardData?.getData("text/plain") || "");
    if (!text) return;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      document.execCommand("insertText", false, text);
    } else {
      selection.deleteFromDocument();
      selection.getRangeAt(0).insertNode(document.createTextNode(text));
      selection.collapseToEnd();
    }
    handleReaderInput();
  }

  function applyHighlightFromMenu() {
    const reader = readerRef.current;
    const novel = ensureActiveNovel();
    if (!reader || !novel || !highlightMenu.visible) return;

    const nextHighlight = {
      start: highlightMenu.start,
      end: highlightMenu.end
    };

    const nextNovels = novels.map((entry) =>
      entry.id === novel.id
        ? {
            ...entry,
            content: highlightMenu.content || normalizeText(reader.innerText || ""),
            highlight: nextHighlight,
            scrollTop: reader.scrollTop,
            fontSize,
            lineHeight,
            updatedAt: Date.now()
          }
        : entry
    );
    commitLibraryState(nextNovels, novel.id);
    setHighlightMenu({ visible: false, x: 0, y: 0, start: 0, end: 0, content: "" });
    queueAutoSync();
  }

  function openSettings() {
    const settings = getSettingsWithDeviceId();
    setSupabaseUrlInput(settings.supabaseUrl || "");
    setSupabaseAnonKeyInput(settings.supabaseAnonKey || "");
    setSettingsStatus(settings.lastSyncMessage || "");
    setSettingsOpen(true);
  }

  function serializeNovelForSync(novel, config) {
    return {
      id: novel.id,
      user_id: config.deviceId,
      title: novel.title || "Untitled Novel",
      content: novel.content || "",
      scroll_top: Math.max(0, Math.floor(novel.scrollTop || 0)),
      highlight_start: novel.highlight?.start ?? null,
      highlight_end: novel.highlight?.end ?? null,
      font_size: clampFontSize(parseInt(String(novel.fontSize || 17), 10)),
      line_height: clampLineHeight(parseFloat(String(novel.lineHeight || 1.35))),
      is_active: novel.id === activeNovelId,
      client_updated_at: new Date(novel.updatedAt || Date.now()).toISOString()
    };
  }

  function applyRemoteNovels(rows) {
    setNovels((current) => {
      const byId = new Map(current.map((novel) => [novel.id, novel]));
      let nextActiveNovelId = activeNovelId;

      rows.forEach((row) => {
        const remoteTime = Date.parse(row.client_updated_at || row.updated_at || 0);
        const local = byId.get(row.id);
        if (local && (local.updatedAt || 0) > remoteTime) return;

        byId.set(row.id, {
          id: row.id,
          title: row.title || "Untitled Novel",
          content: row.content || "",
          scrollTop: row.scroll_top || 0,
          highlight:
            row.highlight_start == null || row.highlight_end == null
              ? null
              : { start: row.highlight_start, end: row.highlight_end },
          fontSize: clampFontSize(parseInt(String(row.font_size || 17), 10)),
          lineHeight: clampLineHeight(parseFloat(String(row.line_height || 1.35))),
          updatedAt: remoteTime || Date.now()
        });

        if (row.is_active) {
          nextActiveNovelId = row.id;
        }
      });

      if (nextActiveNovelId !== activeNovelId) {
        setActiveNovelId(nextActiveNovelId);
      }
      return Array.from(byId.values());
    });
  }

  async function pullFromSupabase(config) {
    const url = `${config.supabaseUrl}/rest/v1/reader_novels?user_id=eq.${encodeURIComponent(config.deviceId)}&select=*`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${config.supabaseAnonKey}`
      }
    });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Pull failed (${response.status})${details ? `: ${details}` : ""}`);
    }
    const rows = await response.json();
    applyRemoteNovels(Array.isArray(rows) ? rows : []);
  }

  async function pushToSupabase(config, sourceNovels) {
    if (sourceNovels.length === 0) return;
    const payload = sourceNovels.map((novel) => serializeNovelForSync(novel, config));
    const response = await fetch(`${config.supabaseUrl}/rest/v1/reader_novels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${config.supabaseAnonKey}`
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Push failed (${response.status})${details ? `: ${details}` : ""}`);
    }
  }

  async function deleteFromSupabase(config, novelIds) {
    if (novelIds.length === 0) return;

    const inFilter = novelIds.map((id) => `"${id.replace(/"/g, '\\"')}"`).join(",");
    const url = `${config.supabaseUrl}/rest/v1/reader_novels?user_id=eq.${encodeURIComponent(config.deviceId)}&id=in.(${inFilter})`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Prefer: "return=minimal",
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${config.supabaseAnonKey}`
      }
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Delete failed (${response.status})${details ? `: ${details}` : ""}`);
    }
  }

  async function syncWithSupabase({ manual = false } = {}) {
    const config = getSyncConfig();
    if (!config.isConfigured) {
      if (manual) {
        setSettingsStatus("Enter the Supabase URL and anon key first.");
      }
      return;
    }

    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;

    try {
      const snapshot = flushPendingSaves();
      await pushToSupabase(config, snapshot.nextNovels);
      await deleteFromSupabase(config, deletedNovelIdsRef.current);
      syncingSuppressedRef.current = true;
      await pullFromSupabase(config);
      syncingSuppressedRef.current = false;

      const message = `Last synced ${new Date().toLocaleString()}`;
      setSettingsStatus(message);
      saveAppSettings({
        ...getSettingsWithDeviceId(),
        supabaseUrl: config.supabaseUrl,
        supabaseAnonKey: config.supabaseAnonKey,
        lastSyncMessage: message,
        deletedNovelIds: []
      });
      deletedNovelIdsRef.current = [];
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync failed";
      setSettingsStatus(message);
    } finally {
      syncingSuppressedRef.current = false;
      syncInFlightRef.current = false;
    }
  }

  return (
    <div
      className={`app-shell ${viewMode === "reader" ? "reader-mode" : "library-mode"}`}
      style={{
        "--font-size": `${fontSize}px`,
        "--line-height": lineHeight
      }}
    >
      <aside className="library-pane" aria-label="Novel library">
        <div className="library-header">
          <h1>Novels</h1>
        </div>

        <div className="library-actions">
          <input
            ref={pdfInputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="file-input"
            onChange={handlePdfSelection}
          />
          <button
            className="import-card"
            type="button"
            onClick={() => pdfInputRef.current?.click()}
            disabled={isImportingPdf || !isLibraryReady}
          >
            <span className="import-card-kicker">{isImportingPdf ? "Importing PDF" : "Attach PDF"}</span>
            <span className="import-card-title">
              {isImportingPdf ? "Reading pages and creating a new book..." : "Load a PDF as a saved book"}
            </span>
          </button>
          <input
            className="input"
            type="text"
            placeholder="Novel title"
            aria-label="Novel title"
            value={titleInput}
            onChange={(event) => handleTitleChange(event.target.value)}
          />
          <div className="action-row">
            <button className="action-button" type="button" onClick={handleNewNovel}>
              New
            </button>
            <button className="action-button primary" type="button" onClick={handleSaveNovel}>
              Save1
            </button>
          </div>
          <div className="import-status" aria-live="polite">
            {pdfImportStatus}
          </div>
        </div>

        <div className="library-search">
          <input
            className="input"
            type="search"
            placeholder="Search novels"
            aria-label="Search novels"
            autoComplete="off"
            value={searchQuery}
            onFocus={() => setSelectedSuggestionIndex(-1)}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setSelectedSuggestionIndex(-1);
            }}
            onKeyDown={(event) => {
              if (!searchQuery.trim() || matchingNovels.length === 0) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelectedSuggestionIndex((current) => Math.min(matchingNovels.length - 1, current + 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelectedSuggestionIndex((current) => Math.max(0, current - 1));
              }
              if (event.key === "Enter") {
                event.preventDefault();
                const match = matchingNovels[selectedSuggestionIndex] || matchingNovels[0];
                if (match) {
                  setSearchQuery(match.title || "");
                  handleOpenNovel(match.id);
                }
              }
            }}
          />
          {searchQuery.trim() && matchingNovels.length > 0 ? (
            <div className="search-suggestions" aria-label="Novel suggestions">
              {matchingNovels.map((novel, index) => (
                <button
                  key={novel.id}
                  type="button"
                  className={`search-suggestion${index === selectedSuggestionIndex ? " active" : ""}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    setSearchQuery(novel.title || "");
                    handleOpenNovel(novel.id);
                  }}
                >
                  {novel.title || "Untitled Novel"}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="library-list">
          <button type="button" className="novel-card settings-card" onClick={openSettings}>
            <span className="novel-card-title">Settings</span>
          </button>

          {sortedNovels.length === 0 ? <div className="empty-state">{isLibraryReady ? "" : "Loading books..."}</div> : null}

          {sortedNovels.map((novel) => (
            <div key={novel.id} className={`novel-card-shell${novel.id === activeNovelId ? " active" : ""}`}>
              <button
                type="button"
                className={`novel-card${novel.id === activeNovelId ? " active" : ""}`}
                onClick={() => handleOpenNovel(novel.id)}
              >
                <span className="novel-card-title">{novel.title || "Untitled Novel"}</span>
              </button>
              <button
                type="button"
                className="rename-book-button"
                aria-label={`Rename ${novel.title || "Untitled Novel"}`}
                onClick={() => handleRenameNovel(novel.id)}
              >
                Edit
              </button>
              <button
                type="button"
                className="delete-book-button"
                aria-label={`Delete ${novel.title || "Untitled Novel"}`}
                onClick={() => handleDeleteNovel(novel.id)}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      </aside>

      <main
        className={`reader-pane${showChrome ? " show-chrome" : ""}`}
        onMouseMove={(event) => {
          if (viewMode !== "reader") return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const y = event.clientY - bounds.top;
          setShowChrome(y <= CHROME_REVEAL_HEIGHT || Boolean(event.target.closest(".topbar")));
        }}
        onMouseLeave={() => setShowChrome(false)}
      >
        <div className="chrome-hover-zone" aria-hidden="true" />
        <div className="topbar">
          <div className="controls" aria-label="Reader controls">
            <div className="control-group" aria-label="Navigation controls">
              <button className="back-button" type="button" aria-label="Back to library" onClick={handleBackToLibrary}>
                &#8592;
              </button>
            </div>
            <div className="control-group" aria-label="Font size controls">
              <button type="button" aria-label="Decrease text size" onClick={() => applyFontSize(fontSize - FONT_STEP)}>
                -
              </button>
              <input
                type="number"
                min="14"
                max="72"
                step="1"
                value={fontSize}
                aria-label="Text size in pixels"
                onChange={(event) => applyFontSize(parseInt(event.target.value, 10))}
              />
              <span>px</span>
              <button type="button" aria-label="Increase text size" onClick={() => applyFontSize(fontSize + FONT_STEP)}>
                +
              </button>
            </div>
            <div className="control-group" aria-label="Line spacing controls">
              <button
                type="button"
                aria-label="Decrease line spacing"
                onClick={() => applyLineHeight(lineHeight - LINE_HEIGHT_STEP)}
              >
                -
              </button>
              <input
                type="number"
                min="1"
                max="2.4"
                step="0.01"
                value={lineHeight}
                aria-label="Line spacing value"
                onChange={(event) => applyLineHeight(parseFloat(event.target.value))}
              />
              <span>lh</span>
              <button
                type="button"
                aria-label="Increase line spacing"
                onClick={() => applyLineHeight(lineHeight + LINE_HEIGHT_STEP)}
              >
                +
              </button>
            </div>
          </div>
        </div>

        <div
          ref={readerRef}
          className="reader"
          contentEditable
          suppressContentEditableWarning
          spellCheck="false"
          aria-label="Reading area"
          onInput={handleReaderInput}
          onPaste={handleReaderPaste}
          onContextMenu={(event) => {
            const range = getSelectionHighlightRange();
            if (!range) {
              setHighlightMenu({ visible: false, x: 0, y: 0, start: 0, end: 0, content: "" });
              return;
            }
            event.preventDefault();
            setHighlightMenu({
              visible: true,
              x: event.clientX,
              y: event.clientY,
              start: range.start,
              end: range.end,
              content: range.content
            });
          }}
          onScroll={() => {
            updatePageMetrics();
            queueScrollSave();
          }}
        />

        {highlightMenu.visible ? (
          <button
            type="button"
            className="highlight-menu"
            style={{ left: highlightMenu.x, top: highlightMenu.y }}
            onClick={applyHighlightFromMenu}
          >
            Highlight
          </button>
        ) : null}

        <div className="page-counter" id="pageCounter">
          Page {pageMetrics.current} of {pageMetrics.total}
        </div>
      </main>

      <div
        className={`settings-overlay${settingsOpen ? " open" : ""}`}
        aria-hidden={settingsOpen ? "false" : "true"}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            setSettingsOpen(false);
          }
        }}
      >
        <div className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
          <h2 id="settingsTitle">Settings</h2>
          <div className="settings-grid">
            <label className="settings-label">
              <span>Supabase URL</span>
              <input
                className="input"
                type="url"
                placeholder="https://your-project.supabase.co"
                value={supabaseUrlInput}
                onChange={(event) => setSupabaseUrlInput(event.target.value)}
              />
            </label>
            <label className="settings-label">
              <span>Supabase Anon Key</span>
              <input
                className="input"
                type="text"
                placeholder="Paste anon key"
                value={supabaseAnonKeyInput}
                onChange={(event) => setSupabaseAnonKeyInput(event.target.value)}
              />
            </label>
          </div>
          <div className="settings-actions">
            <button className="action-button" type="button" onClick={() => setSettingsOpen(false)}>
              Close
            </button>
            <button
              className="action-button primary"
              type="button"
              onClick={async () => {
                setSettingsStatus("Syncing...");
                await syncWithSupabase({ manual: true });
              }}
            >
              Sync
            </button>
          </div>
          <div className="settings-status">{settingsStatus}</div>
        </div>
      </div>
    </div>
  );
}
