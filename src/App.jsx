import React, { useEffect, useMemo, useRef, useState } from "react";

const STORAGE_KEY = "reader-library-v1";
const DB_NAME = "reader-library-db";
const STORE_NAME = "reader-library-store";
const RECORD_KEY = "library-state";
const CHROME_REVEAL_HEIGHT = 90;
const MIN_SIZE = 14;
const MAX_SIZE = 72;
const MIN_LINE_HEIGHT = 1;
const MAX_LINE_HEIGHT = 2.4;
const FONT_STEP = 1;
const LINE_HEIGHT_STEP = 0.02;

let databasePromise = null;

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DB_NAME, 1);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Unable to open IndexedDB."));
    });
  }

  return databasePromise;
}

async function readLibraryState() {
  const database = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(RECORD_KEY);

    request.onsuccess = () => {
      const value = request.result;
      resolve({
        books: Array.isArray(value?.books) ? value.books : [],
        activeBookId: typeof value?.activeBookId === "string" ? value.activeBookId : null
      });
    };
    request.onerror = () => reject(request.error || new Error("Unable to read the saved library."));
  });
}

async function writeLibraryState(nextState) {
  const database = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.put(nextState, RECORD_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Unable to save the library."));
    transaction.onabort = () => reject(transaction.error || new Error("Saving the library was aborted."));
  });
}

function loadLegacyLibraryState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return {
      books: Array.isArray(parsed.novels) ? parsed.novels : [],
      activeBookId: typeof parsed.activeNovelId === "string" ? parsed.activeNovelId : null
    };
  } catch {
    return { books: [], activeBookId: null };
  }
}

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
  const [pageMetrics, setPageMetrics] = useState({ current: 1, total: 1 });
  const [isReady, setIsReady] = useState(false);

  const readerRef = useRef(null);
  const saveTimerRef = useRef(null);
  const scrollTimerRef = useRef(null);
  const previousRenderedBookIdRef = useRef(null);
  const lastPersistedRef = useRef("");

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
        const indexed = await readLibraryState();
        const legacy = loadLegacyLibraryState();
        const nextState = indexed.books.length > 0 ? indexed : legacy;

        if (indexed.books.length === 0 && legacy.books.length > 0) {
          await writeLibraryState(nextState);
          localStorage.removeItem(STORAGE_KEY);
        }

        if (cancelled) return;
        setBooks(nextState.books);
        setActiveBookId(nextState.activeBookId);
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

    void writeLibraryState({ books, activeBookId });
  }, [activeBookId, books, isReady]);

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
  }

  function commitLibrary(nextBooks, nextActiveBookId = activeBookId) {
    setBooks(nextBooks);
    setActiveBookId(nextActiveBookId);
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
    </div>
  );
}
