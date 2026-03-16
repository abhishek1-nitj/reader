import React, { useEffect, useMemo, useRef, useState } from "react";

const SUPABASE_LIBRARY_ID = "primary";
const CHROME_REVEAL_HEIGHT = 90;
const MIN_SIZE = 14;
const MAX_SIZE = 72;
const MIN_LINE_HEIGHT = 1;
const MAX_LINE_HEIGHT = 2.4;
const FONT_STEP = 1;
const LINE_HEIGHT_STEP = 0.02;

function clampFontSize(value) {
  if (Number.isNaN(value)) return 17;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, value));
}

function clampLineHeight(value) {
  if (Number.isNaN(value)) return 1.35;
  return Math.min(MAX_LINE_HEIGHT, Math.max(MIN_LINE_HEIGHT, value));
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
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildReaderHtml(text) {
  return escapeHtml(text || "").replace(/\n/g, "<br>");
}

function createBook(title) {
  const now = Date.now();
  return {
    id: `book-${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: title || "Untitled Book",
    content: "",
    scrollTop: 0,
    fontSize: 17,
    lineHeight: 1.35,
    updatedAt: now
  };
}

function buildReaderHash(bookId) {
  return `#reader=${encodeURIComponent(bookId)}`;
}

function getBookIdFromHash() {
  const hash = window.location.hash || "";
  if (!hash.startsWith("#reader=")) return null;
  const value = hash.slice("#reader=".length);
  return value ? decodeURIComponent(value) : null;
}

export default function App() {
  const [books, setBooks] = useState([]);
  const [activeBookId, setActiveBookId] = useState(null);
  const [viewMode, setViewMode] = useState("library");
  const [draftTitle, setDraftTitle] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const [fontSize, setFontSize] = useState(17);
  const [lineHeight, setLineHeight] = useState(1.35);
  const [showChrome, setShowChrome] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [supabaseUrlInput, setSupabaseUrlInput] = useState(import.meta.env.VITE_SUPABASE_URL || "");
  const [supabaseAnonKeyInput, setSupabaseAnonKeyInput] = useState(import.meta.env.VITE_SUPABASE_ANON_KEY || "");
  const [settingsStatus, setSettingsStatus] = useState("Supabase not connected.");
  const [pageMetrics, setPageMetrics] = useState({ current: 1, total: 1 });
  const [isReady, setIsReady] = useState(false);

  const readerRef = useRef(null);
  const saveTimerRef = useRef(null);
  const scrollTimerRef = useRef(null);
  const syncTimerRef = useRef(null);
  const previousRenderedBookIdRef = useRef(null);
  const lastPersistedRef = useRef("");
  const syncInFlightRef = useRef(false);
  const applyingRemoteRef = useRef(false);

  const activeBook = books.find((book) => book.id === activeBookId) || null;

  const sortedBooks = useMemo(
    () => [...books].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    [books]
  );

  const matchingBooks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return sortedBooks.slice(0, 8);
    return sortedBooks.filter((book) => (book.title || "").toLowerCase().includes(query)).slice(0, 8);
  }, [searchQuery, sortedBooks]);

  useEffect(() => {
    let cancelled = false;

    async function hydrate() {
      try {
        const config = getSyncConfig();
        if (config.isConfigured) {
          const remote = await pullFromSupabase(config);
          if (remote) {
            if (!cancelled) {
              setBooks(Array.isArray(remote?.books) ? remote.books : []);
              setActiveBookId(typeof remote?.active_book_id === "string" ? remote.active_book_id : null);
            }
          }
        } else {
          if (!cancelled) {
            setBooks([]);
            setActiveBookId(null);
          }
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to hydrate from Supabase:", error);
          setBooks([]);
          setActiveBookId(null);
        }
      } finally {
        if (!cancelled) {
          setIsReady(true);
        }
      }
    }

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isReady) return;

    const payload = JSON.stringify({ books, activeBookId });
    if (payload === lastPersistedRef.current) return;
    lastPersistedRef.current = payload;

    queueAutoSync();
  }, [activeBookId, books, isReady]);

  useEffect(() => {
    if (!isReady) return;
    if (!getSyncConfig().isConfigured) return;
    void syncWithSupabase({ preferRemote: true });
  }, [isReady]);

  useEffect(() => {
    if (!activeBook) return;
    setFontSize(clampFontSize(parseInt(String(activeBook.fontSize || 17), 10)));
    setLineHeight(clampLineHeight(parseFloat(String(activeBook.lineHeight || 1.35))));
  }, [activeBook]);

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader) return;

    const desiredContent = activeBook?.content || "";
    const bookChanged = previousRenderedBookIdRef.current !== (activeBook?.id || null);
    const currentContent = normalizeText(reader.innerText || "");

    if (bookChanged || currentContent !== desiredContent) {
      reader.innerHTML = buildReaderHtml(desiredContent);
    }

    if (bookChanged) {
      reader.scrollTop = activeBook?.scrollTop || 0;
    }

    previousRenderedBookIdRef.current = activeBook?.id || null;
    updatePageMetrics();
  }, [activeBook?.content, activeBook?.id, activeBook?.scrollTop]);

  useEffect(() => {
    if (!isReady) return;

    const applyRoute = () => {
      const bookId = getBookIdFromHash();
      if (bookId && books.some((book) => book.id === bookId)) {
        setActiveBookId(bookId);
        setViewMode("reader");
        setShowChrome(false);
        return;
      }

      setViewMode("library");
      setShowChrome(false);
    };

    applyRoute();
    window.addEventListener("hashchange", applyRoute);
    return () => {
      window.removeEventListener("hashchange", applyRoute);
    };
  }, [books, isReady]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      flushPendingSaves();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushPendingSaves();
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", handleBeforeUnload);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("pagehide", handleBeforeUnload);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeBookId, books, draftTitle, fontSize, lineHeight]);

  function updatePageMetrics() {
    const reader = readerRef.current;
    if (!reader) return;
    const total = Math.max(1, Math.ceil(reader.scrollHeight / Math.max(reader.clientHeight, 1)));
    const current = Math.min(total, Math.max(1, Math.floor(reader.scrollTop / Math.max(reader.clientHeight, 1)) + 1));
    setPageMetrics({ current, total });
  }

  function clearTimers() {
    window.clearTimeout(saveTimerRef.current);
    window.clearTimeout(scrollTimerRef.current);
    window.clearTimeout(syncTimerRef.current);
  }

  function getSyncConfig() {
    const supabaseUrl = supabaseUrlInput.trim().replace(/\/+$/, "");
    const supabaseAnonKey = supabaseAnonKeyInput.trim();
    return {
      supabaseUrl,
      supabaseAnonKey,
      libraryId: SUPABASE_LIBRARY_ID,
      isConfigured: Boolean(supabaseUrl && supabaseAnonKey)
    };
  }

  function queueAutoSync() {
    const config = getSyncConfig();
    if (!config.isConfigured || applyingRemoteRef.current) return;
    window.clearTimeout(syncTimerRef.current);
    syncTimerRef.current = window.setTimeout(() => {
      void syncWithSupabase();
    }, 600);
  }

  function commitLibrary(nextBooks, nextActiveBookId = activeBookId) {
    setBooks(nextBooks);
    setActiveBookId(nextActiveBookId);
    queueAutoSync();
  }

  function buildReaderSnapshot() {
    if (!activeBook || !readerRef.current) {
      return { nextBooks: books, nextActiveBookId: activeBookId };
    }

    const content = normalizeText(readerRef.current.innerText || "");
    const now = Date.now();

    return {
      nextBooks: books.map((book) =>
        book.id === activeBook.id
          ? {
              ...book,
              content,
              scrollTop: readerRef.current.scrollTop,
              fontSize,
              lineHeight,
              updatedAt: now
            }
          : book
      ),
      nextActiveBookId: activeBookId
    };
  }

  function flushPendingSaves() {
    clearTimers();
    if (!activeBook) return;
    const snapshot = buildReaderSnapshot();
    commitLibrary(snapshot.nextBooks, snapshot.nextActiveBookId);
  }

  function queueReaderSave() {
    clearTimers();
    saveTimerRef.current = window.setTimeout(() => {
      const snapshot = buildReaderSnapshot();
      commitLibrary(snapshot.nextBooks, snapshot.nextActiveBookId);
    }, 150);
  }

  function queueScrollSave() {
    window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(() => {
      const snapshot = buildReaderSnapshot();
      commitLibrary(snapshot.nextBooks, snapshot.nextActiveBookId);
    }, 120);
  }

  function handleCreateNew() {
    const title = draftTitle.trim();
    if (!title) return;

    const book = createBook(title);
    commitLibrary([...books, book], book.id);
    setDraftTitle("");
    setSearchQuery("");
    setSelectedSuggestionIndex(-1);
    setViewMode("library");
  }

  function handleSave() {
    if (viewMode === "library" && draftTitle.trim()) {
      handleCreateNew();
      return;
    }

    flushPendingSaves();
  }

  function openBook(bookId) {
    flushPendingSaves();
    setActiveBookId(bookId);
    setViewMode("reader");
    setShowChrome(false);
    if (window.location.hash !== buildReaderHash(bookId)) {
      window.location.hash = buildReaderHash(bookId);
    }
  }

  function handleBackToLibrary() {
    flushPendingSaves();
    if (getBookIdFromHash()) {
      window.history.back();
      return;
    }

    setViewMode("library");
    setShowChrome(false);
  }

  function handleDeleteBook(bookId) {
    const book = books.find((entry) => entry.id === bookId);
    if (!book) return;

    const confirmed = window.confirm(`Delete "${book.title || "Untitled Book"}"?`);
    if (!confirmed) return;

    clearTimers();
    const snapshot = buildReaderSnapshot();
    const nextBooks = snapshot.nextBooks.filter((entry) => entry.id !== bookId);
    const deletingActive = activeBookId === bookId;

    commitLibrary(nextBooks, deletingActive ? null : snapshot.nextActiveBookId);

    if (deletingActive) {
      setViewMode("library");
      setShowChrome(false);
      if (window.location.hash) {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
      if (readerRef.current) {
        readerRef.current.innerHTML = "";
        readerRef.current.scrollTop = 0;
      }
      previousRenderedBookIdRef.current = null;
      updatePageMetrics();
    }
  }

  function handleRenameBook(bookId) {
    const book = books.find((entry) => entry.id === bookId);
    if (!book) return;

    const nextTitle = window.prompt("Edit book title", book.title || "Untitled Book");
    if (nextTitle == null) return;

    const trimmedTitle = nextTitle.trim() || "Untitled Book";
    commitLibrary(
      books.map((entry) =>
        entry.id === bookId
          ? {
              ...entry,
              title: trimmedTitle,
              updatedAt: Date.now()
            }
          : entry
      ),
      activeBookId
    );
  }

  function applyFontSize(nextValue) {
    const next = clampFontSize(nextValue);
    setFontSize(next);
    if (!activeBook) return;

    commitLibrary(
      books.map((book) =>
        book.id === activeBook.id
          ? {
              ...book,
              fontSize: next,
              updatedAt: Date.now()
            }
          : book
      ),
      activeBook.id
    );
  }

  function applyLineHeight(nextValue) {
    const next = clampLineHeight(nextValue);
    setLineHeight(next);
    if (!activeBook) return;

    commitLibrary(
      books.map((book) =>
        book.id === activeBook.id
          ? {
              ...book,
              lineHeight: next,
              updatedAt: Date.now()
            }
          : book
      ),
      activeBook.id
    );
  }

  async function pullFromSupabase(config) {
    const url = `${config.supabaseUrl}/rest/v1/reader_libraries?id=eq.${encodeURIComponent(config.libraryId)}&select=*`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${config.supabaseAnonKey}`
      }
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Fetch failed (${response.status})${details ? `: ${details}` : ""}`);
    }

    const rows = await response.json();
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  async function pushToSupabase(config, snapshot) {
    const payload = {
      id: config.libraryId,
      books: snapshot.nextBooks,
      active_book_id: snapshot.nextActiveBookId
    };

    const response = await fetch(`${config.supabaseUrl}/rest/v1/reader_libraries`, {
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

  function applyRemoteLibrary(row) {
    applyingRemoteRef.current = true;
    setBooks(Array.isArray(row?.books) ? row.books : []);
    setActiveBookId(typeof row?.active_book_id === "string" ? row.active_book_id : null);
    applyingRemoteRef.current = false;
  }

  async function syncWithSupabase({ preferRemote = false, manual = false } = {}) {
    const config = getSyncConfig();
    if (!config.isConfigured) {
      setSettingsStatus("Enter the Supabase URL and anon key first.");
      return;
    }

    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;

    try {
      const snapshot = buildReaderSnapshot();

      if (preferRemote) {
        const remote = await pullFromSupabase(config);
        if (remote) {
          applyRemoteLibrary(remote);
        } else {
          await pushToSupabase(config, snapshot);
        }
      } else {
        await pushToSupabase(config, snapshot);
        const remote = await pullFromSupabase(config);
        if (remote) {
          applyRemoteLibrary(remote);
        }
      }

      const message = `Last synced ${new Date().toLocaleString()}`;
      setSettingsStatus(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync failed";
      setSettingsStatus(message);
      if (manual) {
        throw error;
      }
    } finally {
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
      <aside className="library-pane" aria-label="Book library">
        <div className="library-header">
          <h1>Books</h1>
        </div>

        <div className="library-actions">
          <input
            className="input"
            type="text"
            placeholder="Book title"
            aria-label="Book title"
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
          />
          <div className="action-row">
            <button className="action-button" type="button" onClick={() => setDraftTitle("")}>
              New
            </button>
            <button className="action-button primary" type="button" onClick={handleSave}>
              Save3
            </button>
          </div>
        </div>

        <div className="library-search">
          <input
            className="input"
            type="search"
            placeholder="Search books"
            aria-label="Search books"
            autoComplete="off"
            value={searchQuery}
            onFocus={() => setSelectedSuggestionIndex(-1)}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setSelectedSuggestionIndex(-1);
            }}
            onKeyDown={(event) => {
              if (!searchQuery.trim() || matchingBooks.length === 0) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelectedSuggestionIndex((current) => Math.min(matchingBooks.length - 1, current + 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelectedSuggestionIndex((current) => Math.max(0, current - 1));
              }
              if (event.key === "Enter") {
                event.preventDefault();
                const match = matchingBooks[selectedSuggestionIndex] || matchingBooks[0];
                if (match) {
                  openBook(match.id);
                }
              }
            }}
          />
          {searchQuery.trim() && matchingBooks.length > 0 ? (
            <div className="search-suggestions" aria-label="Book suggestions">
              {matchingBooks.map((book, index) => (
                <button
                  key={book.id}
                  type="button"
                  className={`search-suggestion${index === selectedSuggestionIndex ? " active" : ""}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    openBook(book.id);
                  }}
                >
                  {book.title || "Untitled Book"}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="library-list">
          <button type="button" className="novel-card settings-card" onClick={() => setSettingsOpen(true)}>
            <span className="novel-card-title">Settings</span>
          </button>

          {sortedBooks.length === 0 ? <div className="empty-state">{isReady ? "" : "Loading books..."}</div> : null}

          {sortedBooks.map((book) => (
            <div key={book.id} className="novel-card-shell">
              <button
                type="button"
                className={`novel-card${book.id === activeBookId ? " active" : ""}`}
                onClick={() => openBook(book.id)}
              >
                <span className="novel-card-title">{book.title || "Untitled Book"}</span>
              </button>
              <button
                type="button"
                className="rename-book-button"
                aria-label={`Rename ${book.title || "Untitled Book"}`}
                onClick={(event) => {
                  event.stopPropagation();
                  handleRenameBook(book.id);
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className="delete-book-button"
                aria-label={`Delete ${book.title || "Untitled Book"}`}
                onClick={(event) => {
                  event.stopPropagation();
                  handleDeleteBook(book.id);
                }}
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
          onInput={() => {
            queueReaderSave();
            updatePageMetrics();
          }}
          onPaste={(event) => {
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

            queueReaderSave();
            updatePageMetrics();
          }}
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
