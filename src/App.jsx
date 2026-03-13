import React, { useEffect, useMemo, useRef, useState } from "react";

const STORAGE_KEY = "reader-library-v1";
const SETTINGS_KEY = "reader-settings-v1";
const CHROME_REVEAL_HEIGHT = 90;
const MIN_SIZE = 14;
const MAX_SIZE = 72;
const MIN_LINE_HEIGHT = 1;
const MAX_LINE_HEIGHT = 2.4;
const FONT_STEP = 1;
const LINE_HEIGHT_STEP = 0.02;

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

function getTextOffset(root, node, nodeOffset) {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, nodeOffset);
  return range.toString().length;
}

export default function App() {
  const initialLibrary = useMemo(() => loadLibraryState(), []);
  const initialSettings = useMemo(() => loadAppSettings(), []);
  const [novels, setNovels] = useState(initialLibrary.novels);
  const [activeNovelId, setActiveNovelId] = useState(initialLibrary.activeNovelId);
  const [viewMode, setViewMode] = useState("library");
  const [titleInput, setTitleInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const [fontSize, setFontSize] = useState(clampFontSize(parseInt(String(initialSettings.fontSize || 17), 10)));
  const [lineHeight, setLineHeight] = useState(clampLineHeight(parseFloat(String(initialSettings.lineHeight || 1.35))));
  const [showChrome, setShowChrome] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [supabaseUrlInput, setSupabaseUrlInput] = useState(initialSettings.supabaseUrl || "");
  const [supabaseAnonKeyInput, setSupabaseAnonKeyInput] = useState(initialSettings.supabaseAnonKey || "");
  const [settingsStatus, setSettingsStatus] = useState(initialSettings.lastSyncMessage || "");
  const [pageMetrics, setPageMetrics] = useState({ current: 1, total: 1 });

  const readerRef = useRef(null);
  const previousRenderedNovelIdRef = useRef(null);
  const saveTimerRef = useRef(null);
  const scrollTimerRef = useRef(null);
  const syncTimerRef = useRef(null);
  const syncInFlightRef = useRef(false);
  const syncingSuppressedRef = useRef(false);

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
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        novels,
        activeNovelId
      })
    );
  }, [novels, activeNovelId]);

  useEffect(() => {
    saveAppSettings({
      ...loadAppSettings(),
      fontSize,
      lineHeight,
      supabaseUrl: supabaseUrlInput.trim(),
      supabaseAnonKey: supabaseAnonKeyInput.trim(),
      lastSyncMessage: settingsStatus
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
  }, [activeNovel?.id, activeNovel?.content, activeNovel?.highlight, activeNovel?.scrollTop]);

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
    setViewMode("library");
    if (getSyncConfig().isConfigured) {
      void syncWithSupabase();
    }
  }, []);

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
    window.clearTimeout(saveTimerRef.current);
    window.clearTimeout(scrollTimerRef.current);
    window.clearTimeout(syncTimerRef.current);
    const snapshot = persistSnapshotToLocalStorage();
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

  function persistSnapshotToLocalStorage() {
    const snapshot = buildCurrentSnapshot();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        novels: snapshot.nextNovels,
        activeNovelId: snapshot.nextActiveNovelId
      })
    );
    return snapshot;
  }

  function saveCurrentNovelFromReader() {
    if (!activeNovel || !readerRef.current) return;
    const snapshot = buildCurrentSnapshot();
    setNovels(snapshot.nextNovels);
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
      setNovels((current) => [...current, novel]);
      setActiveNovelId(novel.id);
      return novel;
  }

  function handleOpenNovel(id) {
    flushPendingSaves();
    setActiveNovelId(id);
    setViewMode("reader");
    setShowChrome(false);
  }

  function handleBackToLibrary() {
    flushPendingSaves();
    setViewMode("library");
    setShowChrome(false);
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
    setViewMode("library");
    updatePageMetrics();
  }

  function handleSaveNovel() {
    const title = (titleInput || "").trim() || "Untitled Novel";
    if (!activeNovel) {
      const novel = createNovel(title);
      novel.content = normalizeText(readerRef.current?.innerText || "");
      novel.fontSize = fontSize;
      novel.lineHeight = lineHeight;
      setNovels((current) => [...current, novel]);
      setActiveNovelId(novel.id);
      queueAutoSync();
      return;
    }

    saveCurrentNovelFromReader();
    updateNovelById(activeNovel.id, (novel) => ({
      ...novel,
      title,
      updatedAt: Date.now()
    }));
    queueAutoSync();
  }

  function handleTitleChange(value) {
    setTitleInput(value);
    if (!activeNovel) return;
    updateNovelById(activeNovel.id, (novel) => ({
      ...novel,
      title: (value || novel.title || "Untitled Novel").trim(),
      updatedAt: Date.now()
    }));
    queueAutoSync();
  }

  function handleReaderInput() {
    const novel = ensureActiveNovel();
    if (!novel) return;
    updateNovelById(novel.id, (current) => ({
      ...current,
      highlight: null,
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

  function handleReaderDoubleClick() {
    const reader = readerRef.current;
    const selection = window.getSelection();
    const novel = ensureActiveNovel();
    if (!reader || !selection || selection.rangeCount === 0 || !novel) return;
    const range = selection.getRangeAt(0);
    if (!reader.contains(range.commonAncestorContainer)) return;

    const text = selection.toString().trim();
    if (!text) return;

    const start = getTextOffset(reader, range.startContainer, range.startOffset);
    const end = getTextOffset(reader, range.endContainer, range.endOffset);
    const content = normalizeText(reader.innerText || "");
    const before = content.slice(0, start);
    const middle = content.slice(start, end);
    if (!middle.trim()) return;

    const nextHighlight = {
      start: before.length,
      end: before.length + middle.length
    };

    const nextNovels = novels.map((entry) =>
      entry.id === novel.id
        ? {
            ...entry,
            content,
            highlight: nextHighlight,
            scrollTop: reader.scrollTop,
            fontSize,
            lineHeight,
            updatedAt: Date.now()
          }
        : entry
    );
    setNovels(nextNovels);
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        novels: nextNovels,
        activeNovelId: novel.id
      })
    );
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
      syncingSuppressedRef.current = true;
      await pullFromSupabase(config);
      syncingSuppressedRef.current = false;

      const message = `Last synced ${new Date().toLocaleString()}`;
      setSettingsStatus(message);
      saveAppSettings({
        ...getSettingsWithDeviceId(),
        supabaseUrl: config.supabaseUrl,
        supabaseAnonKey: config.supabaseAnonKey,
        lastSyncMessage: message
      });
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
              Save
            </button>
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

          {sortedNovels.length === 0 ? <div className="empty-state" /> : null}

          {sortedNovels.map((novel) => (
            <button
              key={novel.id}
              type="button"
              className={`novel-card${novel.id === activeNovelId ? " active" : ""}`}
              onClick={() => handleOpenNovel(novel.id)}
            >
              <span className="novel-card-title">{novel.title || "Untitled Novel"}</span>
            </button>
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
          <div className="novel-status">
            <button className="back-button" type="button" aria-label="Back to library" onClick={handleBackToLibrary}>
              &#8592;
            </button>
          </div>

          <div className="controls" aria-label="Reader controls">
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
          onDoubleClick={handleReaderDoubleClick}
          onScroll={() => {
            updatePageMetrics();
            queueScrollSave();
          }}
        />

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
