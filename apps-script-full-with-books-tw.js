function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const payloadStr = params.payload || '';
    const req = payloadStr ? JSON.parse(payloadStr) : {};
    const action = req.action;

    if (action === 'pull') {
      return json_({ ok: true, data: {
        books: readBooks_(),
        borrowedBooks: readBorrowed_(),
        boyouBooks: readBoyouBooks_(),
        version: getBooksVersion_()
      } });
    }

    if (action === 'pullBookIds') {
      return json_({ ok: true, data: { books: readBookIds_() } });
    }

    if (action === 'getVersion') {
      return json_({ ok: true, data: { version: getBooksVersion_() } });
    }

    if (action === 'lookupBookUrl') {
      const url = String(req.url || '').trim();
      if (!url) return json_({ ok: false, error: 'Missing url' });
      return json_({ ok: true, data: lookupBookUrl_(url) });
    }

    if (action === 'searchBooks') {
      const keyword = req.keyword || '';
      const result = searchBooksFromBooksTW_(keyword);
      return json_({ ok: true, result });
    }

    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return json_({ ok: false, error: 'doGet error: ' + String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  try {
    const bodyText = (e && e.postData && e.postData.contents) ? e.postData.contents : '';
    const req = bodyText ? JSON.parse(bodyText) : {};
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
      
      // 可以在這裡記錄是哪個使用者更新的借閱記錄
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

    if (action === 'searchBooks') {
      const keyword = req.keyword || '';
      const result = searchBooksFromBooksTW_(keyword);
      return json_({ ok: true, result });
    }

    if (action === 'autoFillBookData') {
      const options = req.options || {};
      const limit = Number(options.limit) || 10;
      const result = autoFillBookData_(limit);
      return json_({ ok: true, result });
    }

    if (action === 'lookupBookUrl') {
      const url = String(req.url || '').trim();
      if (!url) return json_({ ok: false, error: 'Missing url' });
      return json_({ ok: true, data: lookupBookUrl_(url) });
    }

    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

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

// ===== 博客來搜尋 =====
function searchBooksFromBooksTW_(keyword) {
  if (!keyword) return null;
  const url = 'https://search.books.com.tw/search/query/key/' + encodeURIComponent(keyword) + '/adv_sort/1/';
  const options = {
    'headers': {
      'User-Agent': 'Mozilla/5.0 (compatible; BooksCrawler/1.0)'
    }
  };
  const response = UrlFetchApp.fetch(url, options);
  const html = response.getContentText();

  // 簡單解析（正則表達式）
  const titleMatch = html.match(/<h3[^>]*><a[^>]*>([^<]+)<\/a><\/h3>/);
  const authorMatch = html.match(/<div[^>]*class="author"[^>]*>([^<]+)<\/div>/);
  const publisherMatch = html.match(/<div[^>]*class="publisher"[^>]*>([^<]+)<\/div>/);
  const dateMatch = html.match(/<div[^>]*class="date"[^>]*>([^<]+)<\/div>/);
  const coverMatch = html.match(/<img[^>]*class="cover"[^>]*src="([^"]+)"/);

  if (!titleMatch) return null;

  return {
    title: titleMatch[1].trim(),
    author: authorMatch ? authorMatch[1].replace(/作者：/, '').trim() : '',
    publisher: publisherMatch ? publisherMatch[1].replace(/出版社：/, '').trim() : '',
    publishedDate: dateMatch ? dateMatch[1].trim() : '',
    coverUrl: coverMatch ? coverMatch[1].trim() : ''
  };
}

// ===== Book URL metadata =====
function lookupBookUrl_(url) {
  const result = {
    title: '',
    author: '',
    year: '',
    coverUrl: '',
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

    result.title = cleanText_(title);
    result.author = cleanAuthor_(author || extractLabeledText_(html, ['作者', '作者/繪者', '作/繪者']));
    result.year = extractYear_(dateText || extractLabeledText_(html, ['出版日期', '出版日', '出版時間', '出版年份']) || html);
    result.coverUrl = coverUrl || '';
  } catch (e) {
    // Fall back to title search below.
  }

  if ((!result.author || !result.year) && result.title) {
    const fallback = lookupBookByTitle_(result.title);
    result.author = result.author || fallback.author || '';
    result.year = result.year || fallback.year || '';
    result.coverUrl = result.coverUrl || fallback.coverUrl || '';
  }

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
    isbn: map.isbn ?? 14,
    publisher: map.publisher ?? 15,
    description: map.description ?? 16,
    booksUrl: map.booksUrl ?? 17,
    referenceSource: map.referenceSource ?? 18,
    affiliateUrl: map.affiliateUrl ?? 19,
    lastLookupAt: map.lastLookupAt ?? 20,

    bookId: map.bookId ?? 1,
    bookTitle: map.bookTitle ?? 2,
    userId: map.userId ?? 3,
    borrowDate: map.borrowDate ?? 4,
    dueDate: map.dueDate ?? 5,
    returnedAt: map.returnedAt ?? 6,
  };
}

// ===== 自動補齊書籍空白資料 =====
function autoFillBookData_(limit) {
  const sh = getSheet_('Books');
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();

  if (lastRow <= 1) {
    return { success: 0, skipped: 0, errors: 0, message: '沒有書籍資料' };
  }

  const values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  const header = values[0];
  const idx = indexMap_(header);

  let successCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  const errors = [];

  // 從第 2 行開始處理
  for (let i = 1; i < values.length && successCount < limit; i++) {
    const row = values[i];
    const id = row[idx.id] || '';
    const title = row[idx.title] || '';

    if (!id && !title) continue;

    // 檢查是否需要補齊（有空白欄位）
    const needsFill = !row[idx.author] || !row[idx.coverUrl] || !row[idx.genre] || !row[idx.year] || !row[idx.publisher] || !row[idx.isbn] || !row[idx.description];

    if (!needsFill) {
      skippedCount++;
      continue;
    }

    try {
      // 優先使用 ISBN 查詢，如果沒有 ISBN 則使用書名
      const isbn = String(row[idx.isbn] || '').trim();
      const bookTitle = String(title).trim();
      const author = String(row[idx.author] || '').trim();

      let bookData = null;

      // 嘗試 Google Books API
      if (isbn) {
        bookData = fetchFromGoogleBooksByISBN_(isbn);
      }
      if (!bookData && bookTitle) {
        bookData = fetchFromGoogleBooksByTitle_(bookTitle, author);
      }

      // 如果 Google Books 沒有結果，嘗試 Open Library
      if (!bookData && isbn) {
        bookData = fetchFromOpenLibraryByISBN_(isbn);
      }
      if (!bookData && bookTitle) {
        bookData = fetchFromOpenLibraryByTitle_(bookTitle, author);
      }

      if (bookData) {
        // 更新空白欄位，不覆蓋已有資料
        const updates = [];

        // author
        if (!row[idx.author] && bookData.author) {
          updates.push({ col: idx.author + 1, value: bookData.author });
        }

        // coverUrl
        if (!row[idx.coverUrl] && bookData.coverUrl) {
          updates.push({ col: idx.coverUrl + 1, value: bookData.coverUrl });
          // 同時更新 coverImage
          updates.push({ col: idx.coverImage + 1, value: '=IMAGE("' + bookData.coverUrl + '")' });
        }

        // genre
        if (!row[idx.genre] && bookData.genre) {
          updates.push({ col: idx.genre + 1, value: bookData.genre });
        }

        // year
        if (!row[idx.year] && bookData.year) {
          updates.push({ col: idx.year + 1, value: Number(bookData.year) });
        }

        // publisher
        if (!row[idx.publisher] && bookData.publisher) {
          updates.push({ col: idx.publisher + 1, value: bookData.publisher });
        }

        // isbn
        if (!row[idx.isbn] && bookData.isbn) {
          updates.push({ col: idx.isbn + 1, value: bookData.isbn });
        }

        // description
        if (!row[idx.description] && bookData.description) {
          updates.push({ col: idx.description + 1, value: bookData.description });
        }

        // booksUrl
        if (!row[idx.booksUrl] && bookData.booksUrl) {
          updates.push({ col: idx.booksUrl + 1, value: bookData.booksUrl });
        }

        // referenceSource
        if (!row[idx.referenceSource] && bookData.referenceSource) {
          updates.push({ col: idx.referenceSource + 1, value: bookData.referenceSource });
        }

        // affiliateUrl
        if (!row[idx.affiliateUrl] && bookData.affiliateUrl) {
          updates.push({ col: idx.affiliateUrl + 1, value: bookData.affiliateUrl });
        }

        // lastLookupAt
        updates.push({ col: idx.lastLookupAt + 1, value: new Date().toISOString() });

        // 執行更新
        if (updates.length > 0) {
          updates.forEach(update => {
            sh.getRange(i + 1, update.col).setValue(update.value);
          });
          successCount++;
        } else {
          skippedCount++;
        }
      } else {
        skippedCount++;
      }
    } catch (err) {
      errorCount++;
      errors.push({
        id: id,
        title: title,
        error: String(err.message || err)
      });
    }
  }

  return {
    success: successCount,
    skipped: skippedCount,
    errors: errorCount,
    errorDetails: errors,
    message: `成功補齊 ${successCount} 本書，跳過 ${skippedCount} 本，錯誤 ${errorCount} 本`
  };
}

// ===== Google Books API =====
function fetchFromGoogleBooksByISBN_(isbn) {
  const url = 'https://www.googleapis.com/books/v1/volumes?q=isbn:' + encodeURIComponent(isbn);
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) return null;

  const data = JSON.parse(response.getContentText());
  if (!data.items || data.items.length === 0) return null;

  const book = data.items[0].volumeInfo;
  return parseGoogleBookData_(book, 'Google Books (ISBN)');
}

function fetchFromGoogleBooksByTitle_(title, author) {
  let query = 'intitle:' + encodeURIComponent(title);
  if (author) {
    query += '+inauthor:' + encodeURIComponent(author);
  }
  const url = 'https://www.googleapis.com/books/v1/volumes?q=' + query;
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) return null;

  const data = JSON.parse(response.getContentText());
  if (!data.items || data.items.length === 0) return null;

  const book = data.items[0].volumeInfo;
  return parseGoogleBookData_(book, 'Google Books (Title)');
}

function parseGoogleBookData_(book, source) {
  const result = {
    author: '',
    coverUrl: '',
    genre: '',
    year: '',
    publisher: '',
    isbn: '',
    description: '',
    booksUrl: '',
    referenceSource: source,
    affiliateUrl: ''
  };

  // author
  if (book.authors && book.authors.length > 0) {
    result.author = book.authors.join(', ');
  }

  // coverUrl
  if (book.imageLinks && book.imageLinks.thumbnail) {
    result.coverUrl = book.imageLinks.thumbnail.replace('http:', 'https:');
  }

  // genre (categories)
  if (book.categories && book.categories.length > 0) {
    result.genre = book.categories[0];
  }

  // year
  if (book.publishedDate) {
    const yearMatch = book.publishedDate.match(/\d{4}/);
    if (yearMatch) {
      result.year = yearMatch[0];
    }
  }

  // publisher
  if (book.publisher) {
    result.publisher = book.publisher;
  }

  // isbn
  if (book.industryIdentifiers) {
    const isbn13 = book.industryIdentifiers.find(id => id.type === 'ISBN_13');
    const isbn10 = book.industryIdentifiers.find(id => id.type === 'ISBN_10');
    result.isbn = isbn13 ? isbn13.identifier : (isbn10 ? isbn10.identifier : '');
  }

  // description
  if (book.description) {
    result.description = book.description.replace(/<[^>]*>/g, '').substring(0, 500);
  }

  // booksUrl
  if (book.infoLink) {
    result.booksUrl = book.infoLink;
  }

  return result;
}

// ===== Open Library API =====
function fetchFromOpenLibraryByISBN_(isbn) {
  const url = 'https://openlibrary.org/api/books?bibkeys=ISBN:' + encodeURIComponent(isbn) + '&format=json&jscmd=data';
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) return null;

  const data = JSON.parse(response.getContentText());
  const key = 'ISBN:' + isbn;
  if (!data[key]) return null;

  return parseOpenLibraryData_(data[key], 'Open Library (ISBN)');
}

function fetchFromOpenLibraryByTitle_(title, author) {
  const url = 'https://openlibrary.org/search.json?title=' + encodeURIComponent(title) + (author ? '&author=' + encodeURIComponent(author) : '') + '&limit=1';
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) return null;

  const data = JSON.parse(response.getContentText());
  if (!data.docs || data.docs.length === 0) return null;

  const doc = data.docs[0];
  const result = {
    author: '',
    coverUrl: '',
    genre: '',
    year: '',
    publisher: '',
    isbn: '',
    description: '',
    booksUrl: '',
    referenceSource: 'Open Library (Title)',
    affiliateUrl: ''
  };

  // author
  if (doc.author_name && doc.author_name.length > 0) {
    result.author = doc.author_name.join(', ');
  }

  // coverUrl
  if (doc.cover_i) {
    result.coverUrl = 'https://covers.openlibrary.org/b/id/' + doc.cover_i + '-M.jpg';
  }

  // year
  if (doc.first_publish_year) {
    result.year = String(doc.first_publish_year);
  }

  // publisher
  if (doc.publisher && doc.publisher.length > 0) {
    result.publisher = doc.publisher[0];
  }

  // isbn
  if (doc.isbn && doc.isbn.length > 0) {
    result.isbn = doc.isbn[0];
  }

  // booksUrl
  if (doc.key) {
    result.booksUrl = 'https://openlibrary.org' + doc.key;
  }

  return result;
}

function parseOpenLibraryData_(book, source) {
  const result = {
    author: '',
    coverUrl: '',
    genre: '',
    year: '',
    publisher: '',
    isbn: '',
    description: '',
    booksUrl: '',
    referenceSource: source,
    affiliateUrl: ''
  };

  // author
  if (book.authors && book.authors.length > 0) {
    result.author = book.authors.map(a => a.name).join(', ');
  }

  // coverUrl
  if (book.cover) {
    result.coverUrl = book.cover.medium || book.cover.large || '';
  }

  // year
  if (book.publish_date) {
    const yearMatch = book.publish_date.match(/\d{4}/);
    if (yearMatch) {
      result.year = yearMatch[0];
    }
  }

  // publisher
  if (book.publishers && book.publishers.length > 0) {
    result.publisher = book.publishers[0].name;
  }

  // isbn
  if (book.identifiers) {
    if (book.identifiers.isbn_13) {
      result.isbn = Array.isArray(book.identifiers.isbn_13) ? book.identifiers.isbn_13[0] : book.identifiers.isbn_13;
    } else if (book.identifiers.isbn_10) {
      result.isbn = Array.isArray(book.identifiers.isbn_10) ? book.identifiers.isbn_10[0] : book.identifiers.isbn_10;
    }
  }

  // description
  if (book.notes) {
    result.description = book.notes.replace(/<[^>]*>/g, '').substring(0, 500);
  }

  // booksUrl
  if (book.url) {
    result.booksUrl = book.url;
  }

  return result;
}
