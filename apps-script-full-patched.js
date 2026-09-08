// ============================================================
// doGet：支援 GET + ?payload=JSON 方式（手機 CORS 友善）
// 手機瀏覽器發出 GET 請求時不會觸發 CORS preflight，
// 因此可以繞過跨域限制，直接取得資料。
// 部署時請選擇：
//   執行身分 = 我（部署者）
//   存取對象 = 任何人（含未登入使用者）
// ============================================================
function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const payloadStr = params.payload || '';
    const req = payloadStr ? JSON.parse(payloadStr) : {};
    return handleRequest_(req);
  } catch (err) {
    return json_({ ok: false, error: 'doGet error: ' + String(err && err.message ? err.message : err) });
  }
}

// ============================================================
// doPost：支援 POST + body JSON 方式（桌機 fallback 用）
// ============================================================
function doPost(e) {
  try {
    const bodyText = (e && e.postData && e.postData.contents) ? e.postData.contents : '';
    const req = bodyText ? JSON.parse(bodyText) : {};
    return handleRequest_(req);
  } catch (err) {
    return json_({ ok: false, error: 'doPost error: ' + String(err && err.message ? err.message : err) });
  }
}

// ============================================================
// 統一請求處理（doGet / doPost 共用）
// ============================================================
function handleRequest_(req) {
  try {
    const action = req.action;

    if (action === 'push') {
      const payload = req.payload || {};
      const books = Array.isArray(payload.books) ? payload.books : [];
      const borrowedBooks = Array.isArray(payload.borrowedBooks) ? payload.borrowedBooks : [];
      const boyouBooks = payload.boyouBooks && typeof payload.boyouBooks === 'object' ? payload.boyouBooks : {};

      if (books.length === 0 && readBooks_().length > 0) {
        return json_({ ok: false, error: 'Refused to overwrite existing Books with an empty book list.' });
      }

      withWriteLock_(function() {
        writeBooks_(books);
        writeBorrowed_(borrowedBooks);
        writeBoyouBooks_(boyouBooks);
      });

      return json_({ ok: true });
    }

    if (action === 'pushBorrowedBooks') {
      const payload = req.payload || {};
      const borrowedBooks = Array.isArray(payload.borrowedBooks) ? payload.borrowedBooks : [];
      const userId = payload.userId || 'anonymous';

      // 只更新借閱記錄，不更新書籍資料
      withWriteLock_(function() {
        writeBorrowed_(borrowedBooks);
      });

      // 記錄是哪個使用者更新的借閱記錄
      console.log('Borrowed books updated by user: ' + userId);

      return json_({ ok: true });
    }

    if (action === 'pull') {
      const data = {
        books: readBooks_(),
        borrowedBooks: readBorrowed_(),
        boyouBooks: readBoyouBooks_(),
        version: getBooksVersion_()
      };
      return json_({ ok: true, data });
    }

    if (action === 'pullBookIds') {
      return json_({ ok: true, data: { books: readBookIds_() } });
    }

    if (action === 'getVersion') {
      return json_({ ok: true, data: { version: getBooksVersion_() } });
    }

    if (action === 'lookupBookUrl') {
      const url = String(req.url || '').trim();
      const apiKey = String(req.apiKey || '').trim();
      if (!url) return json_({ ok: false, error: 'Missing url' });
      return json_({ ok: true, data: lookupBookUrl_(url, apiKey) });
    }

    return json_({ ok: false, error: 'Unknown action: ' + String(action) });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// ============================================================
// 工具函數
// ============================================================

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

function withWriteLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ===== Books =====
function writeBooks_(books) {
  const sh = getSheet_('Books');
  sh.clearContents();

  const header = ['id', 'title', 'author', 'coverUrl', 'coverImage', 'bookUrl', 'genre', 'year', 'copies', 'availableCopies', 'series', 'createdAt', 'updatedAt', 'bookIds'];
  const rows = books.map(b => {
    const bookIds = Array.isArray(b.bookIds) ? b.bookIds.join(',') : '';
    const coverUrl = b.coverUrl || '';
    const coverImage = coverUrl ? '=IMAGE("' + coverUrl + '")' : '';
    const series = b.series || '';
    const createdAt = b.createdAt || b.addedAt || '';
    return [
      b.id || '',
      b.title || '',
      b.author || '',
      coverUrl,
      coverImage,
      b.bookUrl || '',
      b.genre || '',
      Number(b.year || 0),
      Number(b.copies || 0),
      Number(b.availableCopies || 0),
      series,
      createdAt,
      b.updatedAt || '',
      bookIds
    ];
  });

  sh.getRange(1, 1, 1, header.length).setValues([header]);
  if (rows.length > 0) {
    sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  }
}

function readBooks_() {
  const sh = getSheet_('Books');
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();

  // 如果只有標題行或沒有資料，返回空陣列
  if (lastRow <= 1) return [];

  // 明確指定讀取範圍，確保讀取所有資料
  const values = sh.getRange(1, 1, lastRow, lastCol).getValues();

  const header = values[0];
  const idx = indexMap_(header);

  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const id = row[idx.id] || '';
    const title = row[idx.title] || '';
    if (!id && !title) continue;

    const bookIdsCell = row[idx.bookIds] || '';
    const bookIds = String(bookIdsCell).trim()
      ? String(bookIdsCell).split(',').map(s => s.trim()).filter(Boolean)
      : undefined;

    const obj = {
      id: String(id),
      title: String(title),
      author: String(row[idx.author] || ''),
      coverUrl: String(row[idx.coverUrl] || ''),
      bookUrl: String(row[idx.bookUrl] || ''),
      genre: String(row[idx.genre] || ''),
      year: Number(row[idx.year] || 0),
      copies: Number(row[idx.copies] || 0),
      availableCopies: Number(row[idx.availableCopies] || 0),
      series: String(row[idx.series] || ''),
      createdAt: String(row[idx.createdAt] || ''),
      updatedAt: Number(row[idx.updatedAt] || 0)
    };
    if (bookIds) obj.bookIds = bookIds;

    out.push(obj);
  }
  return out;
}

function readBookIds_() {
  const sh = getSheet_('Books');
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow <= 1) return [];

  const header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const idx = indexMap_(header);
  const maxIndex = Math.max(idx.id, idx.title, idx.bookIds);
  const values = sh.getRange(2, 1, lastRow - 1, Math.min(lastCol, maxIndex + 1)).getValues();

  return values.map(row => {
    const id = row[idx.id] || '';
    const title = row[idx.title] || '';
    const bookIdsCell = row[idx.bookIds] || '';
    const bookIds = String(bookIdsCell).trim()
      ? String(bookIdsCell).split(',').map(s => s.trim()).filter(Boolean)
      : undefined;
    return {
      id: String(id),
      title: String(title),
      bookIds
    };
  }).filter(book => book.id || book.title);
}

function getBooksVersion_() {
  const sh = getSheet_('Books');
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow <= 1) return null;

  const header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const idx = indexMap_(header);
  let newestUpdate = '';

  if (idx.updatedAt < lastCol) {
    const values = sh.getRange(2, idx.updatedAt + 1, lastRow - 1, 1).getValues();
    values.forEach(row => {
      const value = String(row[0] || '').trim();
      if (value && value > newestUpdate) newestUpdate = value;
    });
  }

  return [lastRow, lastCol, newestUpdate || 'no-updated-at'].join('_');
}

// ===== Borrowed =====
function writeBorrowed_(borrowedBooks) {
  const sh = getSheet_('Borrowed');
  sh.clearContents();

  const header = ['id', 'bookId', 'bookTitle', 'userId', 'borrowDate', 'dueDate', 'returnedAt'];
  const rows = borrowedBooks.map(r => {
    return [
      r.id || '',
      r.bookId || '',
      r.bookTitle || '',
      r.userId || '',
      r.borrowDate || '',
      r.dueDate || '',
      r.returnedAt || ''
    ];
  });

  sh.getRange(1, 1, 1, header.length).setValues([header]);
  if (rows.length > 0) {
    sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  }
}

function readBorrowed_() {
  const sh = getSheet_('Borrowed');
  const values = sh.getDataRange().getValues();
  if (values.length <= 1) return [];

  const header = values[0];
  const idx = indexMap_(header);

  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const id = row[idx.id] || '';
    if (!id) continue;

    const returnedAtVal = row[idx.returnedAt];
    const returnedAt = String(returnedAtVal || '').trim() ? String(returnedAtVal) : null;

    out.push({
      id: String(id),
      bookId: String(row[idx.bookId] || ''),
      bookTitle: String(row[idx.bookTitle] || ''),
      userId: String(row[idx.userId] || ''),
      borrowDate: String(row[idx.borrowDate] || ''),
      dueDate: String(row[idx.dueDate] || ''),
      returnedAt: returnedAt
    });
  }
  return out;
}

// ===== BoyouBooks (整包 JSON，最完整) =====
function writeBoyouBooks_(boyouBooks) {
  const sh = getSheet_('BoyouBooks');
  sh.clearContents();

  sh.getRange(1, 1, 1, 2).setValues([['key', 'json']]);
  sh.getRange(2, 1, 1, 2).setValues([['boyouBooks', JSON.stringify(boyouBooks)]]);
}

function readBoyouBooks_() {
  const sh = getSheet_('BoyouBooks');
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return {};

  const jsonText = values[1][1];
  if (!jsonText) return {};

  try {
    return JSON.parse(String(jsonText));
  } catch (e) {
    return {};
  }
}

// ===== Book URL metadata =====
function lookupBookUrl_(url, apiKey) {
  const result = {
    title: '',
    author: '',
    year: '',
    coverUrl: '',
    isbn13: '',
    sourceUrl: url
  };

  try {
    const response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LibraryMetadataBot/1.0)'
      }
    });
    const html = response.getContentText('UTF-8');
    const title = extractMeta_(html, ['book:title', 'og:title', 'twitter:title']) || extractTitle_(html);
    const author = extractMeta_(html, ['book:author', 'article:author', 'author']);
    const dateText = extractMeta_(html, ['book:release_date', 'article:published_time', 'pubdate', 'date', 'publish_date']);
    const coverUrl = extractMeta_(html, ['og:image', 'twitter:image']);
    const isbnMatch = html.match(/ISBN\s*(?:13)?\s*[/／:：]\s*([\d-]{13,17})/i) || html.match(/\b(97[89]\d{10})\b/);
    const isbn13 = isbnMatch ? String(isbnMatch[1]).replace(/-/g, '') : '';

    result.title = cleanText_(title);
    result.author = cleanAuthor_(author || extractLabeledText_(html, ['作者介紹', '作者', '作者/繪者', '作/繪者']));
    result.year = extractYear_(dateText || extractLabeledText_(html, ['出版日期', '出版日', '出版時間', '出版年份']));
    result.coverUrl = coverUrl || '';
    result.isbn13 = isbn13;
  } catch (e) {
    // Fall back to title search below.
  }

  if (result.isbn13) {
    const isbnData = lookupBookByIsbn_(result.isbn13, apiKey);
    result.author = result.author || isbnData.author || '';
    result.year = result.year || isbnData.year || '';
    result.coverUrl = result.coverUrl || isbnData.coverUrl || '';
  }

  if ((!result.author || !result.year) && result.title) {
    const fallback = lookupBookByTitle_(result.title);
    result.author = result.author || fallback.author || '';
    result.year = result.year || fallback.year || '';
    result.coverUrl = result.coverUrl || fallback.coverUrl || '';
  }

  return result;
}

function lookupBookByIsbn_(isbn, apiKey) {
  const result = { author: '', year: '', coverUrl: '' };
  try {
    const cleanIsbn = String(isbn || '').replace(/-/g, '').trim();
    if (!/^\d{10,13}$/.test(cleanIsbn)) return result;
    let apiUrl = 'https://www.googleapis.com/books/v1/volumes?q=isbn:' + encodeURIComponent(cleanIsbn);
    if (apiKey) apiUrl += '&key=' + encodeURIComponent(apiKey);
    const response = UrlFetchApp.fetch(apiUrl, { muteHttpExceptions: true });
    const data = JSON.parse(response.getContentText());
    const item = data && data.items && data.items[0];
    if (!item || !item.volumeInfo) return result;
    const info = item.volumeInfo;
    if (info.authors && info.authors.length) result.author = info.authors.join('、');
    if (info.publishedDate) result.year = String(info.publishedDate).slice(0, 4);
    const image = info.imageLinks || {};
    result.coverUrl = image.extraLarge || image.large || image.medium || image.thumbnail || image.smallThumbnail || '';
  } catch (e) {}
  return result;
}

function lookupBookByTitle_(title) {
  const result = { author: '', year: '', coverUrl: '' };
  try {
    const apiUrl = 'https://openlibrary.org/search.json?title=' + encodeURIComponent(title) + '&limit=1&language=chi';
    const response = UrlFetchApp.fetch(apiUrl, { muteHttpExceptions: true });
    const data = JSON.parse(response.getContentText());
    const doc = data && data.docs && data.docs[0];
    if (!doc) return result;
    if (doc.author_name && doc.author_name.length) result.author = doc.author_name.join('、');
    if (doc.first_publish_year) result.year = String(doc.first_publish_year);
    if (doc.cover_i) result.coverUrl = 'https://covers.openlibrary.org/b/id/' + doc.cover_i + '-M.jpg';
  } catch (e) {}
  return result;
}

function extractMeta_(html, names) {
  for (let i = 0; i < names.length; i++) {
    const name = names[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tagRe = /<meta\b[^>]*>/gi;
    let tagMatch;
    while ((tagMatch = tagRe.exec(html)) !== null) {
      const tag = tagMatch[0];
      const hasName = new RegExp('(?:property|name|itemprop)=["\\\']' + name + '["\\\']', 'i').test(tag);
      if (!hasName) continue;
      const match = tag.match(/content=["']([^"']+)["']/i);
      if (match && match[1]) return decodeHtml_(match[1]);
    }
  }
  return '';
}

function extractLabeledText_(html, labels) {
  const text = decodeHtml_(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '));
  const normalized = text.replace(/\s+/g, ' ');
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(label + '\\s*[:：]?\\s*([^｜|。\\n\\r]{1,80})', 'i');
    const match = normalized.match(re);
    if (match && match[1]) return decodeHtml_(match[1]);
  }
  return '';
}

function extractTitle_(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtml_(match[1]) : '';
}

function extractYear_(text) {
  const match = String(text || '').match(/(?:19|20)\d{2}/);
  return match ? match[0] : '';
}

function cleanAuthor_(text) {
  return cleanText_(text).replace(/^作者[:：]?\s*/, '');
}

function cleanText_(text) {
  return String(text || '').replace(/\s+/g, ' ').replace(/\s*[|｜-]\s*.*$/, '').trim();
}

function decodeHtml_(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function indexMap_(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => {
    map[String(h || '').trim()] = i;
  });

  return {
    id: map.id ?? 0,
    title: map.title ?? 1,
    author: map.author ?? 2,
    coverUrl: map.coverUrl ?? 3,
    coverImage: map.coverImage ?? 4,
    bookUrl: map.bookUrl ?? map.url ?? 5,
    genre: map.genre ?? 6,
    year: map.year ?? 7,
    copies: map.copies ?? 8,
    availableCopies: map.availableCopies ?? 9,
    series: map.series ?? 10,
    createdAt: map.createdAt ?? 11,
    updatedAt: map.updatedAt ?? 12,
    bookIds: map.bookIds ?? 13,

    bookId: map.bookId ?? 1,
    bookTitle: map.bookTitle ?? 2,
    userId: map.userId ?? 3,
    borrowDate: map.borrowDate ?? 4,
    dueDate: map.dueDate ?? 5,
    returnedAt: map.returnedAt ?? 6,
  };
}
