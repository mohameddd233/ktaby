const STORAGE_KEY = 'kitabi_books_v5';
const OLD_STORAGE_KEYS = ['kitabi_books_v4'];
const SEED_KEY = 'kitabi_seeded_v5';
const DARK_MODE_KEY = 'kitabi_dark_mode';
const DATA_VERSION = '5.1';
const MM_TO_PX = 3.7795;
const MAX_STORAGE_MB = 4.5;
const MAX_PAGES_CACHE = 15;
const MAX_STATS_CACHE = 50;

const PAGE_DIMENSIONS = {
  'A4':  { width: 210, height: 297 },
  'A5':  { width: 148, height: 210 },
  '6x9': { width: 152.4, height: 228.6 }
};

let currentEditingId = null;
let currentTab = 'content';
let viewerBook = null;
let viewerLeaves = [];
let viewerLeafIndex = 0;
let isMobile = window.innerWidth <= 768;
let saveDebounceTimers = {};
let _pagesCache = new Map();
let _statsCache = new Map();
let _measureCache = new Map();
let _activeKeydownHandler = null;
let _previewSpreadIndex = 0;
let _previewSpreadsCount = 0;
let _isAnimating = false;
let librarySearchTerm = '';
let librarySortBy = 'updatedAt';
let draggedChapterIndex = null;
let searchDebounceTimer = null;

/* ============================================================
   💾 STORAGE
   ============================================================ */
function getBooks() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}

function saveBooks(books) {
  try {
    const json = JSON.stringify(books);
    const sizeMB = new Blob([json]).size / (1024 * 1024);
    if (sizeMB > MAX_STORAGE_MB) {
      toast(`البيانات كبيرة (${sizeMB.toFixed(2)}MB). جرّب حذف كتب أو أغلفة كبيرة.`, 'error');
      return false;
    }
    localStorage.setItem(STORAGE_KEY, json);
    return true;
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      toast('مساحة التخزين ممتلئة! احذف بعض الكتب أو الأغلفة.', 'error');
    } else {
      toast('فشل الحفظ: ' + e.message, 'error');
    }
    return false;
  }
}

function getBook(id) { return getBooks().find(b => b.id === id); }

function upsertBook(book) {
  const books = getBooks();
  const idx = books.findIndex(b => b.id === book.id);
  if (idx >= 0) books[idx] = book; else books.unshift(book);
  saveBooks(books);
  _pagesCache.delete(book.id);
  clearStatsCacheForBook(book.id);
}

function deleteBook(id) {
  saveBooks(getBooks().filter(b => b.id !== id));
  _pagesCache.delete(id);
  clearStatsCacheForBook(id);
}

function clearStatsCacheForBook(id) {
  for (const key of _statsCache.keys()) {
    if (key.startsWith(id + '_')) _statsCache.delete(key);
  }
}

function migrateOldData() {
  if (localStorage.getItem(STORAGE_KEY)) return;
  for (const oldKey of OLD_STORAGE_KEYS) {
    const old = localStorage.getItem(oldKey);
    if (old) {
      try {
        const books = JSON.parse(old);
        books.forEach(b => {
          if (!b.isFavorite) b.isFavorite = false;
          if (!b.lastReadPage) b.lastReadPage = 0;
          if (!b.bookmarks) b.bookmarks = [];
        });
        localStorage.setItem(STORAGE_KEY, JSON.stringify(books));
        console.log('✅ Migrated from', oldKey);
        return;
      } catch (e) { console.warn('Migration failed:', e); }
    }
  }
}

/* ============================================================
   🛠️ UTILS
   ============================================================ */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function toast(msg, type='info') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast ' + type;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2800);
}

function escapeHtml(s='') {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function debounce(key, fn, delay = 400) {
  clearTimeout(saveDebounceTimers[key]);
  saveDebounceTimers[key] = setTimeout(fn, delay);
}

function safeFileName(name) {
  const cleaned = (name || 'book').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_').trim();
  if (/[\u0600-\u06FF]/.test(cleaned)) return 'kitab_' + Date.now();
  return cleaned || 'book';
}

function toggleDarkMode() {
  document.body.classList.toggle('dark-mode');
  const isDark = document.body.classList.contains('dark-mode');
  localStorage.setItem(DARK_MODE_KEY, isDark ? 'true' : 'false');
}

function loadDarkMode() {
  if (localStorage.getItem(DARK_MODE_KEY) === 'true') {
    document.body.classList.add('dark-mode');
  }
}

/**
 * ضغط صورة قبل الحفظ (لتوفير مساحة localStorage)
 */
function compressImage(dataUrl, maxWidth = 1200, quality = 0.8) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let w = img.width, h = img.height;
      if (w > maxWidth) {
        h = Math.round((h * maxWidth) / w);
        w = maxWidth;
      }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/* ============================================================
   🌐 LANGUAGE / DIRECTION
   ============================================================ */
function detectTextDirection(text) {
  if (!text) return 'rtl';
  const rtlChars = (text.match(/[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/g) || []).length;
  const ltrChars = (text.match(/[A-Za-z]/g) || []).length;
  if (rtlChars === 0 && ltrChars === 0) return 'rtl';
  return rtlChars >= ltrChars ? 'rtl' : 'ltr';
}

function detectBookDirection(book) {
  const d = book.design || {};
  if (d.autoDirection === false && d.direction) return d.direction;
  const sample = [
    book.title || '',
    book.author || '',
    ...(book.chapters || []).slice(0, 3).map(c => (c.content || '').slice(0, 300))
  ].join(' ');
  return detectTextDirection(sample);
}

/* ============================================================
   📐 DESIGN DEFAULTS
   ============================================================ */
function defaultDesign() {
  return {
    pageColor: '#ffffff',
    textColor: '#111111',
    fontFamily: 'Amiri',
    fontSize: 16,
    lineHeight: 1.9,
    paperStyle: 'plain',
    pageSize: 'A5',
    margin: 40,
    direction: 'rtl',
    autoDirection: true,
    headerText: '',
    footerText: 'Designed and by Mohamed Ali',
    showPageNumbers: true,
    includeTOC: true
  };
}

function newBook() {
  return {
    id: uid(),
    title: 'كتاب بدون عنوان',
    author: '',
    description: '',
    category: '',
    isbn: '',
    cover: '',
    backCover: '',
    chapters: [{ title: 'الفصل الأول', content: '', order: 0 }],
    design: defaultDesign(),
    isFavorite: false,
    lastReadPage: 0,
    bookmarks: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

/* ============================================================
   📖 SEED BOOK
   ============================================================ */
function seedDefaultBook() {
  if (localStorage.getItem(SEED_KEY)) return;
  const books = getBooks();
  if (books.length > 0) {
    localStorage.setItem(SEED_KEY, 'true');
    return;
  }
  const defaultBook = {
    id: 'sample-001',
    title: 'رحلة في عالم الكتب',
    author: 'محمد علي',
    description: 'كتاب تجريبي يستعرض إمكانيات نظام "كتابي" — نظام إنشاء الكتب الاحترافي v5.1. جرّب تعديله أو أنشئ كتاباً جديداً.',
    category: 'تقني',
    isbn: '',
    cover: '',
    backCover: '',
    chapters: [
      {
        title: 'مقدمة',
        content: `مرحباً بك في نظام "كتابي" — نظام إنشاء الكتب الاحترافي v5.1.

هذا الكتاب التجريبي يعرض لك إمكانيات النظام:
• إنشاء كتب متعددة الفصول
• تصميم مخصص (خطوط، ألوان، أحجام)
• معاينة الكتاب بشكل واقعي
• تصدير PDF و Word احترافي
• قياس دقيق لتقسيم الصفحات بالسطور
• علامات مرجعية وفهرس تلقائي
• بحث وفرز ومفضلة
• الوضع الليلي
• نسخة احتياطية JSON

جرّب التعديل على هذا الكتاب، أو احذفه وأنشئ كتابك الخاص.`,
        order: 0
      },
      {
        title: 'كيف تستخدم النظام؟',
        content: `للاستفادة الكاملة من النظام:

1. المحتوى: أضف فصولاً واكتب محتواها
2. البيانات: املأ العنوان والمؤلف والوصف والأغلفة
3. المعاينة: شاهد الشكل النهائي للكتاب
4. التصميم: اضبط الخطوط والألوان والهوامش
5. التصدير: صدّر كـ PDF أو Word أو JSON

نصيحة: اضبط الهوامش وحجم الخط أولاً، ثم اكتب المحتوى — لأن تقسيم الصفحات يتأثر بهما.`,
        order: 1
      }
    ],
    design: defaultDesign(),
    isFavorite: false,
    lastReadPage: 0,
    bookmarks: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  books.unshift(defaultBook);
  saveBooks(books);
  localStorage.setItem(SEED_KEY, 'true');
}

/* ============================================================
   📐 MEASUREMENT — نظام القياس الواقعي الدقيق
   ============================================================ */
function createMeasureElement(design) {
  const d = design || defaultDesign();
  const dims = PAGE_DIMENSIONS[d.pageSize] || PAGE_DIMENSIONS['A5'];
  const marginMm = d.margin * 0.264;
  const contentWidthMm = Math.max(20, dims.width - marginMm * 2);
  const contentHeightMm = Math.max(20, dims.height - marginMm * 2);

  const el = document.createElement('div');
  el.style.cssText = `
    position: fixed;
    left: -99999px;
    top: 0;
    width: ${contentWidthMm * MM_TO_PX}px;
    height: ${contentHeightMm * MM_TO_PX}px;
    font-family: '${d.fontFamily}', 'Amiri', sans-serif;
    font-size: ${d.fontSize}px;
    line-height: ${d.lineHeight};
    direction: ${d.direction};
    text-align: ${d.direction === 'rtl' ? 'right' : 'left'};
    overflow: hidden;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-wrap: break-word;
    box-sizing: border-box;
    visibility: hidden;
    pointer-events: none;
    padding: 0;
    margin: 0;
  `;
  document.body.appendChild(el);
  return el;
}

function getLineHeightPx(design) {
  const d = design || defaultDesign();
  return d.fontSize * d.lineHeight;
}

/**
 * حساب عدد السطور التي تتسع في صفحة واحدة (محسّن)
 */
function getLinesPerPage(design) {
  const d = design || defaultDesign();
  const dims = PAGE_DIMENSIONS[d.pageSize] || PAGE_DIMENSIONS['A5'];
  const marginMm = d.margin * 0.264;
  const contentHeightMm = Math.max(20, dims.height - marginMm * 2);
  const contentHeightPx = contentHeightMm * MM_TO_PX;

  // حساب ارتفاع الهيدر والفوتر بدقة حسب طول النص
  const headerLines = d.headerText ? Math.max(1, Math.ceil((d.headerText || '').length / 60)) : 0;
  const footerLines = d.footerText ? Math.max(1, Math.ceil((d.footerText || '').length / 60)) : 0;
  const headerHeight = headerLines * 18;
  const footerHeight = footerLines * 18;
  const pageNumHeight = d.showPageNumbers ? 20 : 0;
  const internalPadding = 20;

  const headerFooterHeight = headerHeight + footerHeight + pageNumHeight + internalPadding;
  const availableHeight = Math.max(50, contentHeightPx - headerFooterHeight);

  const lineHeightPx = getLineHeightPx(d);
  return Math.max(5, Math.floor(availableHeight / lineHeightPx));
}

/**
 * قياس عدد السطور الفعلي لنص معين (دقيق)
 */
function measureParagraphLines(text, design) {
  if (!text) return 0;
  const d = design || defaultDesign();
  const dims = PAGE_DIMENSIONS[d.pageSize] || PAGE_DIMENSIONS['A5'];
  const marginMm = d.margin * 0.264;
  const contentWidthMm = Math.max(20, dims.width - marginMm * 2);

  const el = document.createElement('div');
  el.style.cssText = `
    position: fixed;
    left: -99999px;
    top: 0;
    width: ${contentWidthMm * MM_TO_PX}px;
    font-family: '${d.fontFamily}', 'Amiri', sans-serif;
    font-size: ${d.fontSize}px;
    line-height: ${d.lineHeight};
    direction: ${d.direction};
    text-align: ${d.direction === 'rtl' ? 'right' : 'left'};
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-wrap: break-word;
    box-sizing: border-box;
    visibility: hidden;
  `;
  el.textContent = text;
  document.body.appendChild(el);
  const height = el.scrollHeight;
  document.body.removeChild(el);

  const lineHeightPx = getLineHeightPx(d);
  return Math.max(1, Math.ceil(height / lineHeightPx));
}

/**
 * تقسيم فقرة طويلة جداً إلى أجزاء لا تتجاوز maxLines
 */
function splitLongParagraph(text, maxLines, design) {
  const words = text.split(/\s+/).filter(w => w);
  const parts = [];
  let current = [];
  let currentText = '';

  for (const word of words) {
    const testText = currentText ? currentText + ' ' + word : word;
    const lines = measureParagraphLines(testText, design);
    if (lines > maxLines && current.length > 0) {
      parts.push(current.join(' '));
      current = [word];
      currentText = word;
    } else {
      current.push(word);
      currentText = testText;
    }
  }
  if (current.length > 0) parts.push(current.join(' '));
  return parts.length > 0 ? parts : [text];
}

/**
 * تقسيم ذكي للصفحات على مستوى السطور الفعلية
 */
function splitIntoPagesPrecise(chapters, design) {
  const d = design || defaultDesign();
  const linesPerPage = getLinesPerPage(d);
  const pages = [];

  chapters.forEach((ch, chIdx) => {
    const content = (ch.content || '').trim();
    if (!content && chIdx !== 0) return;

    const paragraphs = content.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
    let currentPageParas = [];
    let currentLines = 0;
    let firstPage = true;
    let chapterTitleLines = 0;

    const pushPage = () => {
      if (currentPageParas.length === 0 && !firstPage) return;
      pages.push({
        chapterIndex: chIdx,
        chapterTitle: firstPage ? ch.title : null,
        content: currentPageParas.join('\n\n'),
        isChapterStart: firstPage
      });
      firstPage = false;
      chapterTitleLines = 0;
      currentPageParas = [];
      currentLines = 0;
    };

    // عنوان الفصل يأخذ ~2 سطور في الصفحة الأولى
    if (ch.title) chapterTitleLines = 2;

    if (paragraphs.length === 0) {
      pages.push({
        chapterIndex: chIdx,
        chapterTitle: ch.title || null,
        content: '',
        isChapterStart: true
      });
      return;
    }

    paragraphs.forEach(para => {
      const paraLines = measureParagraphLines(para, d);

      // إذا كانت الفقرة أطول من صفحة كاملة
      if (paraLines + chapterTitleLines > linesPerPage) {
        // احفظ ما لدينا أولاً
        if (currentPageParas.length > 0) pushPage();
        // قسّم الفقرة الطويلة
        const maxLines = Math.max(1, linesPerPage - chapterTitleLines);
        const parts = splitLongParagraph(para, maxLines, d);
        parts.forEach((part, pIdx) => {
          pages.push({
            chapterIndex: chIdx,
            chapterTitle: firstPage ? ch.title : null,
            content: part,
            isChapterStart: firstPage
          });
          firstPage = false;
          chapterTitleLines = 0;
        });
        return;
      }

      // إذا لم تتسع الفقرة الحالية
      if (currentLines + paraLines + chapterTitleLines > linesPerPage && currentPageParas.length > 0) {
        pushPage();
      }

      currentPageParas.push(para);
      currentLines += paraLines;
    });

    // احفظ ما تبقى
    if (currentPageParas.length > 0) {
      pages.push({
        chapterIndex: chIdx,
        chapterTitle: firstPage ? ch.title : null,
        content: currentPageParas.join('\n\n'),
        isChapterStart: firstPage
      });
    }
  });

  return pages;
}

function getCachedMeasurements(design) {
  const key = [
    design.pageSize, design.fontFamily, design.fontSize,
    design.lineHeight, design.margin, design.direction,
    (design.headerText || '').length,
    (design.footerText || '').length,
    design.showPageNumbers ? '1' : '0'
  ].join('|');

  if (_measureCache.has(key)) return _measureCache.get(key);

  const result = {
    linesPerPage: getLinesPerPage(design),
    lineHeightPx: getLineHeightPx(design),
    isMeasuring: false
  };

  _measureCache.set(key, result);
  return result;
}

function clearMeasureCache() {
  _measureCache.clear();
}

/* ============================================================
   📖 BUILD PAGES
   ============================================================ */
function setPagesCache(key, value) {
  if (_pagesCache.size >= MAX_PAGES_CACHE) {
    const firstKey = _pagesCache.keys().next().value;
    _pagesCache.delete(firstKey);
  }
  _pagesCache.set(key, value);
}

function buildPages(book) {
  if (_pagesCache.has(book.id)) {
    const cached = _pagesCache.get(book.id);
    if (cached.updatedAt === book.updatedAt) return cached.pages;
  }

  const d = book.design || defaultDesign();
  const pages = [];

  pages.push({
    type: 'frontCover',
    cover: book.cover,
    title: book.title,
    author: book.author
  });

  pages.push({
    type: 'title',
    title: book.title,
    author: book.author,
    category: book.category
  });

  const chapters = (book.chapters || []).filter(c => c.title || c.content);
  const contentPages = splitIntoPagesPrecise(chapters, d);

  // الفهرس التلقائي (إن كان مفعّلاً وهناك 2+ فصول)
  if (d.includeTOC !== false && chapters.length >= 2) {
    // احسب رقم صفحة بداية كل فصل
    const chapterStartPages = {};
    contentPages.forEach((p, idx) => {
      if (p.isChapterStart && chapterStartPages[p.chapterIndex] === undefined) {
        // رقم الصفحة في الكتاب = رقم صفحة المحتوى + 2 (frontCover + title) + 1 (TOC) + 1
        chapterStartPages[p.chapterIndex] = idx + 3 + 1;
      }
    });

    const tocContent = chapters.map((ch, i) => {
      const pageNum = chapterStartPages[i] ?? '—';
      return `${ch.title || ('فصل ' + (i + 1))} .......... ${pageNum}`;
    }).join('\n');

    pages.push({
      type: 'content',
      chapterTitle: 'الفهرس',
      content: tocContent,
      isChapterStart: true,
      chapterIndex: -1
    });
  }

  contentPages.forEach(p => pages.push({ type: 'content', ...p }));

  pages.push({ type: 'endPage', title: book.title });

  pages.push({
    type: 'backCover',
    cover: book.backCover || '',
    title: book.title,
    author: book.author,
    description: book.description
  });

  setPagesCache(book.id, { pages, updatedAt: book.updatedAt });
  return pages;
}

/* ============================================================
   📊 BOOK STATS (مع كاش)
   ============================================================ */
function getBookStats(book) {
  const cacheKey = `${book.id}_${book.updatedAt}`;
  if (_statsCache.has(cacheKey)) return _statsCache.get(cacheKey);

  const allText = (book.chapters || []).map(c => c.content || '').join(' ');
  const words = allText.trim().split(/\s+/).filter(w => w).length;
  const chars = allText.length;
  const readingTime = Math.ceil(words / 200);
  const pages = buildPages(book).length;

  const result = { words, chars, readingTime, pages };

  if (_statsCache.size >= MAX_STATS_CACHE) {
    const firstKey = _statsCache.keys().next().value;
    _statsCache.delete(firstKey);
  }
  _statsCache.set(cacheKey, result);
  return result;
}

/* ============================================================
   🧭 NAVIGATION
   ============================================================ */
function goHome() {
  currentEditingId = null;
  document.getElementById('mobileBar').classList.add('hidden');
  document.getElementById('fab').classList.remove('hidden');
  renderLibrary();
}

function createNewBook() {
  const b = newBook();
  upsertBook(b);
  openEditor(b.id);
}

function openEditor(id) {
  currentEditingId = id;
  currentTab = 'content';
  renderEditor();
}

/* ============================================================
   📚 LIBRARY
   ============================================================ */
function onSearchInput(value) {
  librarySearchTerm = value;
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => renderLibrary(), 250);
}

function renderLibrary() {
  const app = document.getElementById('app');
  let books = getBooks();

  if (librarySearchTerm) {
    const term = librarySearchTerm.toLowerCase();
    books = books.filter(b =>
      (b.title || '').toLowerCase().includes(term) ||
      (b.author || '').toLowerCase().includes(term) ||
      (b.category || '').toLowerCase().includes(term)
    );
  }

  books = [...books].sort((a, b) => {
    if (librarySortBy === 'title') return (a.title || '').localeCompare(b.title || '', 'ar');
    if (librarySortBy === 'author') return (a.author || '').localeCompare(b.author || '', 'ar');
    if (librarySortBy === 'createdAt') return (b.createdAt || 0) - (a.createdAt || 0);
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  books.sort((a, b) => (b.isFavorite ? 1 : 0) - (a.isFavorite ? 1 : 0));

  if (getBooks().length === 0) {
    app.innerHTML = `
      <div class="empty-state">
        <div class="icon">📖</div>
        <h3>مكتبتك فارغة</h3>
        <p>ابدأ بإنشاء أول كتاب لك الآن</p>
        <button class="btn btn-primary" onclick="createNewBook()">➕ إنشاء كتاب جديد</button>
      </div>`;
    return;
  }

  app.innerHTML = `
    <div class="library-header">
      <div>
        <h2>📚 مكتبتي</h2>
        <p>${getBooks().length} كتاب ${librarySearchTerm ? `— ${books.length} نتيجة` : ''}</p>
      </div>
      <button class="btn btn-primary" onclick="createNewBook()">➕ كتاب جديد</button>
    </div>

    <div class="library-toolbar">
      <input type="text" placeholder="🔍 ابحث بالعنوان أو المؤلف..."
             value="${escapeHtml(librarySearchTerm)}"
             oninput="onSearchInput(this.value)">
      <select onchange="librarySortBy = this.value; renderLibrary()">
        <option value="updatedAt" ${librarySortBy==='updatedAt'?'selected':''}>الأحدث تعديلاً</option>
        <option value="createdAt" ${librarySortBy==='createdAt'?'selected':''}>الأحدث إنشاءً</option>
        <option value="title" ${librarySortBy==='title'?'selected':''}>العنوان (أ-ي)</option>
        <option value="author" ${librarySortBy==='author'?'selected':''}>المؤلف (أ-ي)</option>
      </select>
    </div>

    ${books.length === 0 ? `
      <div class="empty-state">
        <div class="icon">🔍</div>
        <h3>لا توجد نتائج</h3>
        <p>جرّب كلمات بحث أخرى</p>
      </div>
    ` : `
      <div class="books-grid">
        ${books.map(b => bookCardHtml(b)).join('')}
      </div>
    `}`;
}

function bookCardHtml(b) {
  const cover = b.cover
    ? `<img src="${b.cover}" class="book-cover" alt="cover">`
    : `<div class="book-cover">${escapeHtml((b.title || 'ك')[0])}</div>`;
  const chaptersCount = (b.chapters || []).length;
  const dir = detectBookDirection(b);
  const dirLabel = dir === 'rtl' ? 'عربي' : 'إنجليزي';
  const stats = getBookStats(b);

  return `
    <div class="book-card">
      <button class="book-favorite" onclick="event.stopPropagation();toggleFavorite('${b.id}')" title="المفضلة">
        ${b.isFavorite ? '⭐' : '☆'}
      </button>
      ${cover}
      <div class="book-info">
        <h3 title="${escapeHtml(b.title)}">${escapeHtml(b.title)}</h3>
        <div class="author">${escapeHtml(b.author || 'مؤلف مجهول')}</div>
        <div class="meta">
          <span>${chaptersCount} فصل</span>
          <span>${stats.words} كلمة</span>
          <span>${stats.pages} صفحة</span>
          <span>${dirLabel}</span>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn btn-outline btn-sm" onclick="event.stopPropagation();openEditor('${b.id}')" title="تعديل">✏️</button>
        <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();openViewer('${b.id}')" title="عرض">👁️</button>
        <button class="btn btn-info btn-sm" onclick="event.stopPropagation();exportBookJSON('${b.id}')" title="تصدير JSON">💾</button>
        <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();confirmDelete('${b.id}')" title="حذف">🗑️</button>
      </div>
    </div>`;
}

function toggleFavorite(id) {
  const b = getBook(id);
  if (!b) return;
  b.isFavorite = !b.isFavorite;
  b.updatedAt = Date.now();
  upsertBook(b);
  renderLibrary();
  toast(b.isFavorite ? '⭐ أُضيف للمفضلة' : 'أُزيل من المفضلة', 'success');
}

function confirmDelete(id) {
  const b = getBook(id);
  if (!b) return false;
  if (confirm(`هل أنت متأكد من حذف "${b.title}"؟`)) {
    deleteBook(id);
    toast('تم حذف الكتاب', 'success');
    if (currentEditingId === id) goHome();
    else renderLibrary();
    return true;
  }
  return false;
}

/* ============================================================
   💾 EXPORT / IMPORT
   ============================================================ */
function exportBookJSON(id) {
  const b = getBook(id);
  if (!b) return;
  const blob = new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFileName(b.title) + '.json';
  a.click();
  URL.revokeObjectURL(url);
  toast('تم تصدير الكتاب كـ JSON', 'success');
}

function exportAllBooks() {
  const data = {
    version: DATA_VERSION,
    exportedAt: new Date().toISOString(),
    books: getBooks()
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kitabi_backup_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`تم تصدير ${data.books.length} كتاب`, 'success');
}

function isValidBook(b) {
  return b && typeof b === 'object' &&
         typeof b.title === 'string' &&
         Array.isArray(b.chapters);
}

function importAllBooks(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      const books = Array.isArray(data) ? data : (data.books || []);
      if (!books.length) {
        toast('لا توجد كتب في الملف', 'error');
        return;
      }
      const existing = getBooks();
      const existingIds = new Set(existing.map(b => b.id));
      let imported = 0;
      books.forEach(b => {
        if (!isValidBook(b)) {
          console.warn('Skipping invalid book:', b);
          return;
        }
        if (!b.id || existingIds.has(b.id)) b.id = uid();
        if (!b.design) b.design = defaultDesign();
        if (!b.isFavorite) b.isFavorite = false;
        if (!b.lastReadPage) b.lastReadPage = 0;
        if (!b.bookmarks) b.bookmarks = [];
        existing.unshift(b);
        imported++;
      });
      saveBooks(existing);
      renderLibrary();
      toast(`تم استيراد ${imported} كتاب`, 'success');
    } catch (err) {
      toast('ملف غير صالح: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

/* ============================================================
   ✏️ EDITOR
   ============================================================ */
function renderEditor() {
  const b = getBook(currentEditingId);
  if (!b) { goHome(); return; }
  const d = b.design || defaultDesign();
  const stats = getBookStats(b);
  const measurements = getCachedMeasurements(d);
  const dims = PAGE_DIMENSIONS[d.pageSize] || PAGE_DIMENSIONS['A5'];
  const totalLines = measurements.linesPerPage;

  if (isMobile) {
    document.getElementById('mobileBar').classList.remove('hidden');
    document.getElementById('fab').classList.add('hidden');
  }

  document.getElementById('app').innerHTML = `
    <div class="editor-layout">
      <div>
        <div class="panel">
          <h3>📝 محتوى الكتاب</h3>
          <div class="tabs">
            <div class="tab ${currentTab==='content'?'active':''}" onclick="switchTab('content')">📄 المحتوى</div>
            <div class="tab ${currentTab==='info'?'active':''}" onclick="switchTab('info')">ℹ️ بيانات</div>
            <div class="tab ${currentTab==='preview'?'active':''}" onclick="switchTab('preview')">👁️ معاينة</div>
            <div class="tab ${currentTab==='design'?'active':''}" onclick="switchTab('design')">🎨 تصميم</div>
          </div>

          <div id="tab-content" class="${currentTab!=='content'?'hidden':''}">
            <div class="form-group">
              <label>عنوان الكتاب</label>
              <input type="text" value="${escapeHtml(b.title)}" oninput="updateField('title', this.value)">
            </div>

            <div class="stats-box">
              <h4>📊 إحصائيات دقيقة</h4>
              <div class="stats-grid">
                <div class="stat-item"><span>حجم الورق</span><span>${d.pageSize}</span></div>
                <div class="stat-item"><span>الأبعاد</span><span>${dims.width}×${dims.height}mm</span></div>
                <div class="stat-item"><span>سطور/صفحة</span><span>${totalLines}</span></div>
                <div class="stat-item"><span>إجمالي الكلمات</span><span>${stats.words}</span></div>
                <div class="stat-item"><span>إجمالي الأحرف</span><span>${stats.chars}</span></div>
                <div class="stat-item"><span>الصفحات</span><span>${stats.pages}</span></div>
                <div class="stat-item"><span>وقت القراءة</span><span>${stats.readingTime} دقيقة</span></div>
                <div class="stat-item"><span>الفصول</span><span>${b.chapters.length}</span></div>
              </div>
            </div>

            <div class="form-group">
              <label>الفصول <span style="color:var(--muted);font-weight:400">(${b.chapters.length})</span></label>
              <div id="chaptersList"></div>
              <button class="btn btn-outline btn-sm" onclick="addChapter()" style="margin-top:8px;width:100%">➕ إضافة فصل</button>
            </div>
          </div>

          <div id="tab-info" class="${currentTab!=='info'?'hidden':''}">
            <div class="form-group">
              <label>اسم المؤلف</label>
              <input type="text" value="${escapeHtml(b.author)}" oninput="updateField('author', this.value)">
            </div>
            <div class="form-group">
              <label>التصنيف</label>
              <input type="text" value="${escapeHtml(b.category)}" oninput="updateField('category', this.value)" placeholder="رواية، شعر، علمي...">
            </div>
            <div class="form-group">
              <label>الوصف</label>
              <textarea oninput="updateField('description', this.value)" placeholder="وصف موجز للكتاب...">${escapeHtml(b.description)}</textarea>
            </div>
            <div class="form-group">
              <label>ISBN (اختياري)</label>
              <input type="text" value="${escapeHtml(b.isbn)}" oninput="updateField('isbn', this.value)">
            </div>

            <h3 style="margin-top:20px">🖼️ الغلاف الأمامي</h3>
            <div class="cover-preview" onclick="document.getElementById('coverInput').click()">
              ${b.cover ? `<img src="${b.cover}">` : '<span>📷 اضغط لرفع الغلاف الأمامي</span>'}
            </div>
            <input type="file" id="coverInput" accept="image/*" class="hidden" onchange="handleCover(event)">
            ${b.cover ? `<button class="btn btn-danger btn-sm" style="width:100%" onclick="removeCover()">🗑️ إزالة الغلاف الأمامي</button>` : ''}

            <h3 style="margin-top:20px">🖼️ الغلاف الخلفي</h3>
            <div class="cover-preview" onclick="document.getElementById('backCoverInput').click()">
              ${b.backCover ? `<img src="${b.backCover}">` : '<span>📷 اضغط لرفع الغلاف الخلفي</span>'}
            </div>
            <input type="file" id="backCoverInput" accept="image/*" class="hidden" onchange="handleBackCover(event)">
            ${b.backCover ? `<button class="btn btn-danger btn-sm" style="width:100%" onclick="removeBackCover()">🗑️ إزالة الغلاف الخلفي</button>` : ''}
          </div>

          <div id="tab-preview" class="${currentTab!=='preview'?'hidden':''}">
            <div id="previewContainer"></div>
          </div>

          <div id="tab-design" class="${currentTab!=='design'?'hidden':''}">
            <div class="form-group">
              <label>لون الصفحة</label>
              <input type="color" value="${d.pageColor}" oninput="updateDesignLive('pageColor', this.value)" onchange="saveCurrentBook()">
            </div>
            <div class="form-group">
              <label>لون النص</label>
              <input type="color" value="${d.textColor}" oninput="updateDesignLive('textColor', this.value)" onchange="saveCurrentBook()">
            </div>
            <div class="form-group">
              <label>نوع الخط</label>
              <select onchange="updateDesign('fontFamily', this.value)">
                <option value="Cairo" ${d.fontFamily==='Cairo'?'selected':''}>Cairo</option>
                <option value="Amiri" ${d.fontFamily==='Amiri'?'selected':''}>Amiri</option>
                <option value="Tajawal" ${d.fontFamily==='Tajawal'?'selected':''}>Tajawal</option>
                <option value="Scheherazade New" ${d.fontFamily==='Scheherazade New'?'selected':''}>Scheherazade</option>
              </select>
            </div>
            <div class="form-group">
              <label id="lbl-fontSize">حجم الخط: ${d.fontSize}px</label>
              <input type="range" min="12" max="28" value="${d.fontSize}"
                     oninput="updateDesignLive('fontSize', +this.value)"
                     onchange="saveCurrentBook()">
            </div>
            <div class="form-group">
              <label id="lbl-lineHeight">ارتفاع السطر: ${d.lineHeight}</label>
              <input type="range" min="1.2" max="2.5" step="0.1" value="${d.lineHeight}"
                     oninput="updateDesignLive('lineHeight', +this.value)"
                     onchange="saveCurrentBook()">
            </div>
            <div class="form-group">
              <label>شكل الورق</label>
              <select onchange="updateDesign('paperStyle', this.value)">
                <option value="plain" ${d.paperStyle==='plain'?'selected':''}>عادي</option>
                <option value="lined" ${d.paperStyle==='lined'?'selected':''}>مسطّر</option>
                <option value="dotted" ${d.paperStyle==='dotted'?'selected':''}>منقّط</option>
                <option value="vintage" ${d.paperStyle==='vintage'?'selected':''}>ورق قديم</option>
              </select>
            </div>
            <div class="form-group">
              <label>حجم الكتاب</label>
              <select onchange="updateDesign('pageSize', this.value)">
                <option value="A4" ${d.pageSize==='A4'?'selected':''}>A4 (210×297mm)</option>
                <option value="A5" ${d.pageSize==='A5'?'selected':''}>A5 (148×210mm)</option>
                <option value="6x9" ${d.pageSize==='6x9'?'selected':''}>6×9 inch (152×229mm)</option>
              </select>
            </div>
            <div class="form-group">
              <label id="lbl-margin">الهوامش: ${d.margin}px</label>
              <input type="range" min="10" max="80" value="${d.margin}"
                     oninput="updateDesignLive('margin', +this.value)"
                     onchange="saveCurrentBook()">
            </div>
            <div class="form-group">
              <label>
                <input type="checkbox" ${d.autoDirection!==false?'checked':''} onchange="updateDesign('autoDirection', this.checked)">
                كشف الاتجاه تلقائيًا
              </label>
            </div>
            <div class="form-group" ${d.autoDirection!==false?'style="opacity:0.5"':''}>
              <label>الاتجاه (يدوي)</label>
              <select onchange="updateDesign('direction', this.value)" ${d.autoDirection!==false?'disabled':''}>
                <option value="rtl" ${d.direction==='rtl'?'selected':''}>عربي (RTL)</option>
                <option value="ltr" ${d.direction==='ltr'?'selected':''}>إنجليزي (LTR)</option>
              </select>
            </div>
            <div class="form-group">
              <label>نص الهيدر</label>
              <input type="text" value="${escapeHtml(d.headerText)}" oninput="updateDesignLive('headerText', this.value)" onchange="saveCurrentBook()">
            </div>
            <div class="form-group">
              <label>نص الفوتر</label>
              <input type="text" value="${escapeHtml(d.footerText)}" oninput="updateDesignLive('footerText', this.value)" onchange="saveCurrentBook()">
            </div>
            <div class="form-group">
              <label><input type="checkbox" ${d.showPageNumbers?'checked':''} onchange="updateDesign('showPageNumbers', this.checked)"> إظهار أرقام الصفحات</label>
            </div>
            <div class="form-group">
              <label><input type="checkbox" ${d.includeTOC!==false?'checked':''} onchange="updateDesign('includeTOC', this.checked)"> إضافة فهرس تلقائي</label>
            </div>
          </div>
        </div>
      </div>

      <div class="${isMobile?'hidden':''}">
        <div class="panel">
          <h3>💾 حفظ وتصدير</h3>
          <button class="btn btn-success" style="width:100%;margin-bottom:8px" onclick="saveCurrentBook()">💾 حفظ</button>
          <button class="btn btn-primary" style="width:100%;margin-bottom:8px" onclick="openViewer('${b.id}')">📖 عرض الكتاب</button>
          <button class="btn btn-outline" style="width:100%;margin-bottom:8px" onclick="exportPDF('${b.id}')">📄 تصدير PDF</button>
          <button class="btn btn-warning" style="width:100%;margin-bottom:8px" onclick="exportDOCX('${b.id}')">📝 تصدير Word</button>
          <button class="btn btn-info" style="width:100%;margin-bottom:8px" onclick="exportBookJSON('${b.id}')">💾 تصدير JSON</button>
          <button class="btn btn-danger" style="width:100%" onclick="confirmDelete('${b.id}')">🗑️ حذف الكتاب</button>
        </div>

        <div class="panel">
          <h3>📊 معلومات القياس</h3>
          <div class="stats-grid">
            <div class="stat-item"><span>سطور/صفحة</span><span>${totalLines}</span></div>
            <div class="stat-item"><span>ارتفاع السطر</span><span>${measurements.lineHeightPx.toFixed(1)}px</span></div>
          </div>
        </div>
      </div>
    </div>`;

  renderChapters();
  if (currentTab === 'preview') renderPreview();
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  const tabs = ['content', 'info', 'preview', 'design'];
  const idx = tabs.indexOf(tab);
  if (idx >= 0) document.querySelectorAll('.tab')[idx].classList.add('active');
  document.getElementById('tab-content').classList.toggle('hidden', tab !== 'content');
  document.getElementById('tab-info').classList.toggle('hidden', tab !== 'info');
  document.getElementById('tab-preview').classList.toggle('hidden', tab !== 'preview');
  document.getElementById('tab-design').classList.toggle('hidden', tab !== 'design');
  if (tab === 'preview') renderPreview();
}

/* ============================================================
   📝 CHAPTERS
   ============================================================ */
function renderChapters() {
  const b = getBook(currentEditingId);
  if (!b) return;
  const list = document.getElementById('chaptersList');
  if (!list) return;
  const openStates = new Set();
  document.querySelectorAll('.chapter-item.open').forEach(el => {
    const m = el.id.match(/ch-(\d+)/);
    if (m) openStates.add(+m[1]);
  });
  if (openStates.size === 0) openStates.add(0);

  list.innerHTML = (b.chapters || []).map((c, i) => `
    <div class="chapter-item ${openStates.has(i)?'open':''}" id="ch-${i}"
         draggable="true"
         ondragstart="dragStart(event, ${i})"
         ondragover="dragOver(event, ${i})"
         ondragleave="dragLeave(event, ${i})"
         ondrop="dropChapter(event, ${i})"
         ondragend="dragEnd(event)">
      <div class="chapter-header" onclick="toggleChapter(${i})">
        <span class="drag-handle" title="اسحب لإعادة الترتيب" onclick="event.stopPropagation()">⋮⋮</span>
        <span>📖 ${escapeHtml(c.title || 'فصل')}</span>
        <button class="btn btn-outline btn-xs" onclick="event.stopPropagation();duplicateChapter(${i})" title="نسخ">📋</button>
        <button class="btn btn-danger btn-xs" onclick="event.stopPropagation();removeChapter(${i})">🗑️</button>
      </div>
      <div class="chapter-body">
        <div class="form-group">
          <label>عنوان الفصل</label>
          <input type="text" value="${escapeHtml(c.title)}" oninput="updateChapter(${i}, 'title', this.value)">
        </div>
        <div class="form-group">
          <label>محتوى الفصل</label>
          <textarea rows="10" oninput="updateChapter(${i}, 'content', this.value)" placeholder="اكتب محتوى الفصل هنا...">${escapeHtml(c.content)}</textarea>
        </div>
      </div>
    </div>`).join('');
}

function toggleChapter(i) {
  const el = document.getElementById(`ch-${i}`);
  if (el) el.classList.toggle('open');
}

function addChapter() {
  const b = getBook(currentEditingId);
  b.chapters.push({ title: `فصل ${b.chapters.length + 1}`, content: '', order: b.chapters.length });
  b.updatedAt = Date.now();
  upsertBook(b);
  renderChapters();
  toast('تمت إضافة فصل جديد', 'success');
}

function duplicateChapter(i) {
  const b = getBook(currentEditingId);
  const original = b.chapters[i];
  const copy = {
    title: original.title + ' (نسخة)',
    content: original.content,
    order: b.chapters.length
  };
  b.chapters.splice(i + 1, 0, copy);
  b.updatedAt = Date.now();
  upsertBook(b);
  renderChapters();
  toast('تم نسخ الفصل', 'success');
}

function removeChapter(i) {
  const b = getBook(currentEditingId);
  if (b.chapters.length === 1) { toast('لا يمكن حذف الفصل الأخير', 'error'); return; }
  if (!confirm('حذف هذا الفصل؟')) return;
  b.chapters.splice(i, 1);
  b.chapters.forEach((c, idx) => c.order = idx);
  b.updatedAt = Date.now();
  upsertBook(b);
  renderChapters();
}

function updateChapter(i, field, value) {
  const b = getBook(currentEditingId);
  b.chapters[i][field] = value;
  b.updatedAt = Date.now();
  _pagesCache.delete(b.id);
  clearStatsCacheForBook(b.id);
  debounce(`chapter-${i}-${field}`, () => upsertBook(b), 400);
}

function dragStart(e, i) {
  draggedChapterIndex = i;
  e.target.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', String(i)); } catch (err) {}
}

function dragOver(e, i) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const item = document.getElementById(`ch-${i}`);
  if (item && i !== draggedChapterIndex) item.classList.add('drag-over');
}

function dragLeave(e, i) {
  const item = document.getElementById(`ch-${i}`);
  if (item) item.classList.remove('drag-over');
}

function dropChapter(e, targetIndex) {
  e.preventDefault();
  document.querySelectorAll('.chapter-item').forEach(el => el.classList.remove('drag-over', 'dragging'));

  if (draggedChapterIndex === null || draggedChapterIndex === targetIndex) {
    draggedChapterIndex = null;
    return;
  }

  const b = getBook(currentEditingId);
  const [moved] = b.chapters.splice(draggedChapterIndex, 1);
  b.chapters.splice(targetIndex, 0, moved);
  b.chapters.forEach((c, i) => c.order = i);
  b.updatedAt = Date.now();
  upsertBook(b);
  renderChapters();
  draggedChapterIndex = null;
  toast('تم إعادة الترتيب', 'success');
}

function dragEnd(e) {
  document.querySelectorAll('.chapter-item').forEach(el => el.classList.remove('drag-over', 'dragging'));
  draggedChapterIndex = null;
}

/* ============================================================
   ✏️ FIELDS / DESIGN
   ============================================================ */
function updateField(field, value) {
  const b = getBook(currentEditingId);
  b[field] = value;
  b.updatedAt = Date.now();
  _pagesCache.delete(b.id);
  clearStatsCacheForBook(b.id);
  debounce(`field-${field}`, () => upsertBook(b), 400);
}

function updateDesignLive(field, value) {
  const b = getBook(currentEditingId);
  if (!b.design) b.design = defaultDesign();
  b.design[field] = value;
  b.updatedAt = Date.now();
  clearMeasureCache();
  _pagesCache.delete(b.id);
  clearStatsCacheForBook(b.id);

  const labelMap = {
    fontSize: { id: 'lbl-fontSize', prefix: 'حجم الخط: ', suffix: 'px' },
    lineHeight: { id: 'lbl-lineHeight', prefix: 'ارتفاع السطر: ', suffix: '' },
    margin: { id: 'lbl-margin', prefix: 'الهوامش: ', suffix: 'px' }
  };
  const info = labelMap[field];
  if (info) {
    const lbl = document.getElementById(info.id);
    if (lbl) lbl.textContent = info.prefix + value + info.suffix;
  }

  debounce(`design-${field}`, () => upsertBook(b), 400);

  if (currentTab === 'preview') {
    debounce('preview-refresh', renderPreview, 700);
  }
}

function updateDesign(field, value) {
  const b = getBook(currentEditingId);
  if (!b.design) b.design = defaultDesign();
  b.design[field] = value;
  b.updatedAt = Date.now();
  clearMeasureCache();
  _pagesCache.delete(b.id);
  clearStatsCacheForBook(b.id);
  upsertBook(b);

  if (field === 'pageSize' || field === 'autoDirection' || field === 'fontFamily' ||
      field === 'direction' || field === 'paperStyle' || field === 'showPageNumbers' ||
      field === 'includeTOC') {
    renderEditor();
    setTimeout(() => switchTab('design'), 10);
    return;
  }
  if (currentTab === 'preview') renderPreview();
}

/* ============================================================
   🖼️ COVERS
   ============================================================ */
async function handleCover(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) {
    toast('حجم الصورة كبير! الحد الأقصى 4MB', 'error');
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = async ev => {
    const compressed = await compressImage(ev.target.result);
    const b = getBook(currentEditingId);
    b.cover = compressed;
    b.updatedAt = Date.now();
    upsertBook(b);
    renderEditor();
    switchTab('info');
    toast('تم رفع الغلاف الأمامي', 'success');
  };
  reader.readAsDataURL(file);
}

function removeCover() {
  const b = getBook(currentEditingId);
  b.cover = '';
  b.updatedAt = Date.now();
  upsertBook(b);
  renderEditor();
  switchTab('info');
}

async function handleBackCover(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) {
    toast('حجم الصورة كبير! الحد الأقصى 4MB', 'error');
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = async ev => {
    const compressed = await compressImage(ev.target.result);
    const b = getBook(currentEditingId);
    b.backCover = compressed;
    b.updatedAt = Date.now();
    upsertBook(b);
    renderEditor();
    switchTab('info');
    toast('تم رفع الغلاف الخلفي', 'success');
  };
  reader.readAsDataURL(file);
}

function removeBackCover() {
  const b = getBook(currentEditingId);
  b.backCover = '';
  b.updatedAt = Date.now();
  upsertBook(b);
  renderEditor();
  switchTab('info');
}

/* ============================================================
   💾 SAVE
   ============================================================ */
function saveCurrentBook() {
  const b = getBook(currentEditingId);
  if (!b) return;
  b.updatedAt = Date.now();
  upsertBook(b);
  toast('تم حفظ الكتاب بنجاح ✅', 'success');
}

/* ============================================================
   👁️ PREVIEW
   ============================================================ */
function renderPreview() {
  const b = getBook(currentEditingId);
  if (!b) return;
  const d = { ...(b.design || defaultDesign()) };
  d.direction = detectBookDirection(b);
  const pages = buildPages(b);
  const container = document.getElementById('previewContainer');
  if (!container) return;

  const spreads = [];
  for (let i = 0; i < pages.length; i += 2) {
    spreads.push({
      left: pages[i],
      right: pages[i + 1] || { type: 'blank' },
      leftIndex: i,
      rightIndex: i + 1 < pages.length ? i + 1 : -1
    });
  }

  container.innerHTML = `
    <div class="preview-toolbar">
      <button class="btn btn-outline btn-sm" onclick="previewGo(-1)">◀ السابق</button>
      <span id="previewIndicator" class="preview-indicator">1 / ${spreads.length}</span>
      <button class="btn btn-outline btn-sm" onclick="previewGo(1)">التالي ▶</button>
    </div>
    <div class="preview-spread-container">
      ${spreads.map((s, idx) => `
        <div class="preview-spread" data-spread="${idx}" data-dir="${d.direction}" style="display:${idx === 0 ? 'flex' : 'none'}">
          <div class="preview-spread-page">
            ${renderPreviewPage(s.left, d, s.leftIndex)}
          </div>
          <div class="preview-spread-page">
            ${renderPreviewPage(s.right, d, s.rightIndex)}
          </div>
        </div>
      `).join('')}
    </div>
    <div style="text-align:center;margin-top:12px;font-size:13px;color:var(--muted)">
      📖 ${spreads.length} صفحة مزدوجة — ${pages.length} صفحة — الاتجاه: ${d.direction === 'rtl' ? 'عربي (يمين ←)' : 'إنجليزي (→ شمال)'}
    </div>
  `;

  _previewSpreadIndex = 0;
  _previewSpreadsCount = spreads.length;
  updatePreviewIndicator();
}

function previewGo(delta) {
  let idx = _previewSpreadIndex + delta;
  if (idx < 0) idx = 0;
  if (idx >= _previewSpreadsCount) idx = _previewSpreadsCount - 1;
  _previewSpreadIndex = idx;
  document.querySelectorAll('.preview-spread').forEach((el, i) => {
    el.style.display = i === idx ? 'flex' : 'none';
  });
  updatePreviewIndicator();
}

function updatePreviewIndicator() {
  const el = document.getElementById('previewIndicator');
  if (el) el.textContent = `${_previewSpreadIndex + 1} / ${_previewSpreadsCount}`;
}

function renderPreviewPage(p, d, index) {
  const baseStyle = `
    background-color:${d.pageColor};
    color:${d.textColor};
    font-family:'${d.fontFamily}',sans-serif;
    font-size:${d.fontSize}px;
    line-height:${d.lineHeight};
    direction:${d.direction};
  `;

  if (p.type === 'frontCover') {
    if (p.cover) {
      return `<div class="preview-page" style="padding:0;background:#000;position:relative;min-height:500px">
        <img src="${p.cover}" style="width:100%;height:100%;object-fit:cover;position:absolute;inset:0">
      </div>`;
    }
    return `<div class="preview-page" style="padding:0;background:linear-gradient(135deg,#8b5e34,#5c3d1f);position:relative;min-height:500px;display:flex;align-items:center;justify-content:center;color:white;text-align:center">
      <div style="padding:40px">
        <h1 style="font-family:'Amiri',serif;font-size:2.5em;color:#d4a373;margin-bottom:20px">${escapeHtml(p.title)}</h1>
        <p style="opacity:0.9">${escapeHtml(p.author || '')}</p>
      </div>
    </div>`;
  }

  if (p.type === 'backCover') {
    if (p.cover) {
      return `<div class="preview-page" style="padding:0;background:#000;position:relative;min-height:500px">
        <img src="${p.cover}" style="width:100%;height:100%;object-fit:cover;position:absolute;inset:0;filter:brightness(0.55)">
        <div style="position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,0.92),transparent);padding:40px;display:flex;flex-direction:column;justify-content:flex-end;color:white">
          <h2 style="color:#d4a373;margin-bottom:12px">${escapeHtml(p.title)}</h2>
          <p style="opacity:0.9;font-size:0.9em">${escapeHtml(p.description || '')}</p>
        </div>
      </div>`;
    }
    return `<div class="preview-page" style="padding:40px;background:linear-gradient(135deg,#5c3d1f,#8b5e34);position:relative;min-height:500px;display:flex;flex-direction:column;justify-content:center;align-items:center;color:white;text-align:center">
      <h2 style="font-family:'Amiri',serif;font-size:1.8em;color:#d4a373;margin-bottom:20px">${escapeHtml(p.title)}</h2>
      <p style="opacity:0.9;font-size:0.9em">${escapeHtml(p.description || '')}</p>
      <div style="margin-top:30px;font-size:24px;opacity:0.5">✦ ✦ ✦</div>
    </div>`;
  }

  if (p.type === 'title') {
    return `<div class="preview-page ${d.paperStyle}" style="${baseStyle};text-align:center;display:flex;flex-direction:column;justify-content:center;align-items:center">
      <h1 style="font-size:2em;margin-bottom:20px">${escapeHtml(p.title)}</h1>
      ${p.author ? `<p style="font-size:1.2em;opacity:0.7;margin-bottom:16px">${escapeHtml(p.author)}</p>` : ''}
      ${p.category ? `<p style="opacity:0.5">${escapeHtml(p.category)}</p>` : ''}
    </div>`;
  }

  if (p.type === 'endPage') {
    return `<div class="preview-page ${d.paperStyle}" style="${baseStyle};text-align:center;display:flex;flex-direction:column;justify-content:center;align-items:center">
      <div style="font-size:48px;margin-bottom:20px;opacity:0.5">✦</div>
      <h2 style="font-family:'Amiri',serif;font-size:1.5em;margin-bottom:16px;opacity:0.7">النهاية</h2>
    </div>`;
  }

  if (!p || p.type === 'blank') {
    return `<div class="preview-page" style="${baseStyle}"></div>`;
  }

  return `<div class="preview-page ${d.paperStyle}" style="${baseStyle};padding:${d.margin}px;box-sizing:border-box;display:flex;flex-direction:column">
    ${d.headerText ? `<div class="preview-header">${escapeHtml(d.headerText)}</div>` : ''}
    <div style="flex:1;min-height:0;overflow:hidden">
      ${p.chapterTitle ? `<h2 style="margin:0 0 16px 0;font-size:1.5em">${escapeHtml(p.chapterTitle)}</h2>` : ''}
      <div style="white-space:pre-wrap;overflow-wrap:break-word">${escapeHtml(p.content) || ''}</div>
    </div>
    ${d.footerText ? `<div class="preview-footer">${escapeHtml(d.footerText)}</div>` : ''}
    ${d.showPageNumbers && index >= 0 ? `<div style="text-align:center;font-size:12px;color:#999;margin-top:10px">${index + 1}</div>` : ''}
  </div>`;
}

/* ============================================================
   📖 BOOK VIEWER
   ============================================================ */
function openViewer(id) {
  const b = getBook(id);
  if (!b) return;
  viewerBook = b;
  const pages = buildPages(b);
  viewerLeaves = pagesToLeaves(pages);
  viewerLeafIndex = b.lastReadPage && b.lastReadPage > 0
    ? Math.min(b.lastReadPage, viewerLeaves.length)
    : 0;
  _isAnimating = false;
  renderViewer();
  document.getElementById('modal').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function pagesToLeaves(pages) {
  if (!pages || pages.length === 0) return [];
  const padded = [...pages];
  while (padded.length % 2 !== 0) padded.push({ type: 'blank' });

  const leaves = [];
  for (let i = 0; i < padded.length; i += 2) {
    leaves.push({
      front: padded[i],
      frontIndex: i,
      back: padded[i + 1] || { type: 'blank' },
      backIndex: i + 1 < padded.length ? i + 1 : -1
    });
  }
  return leaves;
}

function closeModal() {
  document.getElementById('modal').classList.remove('active');
  document.body.style.overflow = '';
  saveLastReadPage();
  viewerBook = null;
  viewerLeaves = [];
  viewerLeafIndex = 0;
  _isAnimating = false;
  if (_activeKeydownHandler) {
    document.removeEventListener('keydown', _activeKeydownHandler);
    _activeKeydownHandler = null;
  }
}

function renderViewer() {
  const b = viewerBook;
  const d = { ...(b.design || defaultDesign()) };
  d.direction = detectBookDirection(b);

  const pageBaseStyle = `
    background-color:${d.pageColor};
    color:${d.textColor};
    font-family:'${d.fontFamily}',sans-serif;
    font-size:${d.fontSize}px;
    line-height:${d.lineHeight};
    direction:${d.direction};
  `;

  const paperClass = d.paperStyle !== 'plain' ? d.paperStyle : '';

  const leavesHtml = viewerLeaves.map((leaf, i) => {
    const frontHtml = renderViewerPage(leaf.front, leaf.frontIndex, d, paperClass, pageBaseStyle);
    const backHtml = renderViewerPage(leaf.back, leaf.backIndex, d, paperClass, pageBaseStyle);
    return `
      <div class="leaf" data-index="${i}">
        <div class="face front">${frontHtml}</div>
        <div class="face back">${backHtml}</div>
      </div>`;
  }).join('');

  const bookmarksHtml = (b.bookmarks || []).length > 0 ? `
    <div class="panel" style="margin-top:14px">
      <h3>🔖 العلامات المرجعية (${b.bookmarks.length})</h3>
      <div class="bookmarks-panel">
        ${b.bookmarks.map((bm, idx) => `
          <div class="bookmark-item">
            <span class="bm-text" title="${escapeHtml(bm.note || '')}">${escapeHtml(bm.note || 'بدون ملاحظة')} — صفحة ${bm.pageIndex + 1}</span>
            <button class="btn btn-danger btn-xs" onclick="removeBookmark(${idx})">🗑️</button>
          </div>
        `).join('')}
      </div>
    </div>
  ` : '';

  document.getElementById('modalContent').innerHTML = `
    <div class="modal-header">
      <h3>📖 ${escapeHtml(b.title)} <span style="font-size:12px;color:var(--muted);font-weight:400">(${d.direction === 'rtl' ? 'عربي — يفتح من اليمين' : 'English — opens from left'})</span></h3>
      <button class="close-btn" onclick="closeModal()">×</button>
    </div>

    <div class="book-viewer ${isMobile ? 'mobile-mode' : ''}">
      <div class="flipbook ${viewerLeafIndex === 0 ? 'closed' : ''}" data-dir="${d.direction}" id="flipbookEl">
        <div class="flipbook-bg"></div>
        ${leavesHtml}
      </div>
    </div>

    <div class="page-indicator"><span id="pageInfo"></span></div>

    <div class="viewer-controls">
      <button class="btn btn-outline" onclick="prevLeaf()" id="prevBtn">← السابق</button>
      <button class="btn btn-info" onclick="addBookmarkPrompt()">🔖 علامة</button>
      <button class="btn btn-primary" onclick="nextLeaf()" id="nextBtn">التالي →</button>
    </div>

    <div style="display:flex;justify-content:center;gap:10px;margin-top:14px;flex-wrap:wrap">
      <button class="btn btn-success" onclick="exportPDF('${b.id}')">📄 تصدير PDF</button>
      <button class="btn btn-warning" onclick="exportDOCX('${b.id}')">📝 تصدير Word</button>
    </div>

    ${bookmarksHtml}

    ${d.footerText ? `<div style="text-align:center;font-size:11px;color:#aaa;margin-top:16px">${escapeHtml(d.footerText)}</div>` : ''}`;

  updateLeavesState();
  attachCoverClickHandler();

  _activeKeydownHandler = (e) => {
    if (!document.getElementById('modal').classList.contains('active')) return;
    const isRTL = d.direction === 'rtl';
    if (e.key === 'ArrowLeft') isRTL ? nextLeaf() : prevLeaf();
    else if (e.key === 'ArrowRight') isRTL ? prevLeaf() : nextLeaf();
    else if (e.key === 'Escape') closeModal();
  };
  document.addEventListener('keydown', _activeKeydownHandler);
}

function attachCoverClickHandler() {
  const flipbook = document.getElementById('flipbookEl');
  if (!flipbook) return;
  const coverLeaf = flipbook.querySelector('.leaf[data-index="0"]');
  if (coverLeaf) {
    coverLeaf.addEventListener('click', (e) => {
      if (flipbook.classList.contains('closed') && !_isAnimating) {
        e.stopPropagation();
        openBook();
      }
    });
  }
}

function openBook() {
  const flipbook = document.getElementById('flipbookEl');
  if (!flipbook || !flipbook.classList.contains('closed')) return;
  if (_isAnimating) return;
  _isAnimating = true;

  flipbook.classList.remove('closed');
  applyZIndexes();

  setTimeout(() => {
    if (viewerLeafIndex < viewerLeaves.length) {
      viewerLeafIndex++;
      updateLeavesState();
    }
    _isAnimating = false;
  }, 1050);
}

function renderViewerPage(page, pageIndex, d, paperClass, baseStyle) {
  if (!page || page.type === 'blank') {
    return `<div class="page-content ${paperClass}" style="${baseStyle}"></div>`;
  }

  if (page.type === 'frontCover') {
    if (page.cover) {
      return `<div class="page-content cover-full" style="padding:0;position:relative;background:#000">
        <img src="${page.cover}" style="width:100%;height:100%;object-fit:cover;display:block">
      </div>`;
    }
    return `<div class="page-content cover-full" style="padding:0;position:relative;background:linear-gradient(135deg,#8b5e34,#5c3d1f);display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;color:white">
      <div style="position:absolute;inset:20px;border:2px solid rgba(212,163,115,0.6);border-radius:8px;pointer-events:none"></div>
      <div style="padding:60px 40px;position:relative;z-index:1">
        <h1 style="font-family:'Amiri',serif;font-size:2.3em;margin-bottom:24px;color:#d4a373;text-shadow:0 2px 10px rgba(0,0,0,0.4)">${escapeHtml(page.title)}</h1>
        <div style="width:80px;height:2px;background:#d4a373;margin:0 auto 24px"></div>
        ${page.author ? `<p style="font-size:1.2em;opacity:0.9;letter-spacing:2px">${escapeHtml(page.author)}</p>` : ''}
      </div>
    </div>`;
  }

  if (page.type === 'backCover') {
    if (page.cover) {
      return `<div class="page-content cover-full" style="padding:0;position:relative;background:#000">
        <img src="${page.cover}" style="width:100%;height:100%;object-fit:cover;display:block;filter:brightness(0.55)">
        <div style="position:absolute;inset:0;background:linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.5) 50%, rgba(0,0,0,0.2) 100%);display:flex;flex-direction:column;justify-content:flex-end;padding:40px;color:white">
          <h2 style="font-family:'Amiri',serif;font-size:1.8em;margin-bottom:12px;color:#d4a373">${escapeHtml(page.title)}</h2>
          ${page.author ? `<p style="font-size:1em;opacity:0.9;margin-bottom:20px;letter-spacing:1px">${escapeHtml(page.author)}</p>` : ''}
          ${page.description ? `<p style="font-size:0.9em;line-height:1.8;opacity:0.95;margin-top:20px;border-top:1px solid rgba(212,163,115,0.4);padding-top:20px">${escapeHtml(page.description)}</p>` : ''}
        </div>
      </div>`;
    }
    return `<div class="page-content cover-full" style="padding:0;position:relative;background:linear-gradient(135deg,#5c3d1f,#8b5e34);display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;color:white">
      <div style="position:absolute;inset:20px;border:2px solid rgba(212,163,115,0.6);border-radius:8px;pointer-events:none"></div>
      <div style="padding:60px 40px;position:relative;z-index:1">
        <h2 style="font-family:'Amiri',serif;font-size:1.8em;margin-bottom:20px;color:#d4a373">${escapeHtml(page.title)}</h2>
        ${page.author ? `<p style="font-size:1em;opacity:0.8;margin-bottom:30px">${escapeHtml(page.author)}</p>` : ''}
        ${page.description ? `<p style="font-size:0.9em;line-height:1.8;opacity:0.85;border-top:1px solid rgba(212,163,115,0.4);padding-top:20px">${escapeHtml(page.description)}</p>` : ''}
        <div style="margin-top:40px;font-size:24px;opacity:0.5">✦ ✦ ✦</div>
      </div>
    </div>`;
  }

  if (page.type === 'title') {
    return `<div class="page-content ${paperClass}" style="${baseStyle};padding:${isMobile ? 24 : d.margin}px;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center">
      <h1 style="font-size:2em;margin-bottom:20px">${escapeHtml(page.title)}</h1>
      ${page.author ? `<p style="font-size:1.2em;opacity:0.7;margin-bottom:16px">${escapeHtml(page.author)}</p>` : ''}
      ${page.category ? `<p style="opacity:0.5">${escapeHtml(page.category)}</p>` : ''}
    </div>`;
  }

  if (page.type === 'endPage') {
    return `<div class="page-content ${paperClass}" style="${baseStyle};padding:${isMobile ? 24 : d.margin}px;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center">
      <div style="font-size:48px;margin-bottom:20px;opacity:0.5">✦</div>
      <h2 style="font-family:'Amiri',serif;font-size:1.5em;margin-bottom:16px;opacity:0.7">النهاية</h2>
      <p style="font-size:0.9em;opacity:0.5;line-height:1.8;max-width:80%">شكراً لقراءتك "${escapeHtml(page.title)}"</p>
    </div>`;
  }
