// 圖書館管理系統核心功能
class LibrarySystem {
    constructor() {
        this.books = [];
        this.borrowedBooks = [];
        this.users = [];
        this.currentUser = null;
        this.adminUsername = 'sindy16872000';
        this.bookIdPattern = /^[ABCD]\d+$/;
        this.defaultGoogleWebAppUrl = 'https://script.google.com/macros/s/AKfycbxYZodHltoNvStyYHg3iHwflZ2W6g3vPNKftIOo3e8A22-jNL_-j_GmBbxzZwLt9Ot_/exec';
        this.autoSyncTimer = null;
        this.autoSyncLastRunAt = 0;
        this.autoSyncCooldownUntil = 0;
        this.autoSyncMinIntervalMs = 30000;
        this.autoSyncDebounceMs = 1500;
        this.pushNowInFlight = false;
        this.suspendAutoSync = false;
        this.currentBookType = 'series'; // 預設顯示系列書
        this.adminBorrowedTab = 'active'; // 管理者借閱紀錄預設顯示借閱中
        this.remoteBookIdCache = {
            ids: new Set(),
            titlesById: new Map(),
            fetchedAt: 0,
            inFlight: null
        };
        this.bookLookupCache = new Map();
        this.bookLookupInFlight = new Map();
        this.googleBooksCooldownUntil = 0;
        this.autoFillTimers = new Map();
        this.googleSheetTimeoutMs = 18000;
        
        // API 節流與重試機制
        this.lastApiRequestTime = 0;
        this.apiRequestDelay = 3000; // 增加到 3 秒間隔，避免 429 錯誤
        this.apiRetryConfig = {
            maxRetries: 3, // 減少重試次數，避免過度重試
            baseDelay: 5000, // 增加基礎延遲到 5 秒
            maxDelay: 30000 // 增加最大延遲到 30 秒
        };
        this.apiRequestQueue = [];
        this.apiRequestInProgress = false;
        
        // 搜尋狀態控制
        this.searchState = {
            isRunning: false,
            isPaused: false,
            shouldStop: false,
            currentIndex: 0,
            totalBooks: 0,
            successCount: 0,
            failCount: 0,
            searchQueue: []
        };
        
        this.settings = {
            loanDays: 14,
            guestBorrow: false,
            defaultCopies: 1,
            defaultYear: 2024,
            autoUpdateInterval: 600000,
            googleWebAppUrl: '',
            googleBooksApiKey: '',
            userLoanSettings: [],
            subAdmins: [
                { username: 'boyo1314', createdAt: new Date().toISOString() }
            ] // 副管理者列表
            ,
            seriesList: [] // 可在設定中維護的系列名稱清單（預設空）
        };
        this.updateTimer = null;
        this.lastUpdateTime = null;
        
        // 快取系統狀態
        this.cacheVersion = null;
        this.lastCacheDownloadDate = null;
        
        this.init();
    }

    // ==================== 快取系統函數 ====================
    
    /**
     * 初始化快取系統 - 從 localStorage 讀取快取狀態
     */
    initCacheSystem() {
        this.cacheVersion = localStorage.getItem('lib_cache_version') || null;
        this.lastCacheDownloadDate = localStorage.getItem('lib_cache_download_date') || null;
    }

    /**
     * 取得書單快取鍵名
     */
    getBookListCacheKey() {
        return 'lib_books_cache_v1';
    }

    /**
     * 取得書單版本鍵名
     */
    getBookListVersionKey() {
        return 'lib_books_version';
    }

    /**
     * 取得上次下載日期鍵名
     */
    getLastDownloadDateKey() {
        return 'lib_cache_download_date';
    }

    /**
     * 檢查是否應該從雲端更新書單
     * 邏輯：
     * 1. 如果今天還沒下載過，需要下載
     * 2. 如果版本信息不同，需要下載
     * 3. 否則使用快取
     */
    async checkShouldUpdateBookList() {
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD 格式
        const lastDownloadDate = localStorage.getItem(this.getLastDownloadDateKey());
        
        // 今天第一次進入網站，需要下載
        if (lastDownloadDate !== today) {
            console.log(`[快取] 今天第一次進入，需要下載。上次下載日期: ${lastDownloadDate}, 今天: ${today}`);
            return true;
        }
        
        // 今天已下載過，檢查版本是否有更新
        const localVersion = localStorage.getItem('lib_cache_version');
        
        // 嘗試從雲端取得版本信息
        try {
            const url = this.getGoogleWebAppUrl();
            if (!url) {
                console.log('[快取] 未設定 Google Sheets URL，使用本地快取');
                return false;
            }

            // 嘗試獲取版本信息（使用 GET 避開手機 CORS 問題）
            const result = await this.callGoogleApi(url, { action: 'getVersion' }, 'GET').catch(() => null);
            
            // 如果響應中有版本信息，比較版本
            if (result && result.data && result.data.version) {
                const remoteVersion = result.data.version;
                
                if (remoteVersion && remoteVersion !== localVersion) {
                    console.log(`[快取] 版本有更新。本地: ${localVersion}, 雲端: ${remoteVersion}`);
                    return true;
                }
                
                console.log(`[快取] 版本未變更，使用本地快取。版本: ${localVersion}`);
                return false;
            } else {
                // 如果無法獲取版本信息，但已有本地快取和版本記錄，則使用快取
                if (localVersion) {
                    console.log('[快取] 無法獲取遠端版本，但已有本地快取，繼續使用');
                    return false;
                }
                
                // 如果沒有本地版本記錄，需要下載
                console.log('[快取] 沒有本地版本記錄，需要下載');
                return true;
            }
        } catch (error) {
            console.log('[快取] 版本檢查失敗，使用本地快取:', error.message);
            
            // 如果檢查失敗但有本地快取，使用快取
            if (localVersion) {
                console.log('[快取] 使用本地快取版本:', localVersion);
                return false;
            }
            
            // 如果沒有本地快取，需要嘗試下載
            return false;
        }
    }

    /**
     * 保存書單到快取
     */
    saveBookListCache(books, borrowedBooks) {
        const validation = this.validateIncomingBookList(books, {
            source: '快取保存',
            allowEmpty: false,
            allowLargeReduction: false
        });
        if (!validation.ok) {
            console.warn('[快取] 略過保存不可信書單:', validation.message);
            return false;
        }

        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD 格式
        localStorage.setItem(this.getBookListCacheKey(), JSON.stringify(validation.books));
        localStorage.setItem(this.getLastDownloadDateKey(), today);
        console.log(`[快取] 已保存書單快取，日期: ${today}, 書籍數: ${validation.books.length}`);
        return true;
    }

    /**
     * 從快取加載書單
     */
    loadBookListCache(options = {}) {
        try {
            const cachedBooks = localStorage.getItem(this.getBookListCacheKey());
            if (!cachedBooks) {
                if (!options.silent) console.log('[快取] 未找到快取的書單');
                return null;
            }
            
            const books = this.normalizeRemoteBooks(JSON.parse(cachedBooks));
            if (books.length === 0) {
                if (!options.silent) console.warn('[快取] 快取書單格式不可信，略過');
                return null;
            }

            const downloadDate = localStorage.getItem(this.getLastDownloadDateKey());
            if (!options.silent) console.log(`[快取] 成功加載快取書單，書籍數: ${books.length}, 快取日期: ${downloadDate}`);
            return books;
        } catch (error) {
            if (!options.silent) console.error('[快取] 加載快取失敗:', error);
            return null;
        }
    }

    /**
     * 更新書單版本時間戳 - 管理員新增/修改/刪除書籍後調用
     * @param {string} timestamp - 版本時間戳（ISO 格式），若不提供則使用當前時間
     */
    updateBookListVersion(timestamp = null) {
        const version = timestamp || new Date().toISOString();
        localStorage.setItem('lib_cache_version', version);
        this.cacheVersion = version;
        console.log(`[快取] 已更新書單版本: ${version}`);
    }

    /**
     * 清除書單快取 - 強制重新下載
     */
    clearBookListCache() {
        localStorage.removeItem(this.getBookListCacheKey());
        localStorage.removeItem(this.getLastDownloadDateKey());
        localStorage.removeItem('lib_cache_version');
        this.cacheVersion = null;
        this.lastCacheDownloadDate = null;
        console.log('[快取] 已清除書單快取');
    }

    /**
     * 取得快取狀態信息
     */
    getCacheStatus() {
        const downloadDate = localStorage.getItem(this.getLastDownloadDateKey());
        const version = localStorage.getItem('lib_cache_version');
        const today = new Date().toISOString().split('T')[0];
        const isCacheValid = downloadDate === today;
        
        return {
            downloadDate,
            version,
            isCacheValid,
            today
        };
    }

    normalizeRemoteBooks(rawBooks) {
        if (!Array.isArray(rawBooks)) return [];

        const bookMap = new Map();
        rawBooks.forEach(book => {
            if (!book || typeof book !== 'object') return;
            const id = String(book.id || '').trim().toUpperCase();
            const title = this.normalizeBookTitle(book.title || '');
            if (!id || !title || !this.bookIdPattern.test(id)) return;

            bookMap.set(id, {
                ...book,
                id,
                title,
                genre: book.genre || this.getGenreFromId(id),
                copies: Math.max(1, Number(book.copies || 1)),
                availableCopies: Math.max(0, Number(book.availableCopies || 0)),
                series: book.series || '',
                createdAt: book.createdAt || book.addedAt || ''
            });
        });

        return Array.from(bookMap.values());
    }

    getLocalBookBaseline() {
        const localBooks = Array.isArray(this.books) ? this.books : [];
        const cachedBooks = this.loadBookListCache({ silent: true }) || [];
        return localBooks.length >= cachedBooks.length ? localBooks : cachedBooks;
    }

    validateIncomingBookList(rawBooks, options = {}) {
        const {
            source = 'Google Sheets',
            allowEmpty = false,
            allowLargeReduction = false,
            baselineBooks = this.getLocalBookBaseline()
        } = options;

        const books = this.normalizeRemoteBooks(rawBooks);
        const baseline = Array.isArray(baselineBooks) ? baselineBooks : [];
        const baselineCount = baseline.length;

        if (books.length === 0 && !allowEmpty) {
            return {
                ok: false,
                books,
                message: `${source} 回傳 0 本書，已保留目前書庫，避免清空。`
            };
        }

        if (!allowLargeReduction && baselineCount >= 10 && books.length < Math.ceil(baselineCount * 0.75)) {
            return {
                ok: false,
                books,
                message: `${source} 回傳 ${books.length} 本，少於目前/快取書庫 ${baselineCount} 本的 75%，疑似讀到錯誤書單，已保留目前資料。`
            };
        }

        const baselineIds = new Set(baseline.map(book => String(book?.id || '').trim().toUpperCase()).filter(Boolean));
        if (!allowLargeReduction && baselineIds.size >= 10 && books.length > 0) {
            const incomingIds = new Set(books.map(book => book.id));
            let overlap = 0;
            baselineIds.forEach(id => {
                if (incomingIds.has(id)) overlap++;
            });

            if (overlap < Math.ceil(baselineIds.size * 0.5)) {
                return {
                    ok: false,
                    books,
                    message: `${source} 書碼與目前書庫差異過大，疑似讀到別的試算表，已取消覆蓋。`
                };
            }
        }

        return { ok: true, books, message: '' };
    }

    applyRemoteBookList(rawBooks, options = {}) {
        const validation = this.validateIncomingBookList(rawBooks, options);
        if (!validation.ok) {
            console.warn('[書庫保護]', validation.message);
            if (!options.silent) this.showToast(validation.message, 'warning', 8000);
            return false;
        }

        this.books = validation.books;
        this.hydrateRemoteBookIdCacheFromBooks(this.books);
        return true;
    }

    reportRemoteBookLoad(rawBooks, options = {}) {
        const { source = 'Google Sheets', silent = false } = options;
        const rawCount = Array.isArray(rawBooks) ? rawBooks.filter(book => book && (book.id || book.title)).length : 0;
        const normalizedCount = this.normalizeRemoteBooks(rawBooks).length;

        console.log(`[${source}] Sheet 讀到 ${rawCount} 筆，網站可顯示 ${normalizedCount} 筆`);

        if (!silent && rawCount > normalizedCount) {
            this.showToast(`${source} 讀到 ${rawCount} 筆，可顯示 ${normalizedCount} 筆；有 ${rawCount - normalizedCount} 筆可能缺書名或書碼格式不是 A/B/C/D。`, 'warning', 9000);
        }
    }

    escapeHtml(value) {
        const str = String(value ?? '');
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    getBookFreshTime(book) {
        const addedAt = Number(book?.addedAt) || 0;
        const createdAt = new Date(book?.createdAt || 0).getTime() || 0;
        return Math.max(addedAt, createdAt);
    }

    getNewBookPinDurationMs() {
        return 10 * 60 * 1000;
    }

    isRecentlyUpdatedBook(book) {
        const freshTime = this.getBookFreshTime(book);
        return !!book?.isNew && freshTime > 0 && (Date.now() - freshTime) <= this.getNewBookPinDurationMs();
    }

    compareFreshBooks(a, b) {
        const aFresh = this.isRecentlyUpdatedBook(a);
        const bFresh = this.isRecentlyUpdatedBook(b);
        if (aFresh !== bFresh) return aFresh ? -1 : 1;
        return this.getBookFreshTime(b) - this.getBookFreshTime(a);
    }

    scheduleNewBookPinRefresh(books = this.books) {
        if (this.newBookPinTimer) {
            clearTimeout(this.newBookPinTimer);
            this.newBookPinTimer = null;
        }

        const now = Date.now();
        const nextExpiry = (Array.isArray(books) ? books : [])
            .filter(book => !!book?.isNew)
            .map(book => this.getBookFreshTime(book) + this.getNewBookPinDurationMs())
            .filter(expiry => expiry > now)
            .sort((a, b) => a - b)[0];

        if (!nextExpiry) return;

        this.newBookPinTimer = setTimeout(() => {
            this.renderBooks();
        }, Math.max(1000, nextExpiry - now + 250));
    }

    getLoanDaysForUser(username) {
        const userId = String(username || '').trim();
        if (!userId) return this.settings.loanDays;

        const list = Array.isArray(this.settings?.userLoanSettings)
            ? this.settings.userLoanSettings
            : [];

        const rule = list.find(r => String(r?.username || '').trim() === userId);
        const days = parseInt(rule?.days, 10);
        if (Number.isFinite(days) && days >= 1 && days <= 365) return days;
        return this.settings.loanDays;
    }

    normalizeUserLoanSettings() {
        if (!Array.isArray(this.settings.userLoanSettings)) {
            this.settings.userLoanSettings = [];
        }

        const normalized = [];
        const seen = new Set();
        this.settings.userLoanSettings.forEach(item => {
            if (!item || typeof item !== 'object') return;
            const username = String(item.username || '').trim();
            if (!username) return;
            if (seen.has(username)) return;
            const days = parseInt(item.days, 10);
            if (!Number.isFinite(days) || days < 1 || days > 365) return;
            seen.add(username);
            normalized.push({
                username,
                days,
                reason: String(item.reason || '').trim(),
                updatedAt: item.updatedAt || new Date().toISOString()
            });
        });

        normalized.sort((a, b) => a.username.localeCompare(b.username, 'zh-Hant'));
        this.settings.userLoanSettings = normalized;
    }

    // 從書名判斷系列名稱
    // 自動推斷套書名稱（從書名中提取共同開頭）
    autoInferSeriesName(book) {
        const title = book.title || book.name || book['書名'] || '';

        if (!title) return null;

        // 嘗試提取共同開頭（例如「小天使1 我們一起做成有之類」→「小天使」）
        // 先匹配「名稱+數字」的格式
        const match = title.match(/^([^\d\s]+)\s*\d+/);
        if (match && match[1] && match[1].length >= 3) {
            return match[1];
        }

        // 如果沒有匹配到，嘗試移除數字和標記
        let seriesName = title
            .replace(/[0-9０-９]+/g, '') // 移除所有數字
            .replace(/[第][一二三四五六七八九十百千0-9０-９]*[集冊卷本部季屆]/g, '') // 移除「第X集/冊/卷/本/部/季/屆」或「第卷」
            .replace(/[集冊卷本部季屆]/g, '') // 移除單獨的「集/冊/卷/本/部/季/屆」
            .replace(/[上下中左右]/g, '') // 移除「上下中左右」
            .replace(/[（(].*?[）)]/g, '') // 移除括號內的內容
            .replace(/【.*?】/g, '') // 移除【】內的內容
            .replace(/[IVX]+/g, '') // 移除羅馬數字
            .replace(/首部曲|二部曲|三部曲|四部曲|終部曲/g, '') // 移除部曲
            .replace(/[：:－\-].*$/g, '') // 移除冒號後的內容
            .replace(/\s+/g, '') // 移除所有空格
            .trim();

        // 如果移除後的結果太短或為空，返回 null
        if (!seriesName || seriesName.length < 3) {
            return null;
        }

        return seriesName;
    }

    getSeriesName(book) {
        const title = book.title || book.name || book['書名'] || '';

        // 常見套書名稱改由設定 `this.settings.seriesList` 提供（預設空）
        const commonSeriesNames = Array.isArray(this.settings.seriesList) ? this.settings.seriesList : [];
        for (const seriesName of commonSeriesNames) {
            if (seriesName && title.includes(seriesName)) {
                return seriesName;
            }
        }

        // 如果沒有匹配到常見套書名稱，使用原本的規則
        return title
            .replace(/[0-9０-９]+/g, '') // 移除所有數字
            .replace(/[第][一二三四五六七八九十百千0-9０-９]+[集冊卷本部季屆]/g, '') // 移除「第X集/冊/卷/本/部/季/屆」
            .replace(/[上下中左右]/g, '') // 移除「上下中左右」
            .replace(/[（(].*?[）)]/g, '') // 移除括號內的內容
            .replace(/【.*?】/g, '') // 移除【】內的內容
            .replace(/[IVX]+/g, '') // 移除羅馬數字
            .replace(/首部曲|二部曲|三部曲|四部曲|終部曲/g, '') // 移除部曲
            .replace(/[：:－\-].*$/g, '') // 移除冒號後的內容
            .replace(/\s+/g, '') // 移除所有空格
            .trim() || '其他書籍';
    }

    normalizeSeriesName(name) {
        return String(name || '')
            .trim()
            .replace(/[\u3000\s]+/g, ' ')
            .replace(/[：:]/g, ' ')
            .replace(/[-–—_]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    getDisplaySeriesName(book) {
        const manualSeries = book.series && String(book.series).trim();
        if (manualSeries) {
            return this.normalizeSeriesName(manualSeries);
        }

        const inferred = this.autoInferSeriesName(book) || this.getSeriesName(book);
        return this.normalizeSeriesName(inferred) || '單本書';
    }

    // 偵測相似套書格式
    findSimilarSeriesBook(title) {
        const currentSeriesName = this.getSeriesName({ title });

        // 在現有書籍中尋找相同套書名稱的書
        for (const book of this.books) {
            const bookSeriesName = this.getSeriesName(book);
            if (bookSeriesName === currentSeriesName && bookSeriesName !== '其他書籍') {
                return {
                    similarBook: book,
                    seriesName: bookSeriesName
                };
            }
        }

        return null;
    }

    // 將書籍按系列分組
    groupBooksBySeries(books) {
        const groups = {};

        books.forEach(book => {
            const seriesName = this.getDisplaySeriesName(book);
            if (!groups[seriesName]) {
                groups[seriesName] = [];
            }
            groups[seriesName].push(book);
        });

        const finalGroups = {};
        Object.keys(groups).forEach(seriesName => {
            const booksInGroup = groups[seriesName];
            const isSingleBookGroup = booksInGroup.length < 2;
            const hasManualSeries = booksInGroup.some(book => book.series && String(book.series).trim());

            if (seriesName === '單本書' || (isSingleBookGroup && !hasManualSeries)) {
                if (!finalGroups['單本書']) {
                    finalGroups['單本書'] = [];
                }
                finalGroups['單本書'].push(...booksInGroup);
            } else {
                finalGroups[seriesName] = booksInGroup;
            }
        });

        return finalGroups;
    }

    // 直接輸入書碼借閱
    async borrowByBookCode() {
        const input = document.getElementById('borrow-by-code-input');
        const raw = (input?.value || '').trim();

        if (!this.currentUser) {
            this.showToast('請先登入', 'error');
            return;
        }

        if (!raw) {
            this.showToast('請輸入書碼，可一次輸入多本', 'error');
            return;
        }

        const codes = [...new Set(raw
            .toUpperCase()
            .split(/[\s,，、;；]+/)
            .map(code => code.trim())
            .filter(Boolean)
        )];

        if (codes.length === 0) {
            this.showToast('請輸入有效書碼', 'error');
            return;
        }

        const results = [];
        for (const code of codes) {
            results.push(this.borrowExactBookCode(code));
        }

        const successCount = results.filter(result => result.ok).length;
        const failed = results.filter(result => !result.ok);

        if (successCount > 0) {
            this.saveData();
            this.triggerSyncForAction('borrow');
            this.renderBooks();
            this.renderBorrowedBooks();
            this.updateStats();
        }

        if (input && failed.length === 0) input.value = '';

        if (failed.length > 0) {
            this.showToast(`完成 ${successCount} 本，失敗 ${failed.length} 本：${failed.slice(0, 3).map(x => `${x.code} ${x.message}`).join('；')}`, successCount > 0 ? 'warning' : 'error');
        } else {
            this.showToast(`批量借閱成功：${successCount} 本`, 'success');
        }
    }

    borrowExactBookCode(code) {
        if (!this.bookIdPattern.test(code)) {
            return { ok: false, code, message: '格式錯誤' };
        }

        const book = this.books.find(b => String(b.id || '').toUpperCase() === code);
        if (!book) {
            return { ok: false, code, message: '找不到書籍' };
        }

        const stock = this.getBookStock(book);
        if (stock.available <= 0) {
            return { ok: false, code, message: '已借完' };
        }

        const userBorrowedCount = this.borrowedBooks.filter(
            b => b.bookId === book.id && b.userId === this.currentUser.username && !b.returnedAt
        ).length;

        if (userBorrowedCount >= (book.copies || 1)) {
            return { ok: false, code, message: '已借滿此書' };
        }

        const totalCopies = stock.total;
        let copyNo = null;
        if (totalCopies > 1) {
            const usedCopyNos = new Set(
                this.borrowedBooks
                    .filter(b => b.bookId === book.id && !b.returnedAt && Number.isFinite(Number(b.copyNo)))
                    .map(b => Number(b.copyNo))
            );
            for (let i = 1; i <= totalCopies; i++) {
                if (!usedCopyNos.has(i)) {
                    copyNo = i;
                    break;
                }
            }
            if (!copyNo) {
                return { ok: false, code, message: '已借完' };
            }
        }

        const borrowDate = new Date();
        const loanDays = this.getLoanDaysForUser(this.currentUser.username);
        const dueDate = new Date(borrowDate.getTime() + loanDays * 24 * 60 * 60 * 1000);

        const borrowRecord = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            bookId: book.id,
            bookTitle: book.title,
            userId: this.currentUser.username,
            borrowDate: borrowDate.toISOString(),
            dueDate: dueDate.toISOString(),
            loanDays,
            copyNo,
            returnedAt: null
        };

        this.borrowedBooks.push(borrowRecord);
        book.availableCopies = Math.max(0, (Number(book.availableCopies) || 0) - 1);
        return { ok: true, code, message: '成功' };
    }

    // 初始化系統
    init() {
        this.loadData();
        this.initCacheSystem(); // 初始化快取系統
        this.hydrateRemoteBookIdCacheFromBooks(this.books);
        this.setupEventListeners();
        this.syncBorrowedPanelForViewport();
        this.syncAppHeaderHeight();

        const hasLocalBooks = Array.isArray(this.books) && this.books.length > 0;
        const hasLocalBorrowed = Array.isArray(this.borrowedBooks) && this.borrowedBooks.length > 0;

        if (!hasLocalBooks && !hasLocalBorrowed) {
            const cachedBooks = this.loadBookListCache({ silent: true });
            if (cachedBooks && cachedBooks.length > 0) {
                this.books = cachedBooks;
                this.hydrateRemoteBookIdCacheFromBooks(this.books);
            }
            // 手機上先讓畫面可以操作，再到背景同步 Google Sheet。
            this.autoLoadFromGoogleSheets();
        } else {
            // 優先從 Google Sheets 載入最新資料
            this.autoLoadFromGoogleSheets();
        }

        this.renderBooks();
        this.renderBorrowedBooks();
        this.updateStats();
        this.updateUserDisplay();
        this.updateAdminControls();
        this.startAutoUpdate();
    }

    isAdminUser() {
        return !!(this.currentUser && this.currentUser.username === this.adminUsername);
    }

    isSubAdminUser() {
        return !!(this.currentUser && this.currentUser.role === 'subadmin');
    }

    hasAdminAccess() {
        return this.isAdminUser() || this.isSubAdminUser();
    }

    requireAdmin(actionName) {
        if (this.hasAdminAccess()) return true;
        this.showToast(`${actionName}：僅限管理者帳號`, 'error');
        return false;
    }

    requireSuperAdmin(actionName) {
        if (this.isAdminUser()) return true;
        this.showToast(`${actionName}：僅限主要管理者帳號 ${this.adminUsername}`, 'error');
        return false;
    }

    scrollToSearchArea() {
        const searchArea = document.querySelector('.admin-search-tools');
        const searchInput = document.getElementById('search-input');
        const target = searchArea || searchInput || document.querySelector('.admin-section') || document.body;

        if (target?.scrollIntoView) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        window.setTimeout(() => {
            if (searchInput) {
                searchInput.focus({ preventScroll: true });
            }
        }, 350);
    }

    getSearchResultTargetBook() {
        const rawSearchTerm = document.getElementById('search-input')?.value || '';
        const searchTerm = rawSearchTerm.trim().toLowerCase();
        if (!searchTerm) return null;

        const codeTokens = rawSearchTerm
            .toUpperCase()
            .split(/[\s,，]+/)
            .map(code => code.trim())
            .filter(Boolean);
        const exactCode = codeTokens.find(code => this.bookIdPattern.test(code));

        if (exactCode) {
            return this.books.find(book => {
                const ids = [book.id, ...(Array.isArray(book.bookIds) ? book.bookIds : [])]
                    .map(id => String(id || '').toUpperCase());
                return ids.includes(exactCode);
            }) || null;
        }

        return this.books.find(book =>
            String(book.title || '').toLowerCase().includes(searchTerm) ||
            String(book.author || '').toLowerCase().includes(searchTerm) ||
            String(book.id || '').toLowerCase().includes(searchTerm) ||
            String(book.year ?? '').toLowerCase().includes(searchTerm) ||
            String(book.genre || '').toLowerCase().includes(searchTerm)
        ) || null;
    }

    scrollToSearchResultCard() {
        window.setTimeout(() => {
            const targetBook = this.getSearchResultTargetBook();
            if (!targetBook) {
                this.showToast('沒有找到符合的書籍', 'warning');
                return;
            }

            const targetId = String(targetBook.id || '').trim();
            const escapedId = window.CSS?.escape ? CSS.escape(targetId) : targetId.replace(/"/g, '\\"');
            const visibleCard = document.querySelector(`.book-card[data-book-id="${escapedId}"]`);
            if (visibleCard) {
                this.scrollElementIntoViewAndHighlight(visibleCard);
                return;
            }

            const seriesEntry = Object.entries(this.seriesModalData || {}).find(([, data]) =>
                Array.isArray(data?.books) && data.books.some(book => book.id === targetId)
            );

            if (seriesEntry) {
                const [seriesId] = seriesEntry;
                this.showSeriesModal(seriesId);
                window.setTimeout(() => {
                    const modalItem = document.querySelector(`.series-modal-item[data-book-id="${escapedId}"]`);
                    if (modalItem) {
                        this.scrollElementIntoViewAndHighlight(modalItem);
                    }
                }, 120);
                return;
            }

            this.showToast('已找到書籍，但目前分頁沒有顯示；請切換系列書/單本書查看', 'info');
        }, 80);
    }

    scrollElementIntoViewAndHighlight(element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element.classList.remove('search-jump-highlight');
        void element.offsetWidth;
        element.classList.add('search-jump-highlight');
        window.setTimeout(() => {
            element.classList.remove('search-jump-highlight');
        }, 1800);
    }

    
    async duplicateBookAsNewCopy(bookId) {
        if (!this.requireAdmin('新增複本')) return;

        const clickedId = String(bookId || '').trim();
        if (!clickedId) return;

        // 可能是合併卡片（用主書碼點進來），先找出同書名的所有候選
        const found = this.books.find(b => b.id === clickedId);
        let candidates = [];
        if (found) {
            const normalizedTitle = this.normalizeTitle(found.title);
            candidates = this.books.filter(b => this.normalizeTitle(b.title) === normalizedTitle);
        } else {
            // 若主書碼找不到（理論上不太會），嘗試從合併資訊回推
            const mergedBooks = this.mergeBooksByTitle(this.books);
            const merged = mergedBooks.find(mb => Array.isArray(mb.bookIds) && mb.bookIds.includes(clickedId));
            candidates = merged?.mergedBooks || [];
        }

        let baseBook = found;
        if (Array.isArray(candidates) && candidates.length > 1) {
            const chosen = await this.showSelectionModal({
                title: '選擇要複製的書碼',
                message: '此書名有多個書碼，請選擇要作為樣板的書碼（會複製作者/年份/封面等資料）',
                options: candidates.map(b => ({
                    value: b.id,
                    title: `書碼：${b.id}`,
                    subtitle: `${b.author ? `作者：${b.author}｜` : ''}${b.year ? `${b.year}年` : ''}`,
                    imageUrl: b.coverUrl || ''
                }))
            });
            if (!chosen) return;
            baseBook = this.books.find(b => b.id === chosen) || candidates.find(b => b.id === chosen) || found;
        }

        if (!baseBook) {
            this.showToast('找不到要複製的書籍', 'error');
            return;
        }

        const prefixMatch = String(baseBook.id || '').toUpperCase().match(/^([ABCD])(\d+)$/);
        const prefix = prefixMatch ? prefixMatch[1] : null;
        await this.refreshRemoteBookIdCache({ silent: true, force: false });
        const newId = this.generateNextBookId(prefix);
        if (!newId) {
            this.showToast('無法產生新書碼', 'error');
            return;
        }

        if (this.hasGoogleSheetBookId(newId)) {
            this.showToast(this.getGoogleSheetBookIdExistsMessage(newId), 'error', 8000);
            return;
        }

        const now = Date.now();
        const newBook = {
            id: newId,
            bookIds: [newId],
            title: baseBook.title,
            author: baseBook.author || '',
            coverUrl: baseBook.coverUrl || '',
            bookUrl: baseBook.bookUrl || '',
            genre: baseBook.genre || this.getGenreFromId(newId),
            year: Number(baseBook.year) || this.settings.defaultYear,
            copies: 1,
            availableCopies: 1,
            isNew: true,
            addedAt: now,
            updatedAt: now,
            createdAt: new Date().toISOString()
        };

        this.books.push(newBook);
        this.saveData();
        this.triggerSyncForAction('addBook');
        this.renderBooks();
        this.updateStats();
        this.showToast(`已新增複本：${newId}`, 'success');
    }

    updateAdminControls() {
        const isAdmin = this.isAdminUser();
        const hasAdminAccess = this.hasAdminAccess();
        const ids = [
            'google-sync-btn',
            'google-load-btn',
            'google-push-btn',
            'google-pull-btn',
            'settings-btn',
            'import-btn',
            'add-book-btn',
            'fetch-all-covers-btn',
            'reload-csv-btn',
            'toggle-auto-update-btn',
            'reset-btn',
            'show-missing-ids-btn',
            'check-title-format-btn'
        ];

        ids.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            // reset-btn 和查看缺失書碼只有主要管理者可以看
            if (id === 'reset-btn' || id === 'show-missing-ids-btn' || id === 'check-title-format-btn') {
                el.style.display = isAdmin ? '' : 'none';
                el.disabled = !isAdmin;
            } else {
                // 其他按鈕主要管理者和副管理者都可以看
                el.style.display = hasAdminAccess ? '' : 'none';
                el.disabled = !hasAdminAccess;
            }
            el.title = '';
            el.style.opacity = '';
            el.style.cursor = '';
        });

        const fileInput = document.getElementById('file-input');
        if (fileInput) {
            fileInput.style.display = hasAdminAccess ? '' : 'none';
            fileInput.disabled = !hasAdminAccess;
        }

        const adminFab = document.getElementById('admin-fab');
        if (adminFab) {
            adminFab.style.display = hasAdminAccess ? '' : 'none';
            adminFab.disabled = !hasAdminAccess;
        }

        // 隱藏副管理者管理標籤（只有主要管理者可以看到）
        const subAdminTab = document.querySelector('.tab-btn[onclick*="sub-admin"]');
        if (subAdminTab) {
            subAdminTab.style.display = isAdmin ? '' : 'none';
        }

        this.renderAdminActionsSheet();
    }

    async pushToGoogleSheetsNow() {
        // 管理員可以執行完整上傳，一般使用者只能上傳借閱記錄
        const url = this.getGoogleWebAppUrl();
        if (!url) return;
        if (this.pushNowInFlight) return;

        this.pushNowInFlight = true;
        try {
            if (this.isAdminUser()) {
                // 管理員：上傳完整資料（書籍 + 借閱記錄）
                await this.pushToGoogleSheets({ silent: true });
            } else {
                // 一般使用者：只上傳借閱記錄
                await this.pushBorrowedBooksToGoogleSheets({ silent: true });
            }
        } catch (e) {
            console.error('pushToGoogleSheetsNow error:', e);
        } finally {
            this.pushNowInFlight = false;
        }
    }

    getGoogleWebAppUrl() {
        const url = (this.settings?.googleWebAppUrl || '').trim();
        return url || null;
    }

    getGoogleBooksApiKey() {
        return (this.settings?.googleBooksApiKey || '').trim();
    }

    getGoogleBooksApiKeyParam() {
        const key = this.getGoogleBooksApiKey();
        return key ? `&key=${encodeURIComponent(key)}` : '';
    }

    // ==================== 通用 Google Apps Script API 呼叫 ====================
    // 小資料讀取用 GET，避免手機瀏覽器的 CORS preflight。
    // 上傳或大型資料必須用 POST，避免網址過長造成 413 Content Too Large。

    /**
     * 統一呼叫 Google Apps Script Web App
     * @param {string} baseUrl - Web App 網址
     * @param {object} payload - 要傳送的資料（含 action 欄位）
     * @param {'GET'|'POST'} preferMethod - 偏好方式，預設 'GET'
     * @returns {Promise<object>} - 回傳解析後的 JSON
     */
    async callGoogleApi(baseUrl, payload, preferMethod = 'GET') {
        if (!baseUrl) throw new Error('未設定 Google Apps Script Web App 網址');

        const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
        const payloadText = JSON.stringify(payload);
        const shouldPost = preferMethod === 'POST' || payloadText.length > 1800;
        const method = shouldPost ? 'POST' : 'GET';
        const timeoutMs = isMobile ? this.googleSheetTimeoutMs : 30000;

        // ── GET 方式（Simple Request，無 CORS preflight） ──
        if (method === 'GET') {
            const params = new URLSearchParams({ payload: payloadText });
            const url = `${baseUrl}?${params.toString()}`;
            try {
                const resp = await this.fetchWithTimeout(url, { method: 'GET', cache: 'no-store' }, timeoutMs);
                if (!resp.ok) {
                    const errText = await resp.text().catch(() => '');
                    throw new Error(`HTTP ${resp.status}${errText ? ': ' + errText.slice(0, 120) : ''}`);
                }
                const text = await resp.text();
                // Google Apps Script 可能回傳 redirect HTML，嘗試直接解析 JSON
                try {
                    return JSON.parse(text);
                } catch (_) {
                    // 若不是 JSON，代表可能是 HTML 錯誤頁
                    console.warn('[callGoogleApi] 回傳非 JSON:', text.slice(0, 200));
                    throw new Error('API 回傳非 JSON 資料，請確認 Apps Script 已部署並設定「任何人可存取」');
                }
            } catch (err) {
                // GET 失敗時嘗試 POST fallback（非手機）
                if (!isMobile) {
                    console.warn('[callGoogleApi] GET 失敗，改用 POST:', err.message);
                    return await this._callGoogleApiPost(baseUrl, payload);
                }
                // 手機 GET 也失敗：顯示明確錯誤
                this._showApiNetworkError(err);
                throw err;
            }
        }

        // ── POST 方式（上傳或大型資料用） ──
        return await this._callGoogleApiPost(baseUrl, payload, isMobile ? 45000 : 30000);
    }

    async fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, {
                ...options,
                signal: controller.signal
            });
        } catch (error) {
            if (error?.name === 'AbortError') {
                throw new Error(`Google Sheet 讀取逾時，請稍後重試`);
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    async _callGoogleApiPost(baseUrl, payload, timeoutMs = 30000) {
        const resp = await this.fetchWithTimeout(baseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload),
            cache: 'no-store'
        }, timeoutMs);
        if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            throw new Error(`HTTP ${resp.status}${errText ? ': ' + errText.slice(0, 120) : ''}`);
        }
        const text = await resp.text();
        try {
            return JSON.parse(text);
        } catch (_) {
            throw new Error('API 回傳非 JSON 資料');
        }
    }

    /**
     * 顯示明確的網路/CORS 錯誤訊息（手機友善）
     */
    _showApiNetworkError(err) {
        const msg = (err && err.message) || '';
        let userMsg = '';
        if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('Load failed')) {
            userMsg = '❌ 無法連線到 Google 雲端資料\n可能原因：\n1. 網路不穩定，請確認手機有網路\n2. Apps Script 未部署或存取權限未設「任何人」\n3. 請嘗試重新整理書單';
        } else if (msg.includes('非 JSON')) {
            userMsg = '❌ Google Apps Script 回傳格式錯誤\n請確認 Apps Script 部署設定：\n・存取對象：任何人\n・執行身分：我（部署者）';
        } else {
            userMsg = `❌ 雲端資料載入失敗\n錯誤：${msg.slice(0, 100)}`;
        }
        console.error('[API Error]', msg);
        // 顯示 toast（不用 alert 避免阻塞）
        this.showToast(userMsg.split('\n')[0], 'error', 7000);
        // 同時在頁面上顯示詳細資訊（僅在 books-container 為空時）
        const container = document.getElementById('books-container');
        if (container && container.children.length === 0) {
            container.innerHTML = `
                <div class="empty-state" style="padding:20px;text-align:center;">
                    <i class="fas fa-cloud-slash" style="font-size:2rem;color:#e53e3e;margin-bottom:12px;display:block;"></i>
                    <h3 style="color:#e53e3e;">無法讀取雲端資料</h3>
                    <p style="white-space:pre-line;color:#4a5568;font-size:0.9rem;">${userMsg.replace(/\n/g, '<br>')}</p>
                    <button class="btn btn-primary" style="margin-top:12px;" onclick="library.refreshBookList()">
                        <i class="fas fa-redo"></i> 重新嘗試
                    </button>
                </div>`;
        }
    }

    startAutoPull() {
        const url = this.getGoogleWebAppUrl();
        if (!url) return;

        // 避免阻塞初始化，延後到下一輪事件迴圈
        setTimeout(() => {
            this.pullFromGoogleSheets({ silent: true, protectEmpty: true, closeModal: false });
        }, 0);
    }

    startAutoSync() {
        // 不用登入也能自動上傳，但必須先由管理者設定好 Web App URL
        // 這裡只做啟動，不做提示，避免干擾使用者
        this.scheduleAutoSync();
    }

    scheduleAutoSync() {
        if (this.autoSyncTimer) {
            clearTimeout(this.autoSyncTimer);
        }

        this.autoSyncTimer = setTimeout(() => {
            this.autoSyncTimer = null;
            this.autoPushToGoogleSheets();
        }, this.autoSyncDebounceMs);
    }

    // 根據動作類型決定是否要觸發同步（僅在會變更館藏資料的動作才同步）
    triggerSyncForAction(action) {
        const allowedActions = [
            'addBook',
            'editBook',
            'deleteBook',
            'importBooks',
            'bulkImport',
            'saveSettings',
            'enter',
            'borrow',
            'return'
        ];

        try {
            if (!allowedActions.includes(action)) {
                // 非同步範圍的動作，跳過自動上傳
                return;
            }

            // 借閱/歸還先讓畫面成功更新，再交給背景同步，避免手機網路慢時卡住操作。
            this.scheduleAutoSync();
            if (action === 'borrow' || action === 'return') {
                return;
            }

            // 館藏資料異動才立刻嘗試上傳（靜默模式）
            this.pushToGoogleSheetsNow();
        } catch (e) {
            console.error('triggerSyncForAction error:', e);
        }
    }

    async autoPushToGoogleSheets() {
        // 管理員可以執行完整自動上傳，一般使用者只能自動上傳借閱記錄
        const url = this.getGoogleWebAppUrl();
        if (!url) return;

        const now = Date.now();
        if (now < this.autoSyncCooldownUntil) return;
        if (now - this.autoSyncLastRunAt < this.autoSyncMinIntervalMs) return;
        this.autoSyncLastRunAt = now;

        try {
            if (this.isAdminUser()) {
                // 管理員：上傳完整資料
                await this.pushToGoogleSheets({ silent: true });
            } else {
                // 一般使用者：只上傳借閱記錄
                await this.pushBorrowedBooksToGoogleSheets({ silent: true });
            }
        } catch (e) {
            // 失敗後退避，避免一直打
            this.autoSyncCooldownUntil = Date.now() + 60000;
            console.error('autoPushToGoogleSheets error:', e);
        }
    }

    // 設定事件監聽器
    setupEventListeners() {
        // 搜尋和篩選（元素可能不存在，需防呆）
        const mainSearchInput = document.getElementById('search-input');
        if (mainSearchInput) {
            mainSearchInput.addEventListener('input', () => {
                this.currentPage = 1;
                this.renderBooks();
            });
            mainSearchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.currentPage = 1;
                    this.renderBooks();
                    this.scrollToSearchResultCard();
                }
            });
        }
        document.getElementById('genre-filter').addEventListener('change', () => {
            this.currentPage = 1;
            this.renderBooks();
        });
        document.getElementById('sort-by').addEventListener('change', () => {
            this.currentPage = 1;
            this.renderBooks();
        });
        document.getElementById('sort-order').addEventListener('change', () => {
            this.currentPage = 1;
            this.renderBooks();
        });
        const mainSearchBtn = document.getElementById('search-btn');
        if (mainSearchBtn) {
            mainSearchBtn.addEventListener('click', () => {
                this.currentPage = 1;
                this.renderBooks();
                this.scrollToSearchResultCard();
            });
        }

        const borrowedRecordsBtn = document.getElementById('borrowed-records-btn');
        if (borrowedRecordsBtn) {
            borrowedRecordsBtn.addEventListener('click', () => this.openBorrowedRecordsPanel());
        }

        const mobileSearchFab = document.getElementById('mobile-search-fab');
        if (mobileSearchFab) {
            mobileSearchFab.addEventListener('click', () => this.scrollToSearchArea());
        }

        // 新增館藏：書碼首字母自動同步類別
        const bookPrefixSelect = document.getElementById('book-prefix');
        const bookIdInput = document.getElementById('book-id');
        const bookGenreManual = document.getElementById('book-genre-manual');
        const prevBookIdBtn = document.getElementById('prev-book-id-btn');
        const nextBookIdBtn = document.getElementById('next-book-id-btn');
        if (bookIdInput && bookPrefixSelect) {
            bookIdInput.dataset.bound = '1';
            bookIdInput.addEventListener('input', async () => {
                const raw = String(bookIdInput.value || '');
                const trimmed = raw.trim();
                if (!trimmed) {
                    bookIdInput.style.borderColor = '#e2e8f0';
                    this.hideFieldError?.('book-id');
                    this.updateBookIdNavButtons(true);
                    return;
                }

                const first = trimmed.charAt(0).toUpperCase();
                if (/^[ABCD]$/.test(first)) {
                    bookPrefixSelect.value = first;
                    const fallbackGenre = this.getGenreFromId(first);
                    if (bookGenreManual && fallbackGenre !== '未知') {
                        bookGenreManual.value = fallbackGenre;
                    }
                    if (trimmed.charAt(0) !== first) {
                        const pos = bookIdInput.selectionStart;
                        bookIdInput.value = first + trimmed.slice(1);
                        if (typeof pos === 'number') {
                            bookIdInput.setSelectionRange(pos, pos);
                        }
                    }
                }
                if (!this.remoteBookIdCache.fetchedAt) {
                    await this.refreshRemoteBookIdCache({ silent: true, force: false });
                }
                this.updateBookIdNavButtons();

                const currentValue = String(bookIdInput.value || '').trim().toUpperCase();
                const isValid = /^[ABCD]\d+$/.test(currentValue);
                if (!isValid) {
                    bookIdInput.style.borderColor = '#f56565';
                    this.showFieldError('book-id', '書碼格式：A/B/C/D + 數字');
                    return;
                }

                if (this.hasGoogleSheetBookId(currentValue)) {
                    bookIdInput.style.borderColor = '#f56565';
                    this.showFieldError('book-id', this.getGoogleSheetBookIdExistsMessage(currentValue));
                    return;
                }

                bookIdInput.style.borderColor = '#e2e8f0';
                this.hideFieldError?.('book-id');
            });

            bookPrefixSelect.addEventListener('change', async () => {
                const prefix = String(bookPrefixSelect.value || '').toUpperCase();
                await this.refreshRemoteBookIdCache({ silent: true, force: false });
                const suggested = this.generateNextBookId(prefix);
                if (suggested) {
                    bookIdInput.value = suggested;
                }
                const selectedGenre = bookPrefixSelect.selectedOptions?.[0]?.dataset?.genre;
                if (bookGenreManual && selectedGenre) {
                    bookGenreManual.value = selectedGenre;
                }
                this.updateBookIdNavButtons();
                this.checkBookIdAvailability(bookIdInput.value);
            });

            if (prevBookIdBtn && prevBookIdBtn.dataset.bound !== '1') {
                prevBookIdBtn.dataset.bound = '1';
                prevBookIdBtn.addEventListener('click', () => this.fillAdjacentBookIdFromGoogle('prev'));
            }

            if (nextBookIdBtn && nextBookIdBtn.dataset.bound !== '1') {
                nextBookIdBtn.dataset.bound = '1';
                nextBookIdBtn.addEventListener('click', () => this.fillAdjacentBookIdFromGoogle('next'));
            }
        }

        // 直接輸入書碼借閱
        const borrowByCodeInput = document.getElementById('borrow-by-code-input');
        const borrowByCodeBtn = document.getElementById('borrow-by-code-btn');
        if (borrowByCodeBtn) {
            borrowByCodeBtn.addEventListener('click', () => this.borrowByBookCode());
        }
        if (borrowByCodeInput) {
            borrowByCodeInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.borrowByBookCode();
                }
            });
        }

        // 管理功能
        document.getElementById('boyou-books-btn').addEventListener('click', () => this.goToBoyouBooks());
        document.getElementById('import-btn').addEventListener('click', () => {
            document.getElementById('file-input').click();
        });
        const settingsBtn = document.getElementById('settings-btn');
        if (settingsBtn) settingsBtn.addEventListener('click', () => this.showSettingsModal());
        document.getElementById('google-sync-btn').addEventListener('click', () => this.showGoogleSyncModal());
        document.getElementById('google-load-btn').addEventListener('click', () => this.loadFromGoogleSheets());
        document.getElementById('refresh-booklist-btn').addEventListener('click', () => this.refreshBookList());
        document.getElementById('file-input').addEventListener('change', (e) => this.importBooks(e));
        document.getElementById('add-book-btn').addEventListener('click', () => this.showAddBookModal());
        document.getElementById('show-missing-ids-btn').addEventListener('click', () => this.showMissingBookIds());
        document.getElementById('check-title-format-btn').addEventListener('click', () => this.showBookTitleFormatCheck());
        document.getElementById('fetch-all-covers-btn').addEventListener('click', () => this.showFetchCoversModal());
        document.getElementById('reload-csv-btn').addEventListener('click', () => this.reloadCSV());
        document.getElementById('toggle-auto-update-btn').addEventListener('click', () => this.toggleAutoUpdate());
        document.getElementById('reset-btn').addEventListener('click', () => this.resetData());
        document.getElementById('location-map-btn').addEventListener('click', () => this.showLocationMap());

        // 登入/登出
        document.getElementById('login-btn').addEventListener('click', () => this.showLoginModal());
        document.getElementById('logout-btn').addEventListener('click', () => this.logout());

        // 模態框
        this.setupModalListeners();

        // 表單提交
        document.getElementById('login-form').addEventListener('submit', (e) => this.handleLogin(e));
        document.getElementById('add-book-form').addEventListener('submit', (e) => this.handleAddBook(e));
        const settingsForm = document.getElementById('settings-form');
        if (settingsForm) settingsForm.addEventListener('submit', (e) => this.handleSaveSettings(e));

        // 使用者借閱時間設定
        const userLoanForm = document.getElementById('user-loan-form');
        if (userLoanForm) {
            userLoanForm.addEventListener('submit', (e) => this.handleSaveUserLoanSetting(e));
        }
        const userLoanSearch = document.getElementById('user-loan-search');
        if (userLoanSearch) {
            userLoanSearch.addEventListener('input', () => this.renderUserLoanSettingsList());
        }
        const deleteUserLoanBtn = document.getElementById('delete-user-loan-btn');
        if (deleteUserLoanBtn) {
            deleteUserLoanBtn.addEventListener('click', () => this.handleDeleteUserLoanSetting());
        }

        // 副管理者管理
        const subAdminForm = document.getElementById('sub-admin-form');
        if (subAdminForm) {
            subAdminForm.addEventListener('submit', (e) => this.handleAddSubAdmin(e));
        }
        const editBookForm = document.getElementById('edit-book-form');
        if (editBookForm) {
            editBookForm.addEventListener('submit', (e) => this.handleEditBook(e));
        }

        const fetchCoversForm = document.getElementById('fetch-covers-form');
        if (fetchCoversForm) {
            fetchCoversForm.addEventListener('submit', (e) => this.handleFetchCovers(e));
        }

        // 搜尋範圍選擇變更
        const fetchRange = document.getElementById('fetch-range');
        if (fetchRange) {
            fetchRange.addEventListener('change', (e) => this.toggleFetchOptions(e.target.value));
        }

        // 進度控制按鈕
        const pauseBtn = document.getElementById('pause-search-btn');
        const resumeBtn = document.getElementById('resume-search-btn');
        const stopBtn = document.getElementById('stop-search-btn');
        
        if (pauseBtn) pauseBtn.addEventListener('click', () => this.pauseSearch());
        if (resumeBtn) resumeBtn.addEventListener('click', () => this.resumeSearch());
        if (stopBtn) stopBtn.addEventListener('click', () => this.stopSearch());

        const autoFillAddBtn = document.getElementById('auto-fill-add-book-btn');
        if (autoFillAddBtn) {
            autoFillAddBtn.addEventListener('click', () => this.autoFillBookInfo({
                titleInputId: 'book-title',
                authorInputId: 'book-author',
                yearInputId: 'book-year',
                coverInputId: 'book-cover-url'
            }));
        }

        const autoFillEditBtn = document.getElementById('auto-fill-edit-book-btn');
        if (autoFillEditBtn) {
            autoFillEditBtn.addEventListener('click', () => this.autoFillBookInfo({
                titleInputId: 'edit-book-title',
                authorInputId: 'edit-book-author',
                yearInputId: 'edit-book-year',
                coverInputId: 'edit-book-cover-url'
            }));
        }

        const searchCoverImageBtn = document.getElementById('search-cover-image-btn');
        if (searchCoverImageBtn) {
            searchCoverImageBtn.addEventListener('click', () => this.openCoverImageSearch('book-title', 'book-author'));
        }

        // 新增書籍封面網址貼上事件 - 自動抓取網站資料
        const addCoverInput = document.getElementById('book-cover-url');
        if (addCoverInput) {
            addCoverInput.addEventListener('paste', (e) => {
                const pastedText = (e.clipboardData || window.clipboardData).getData('text');
                console.log('Paste event on cover input:', pastedText);
                if (pastedText && pastedText.startsWith('http')) {
                    setTimeout(() => {
                        this.fetchUrlMetadata(pastedText, 'book-author', 'book-year');
                    }, 100);
                }
            });
        }

        // 新增書籍網址貼上事件 - 自動抓取網站資料
        const addBookUrlInput = document.getElementById('book-url');
        if (addBookUrlInput) {
            addBookUrlInput.addEventListener('paste', (e) => {
                const pastedText = (e.clipboardData || window.clipboardData).getData('text');
                console.log('Paste event on book url input:', pastedText);
                if (pastedText && pastedText.startsWith('http')) {
                    setTimeout(() => {
                        this.fetchUrlMetadata(pastedText, 'book-author', 'book-year');
                    }, 100);
                }
            });
        }

        // 新增書籍書名輸入後自動搜尋
        const addTitleInput = document.getElementById('book-title');
        if (addTitleInput) {
            addTitleInput.addEventListener('blur', () => {
                const normalized = this.normalizeBookTitle(addTitleInput.value);
                if (addTitleInput.value !== normalized) addTitleInput.value = normalized;
                this.scheduleAutoFillBookInfo({
                    titleInputId: 'book-title',
                    authorInputId: 'book-author',
                    yearInputId: 'book-year',
                    coverInputId: 'book-cover-url'
                });
            });
        }

        const editSearchCoverImageBtn = document.getElementById('edit-search-cover-image-btn');
        if (editSearchCoverImageBtn) {
            editSearchCoverImageBtn.addEventListener('click', () => this.openCoverImageSearch('edit-book-title', 'edit-book-author'));
        }

        // 編輯書籍封面網址貼上事件 - 自動抓取網站資料
        const editCoverInput = document.getElementById('edit-book-cover-url');
        if (editCoverInput) {
            editCoverInput.addEventListener('paste', (e) => {
                const pastedText = (e.clipboardData || window.clipboardData).getData('text');
                console.log('Paste event on edit cover input:', pastedText);
                if (pastedText && pastedText.startsWith('http')) {
                    setTimeout(() => {
                        this.fetchUrlMetadata(pastedText, 'edit-book-author', 'edit-book-year');
                    }, 100);
                }
            });
        }

        // 編輯書籍書籍網址貼上事件 - 自動抓取網站資料
        const editBookUrlInput = document.getElementById('edit-book-url');
        if (editBookUrlInput) {
            editBookUrlInput.addEventListener('paste', (e) => {
                const pastedText = (e.clipboardData || window.clipboardData).getData('text');
                console.log('Paste event on edit book url input:', pastedText);
                if (pastedText && pastedText.startsWith('http')) {
                    setTimeout(() => {
                        this.fetchUrlMetadata(pastedText, 'edit-book-author', 'edit-book-year');
                    }, 100);
                }
            });
        }

        // 編輯書籍書名輸入後自動搜尋
        const editTitleInput = document.getElementById('edit-book-title');
        if (editTitleInput) {
            editTitleInput.addEventListener('blur', () => {
                const normalized = this.normalizeBookTitle(editTitleInput.value);
                if (editTitleInput.value !== normalized) editTitleInput.value = normalized;
                this.showSameTitleDifferentPrefixHint({
                    titleFieldId: 'edit-book-title',
                    idFieldId: 'edit-book-id',
                    excludeId: document.getElementById('edit-book-original-id')?.value || ''
                });
                this.scheduleAutoFillBookInfo({
                    titleInputId: 'edit-book-title',
                    authorInputId: 'edit-book-author',
                    yearInputId: 'edit-book-year',
                    coverInputId: 'edit-book-cover-url'
                });
            });
        }

        // 視圖切換
        const gridViewBtn = document.getElementById('grid-view');
        const listViewBtn = document.getElementById('list-view');
        if (gridViewBtn) gridViewBtn.addEventListener('click', () => this.setView('grid'));
        if (listViewBtn) listViewBtn.addEventListener('click', () => this.setView('list'));

        // 匯出借閱清單
        const exportBorrowedBtn = document.getElementById('export-borrowed-btn');
        if (exportBorrowedBtn) {
            exportBorrowedBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.exportBorrowedToExcel();
            });
        }

        // 借閱記錄搜尋和篩選事件監聽器
        const borrowedSearchInput = document.getElementById('borrowed-search-input');
        if (borrowedSearchInput) {
            borrowedSearchInput.addEventListener('input', () => this.searchBorrowedBooks());
            borrowedSearchInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.searchBorrowedBooks();
                }
            });
        }

        const borrowedFilterStatus = document.getElementById('borrowed-filter-status');
        if (borrowedFilterStatus) {
            borrowedFilterStatus.addEventListener('change', () => this.searchBorrowedBooks());
        }

        const borrowedSort = document.getElementById('borrowed-sort');
        if (borrowedSort) {
            borrowedSort.addEventListener('change', () => this.searchBorrowedBooks());
        }

        const borrowedHeader = document.querySelector('.borrowed-header');
        if (borrowedHeader) {
            borrowedHeader.addEventListener('click', () => this.toggleBorrowedPanel());
            borrowedHeader.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.toggleBorrowedPanel();
                }
            });
        }

        const borrowedToggleBtn = document.getElementById('borrowed-toggle-btn');
        if (borrowedToggleBtn) {
            borrowedToggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleBorrowedPanel();
            });
        }

        // 借閱紀錄：關閉按鈕
        const borrowedCloseBtn = document.getElementById('borrowed-close-btn');
        if (borrowedCloseBtn) {
            borrowedCloseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const panel = document.querySelector('.borrowed-section');
                if (panel) {
                    panel.classList.remove('open');
                    panel.classList.add('minimized');
                    panel.classList.add('hidden');
                    this.updateBorrowedToggleIcon();
                }
            });
        }

        // 借閱紀錄：返回首頁按鈕
        const borrowedBackHomeBtn = document.getElementById('borrowed-back-home-btn');
        if (borrowedBackHomeBtn) {
            borrowedBackHomeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                // 關閉借閱紀錄面板
                const panel = document.querySelector('.borrowed-section');
                if (panel) {
                    panel.classList.remove('open');
                    panel.classList.add('minimized');
                    panel.classList.add('hidden');
                    this.updateBorrowedToggleIcon();
                }
                // 回到頁面頂部
                try {
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                } catch (_) {
                    window.scrollTo(0, 0);
                }
            });
        }

        const borrowedFab = document.getElementById('borrowed-fab');
        if (borrowedFab) {
            borrowedFab.addEventListener('click', () => {
                const panel = document.querySelector('.borrowed-section');
                if (panel) {
                    // 直接展開並捲動到可見區域
                    panel.classList.remove('hidden');
                    panel.classList.add('open');
                    panel.classList.remove('minimized');
                    try {
                        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    } catch (_) {
                        panel.scrollIntoView(true);
                    }
                    this.updateBorrowedToggleIcon();
                }

                // 未登入時，引導登入以顯示借閱紀錄
                if (!this.currentUser) {
                    this.showToast('請先登入以查看借閱紀錄', 'info');
                    this.showLoginModal();
                    return;
                }

                // 確保內容為最新
                this.renderBorrowedBooks();
            });
        }

        // Google Sheets 同步
        const googlePullBtn = document.getElementById('google-pull-btn');
        const googlePushBtn = document.getElementById('google-push-btn');
        if (googlePullBtn) googlePullBtn.addEventListener('click', () => this.pullFromGoogleSheets());
        if (googlePushBtn) googlePushBtn.addEventListener('click', () => this.pushToGoogleSheets());

        this.setupAdminActionsSheetListeners();

        window.addEventListener('resize', () => {
            this.syncBorrowedPanelForViewport();
            this.syncAppHeaderHeight();
        });
    }

    syncAppHeaderHeight() {
        const header = document.querySelector('.header');
        if (!header) return;

        const setHeight = () => {
            const h = header.offsetHeight || 0;
            document.documentElement.style.setProperty('--app-header-height', `${h}px`);
        };

        requestAnimationFrame(setHeight);
        setTimeout(setHeight, 150);
    }

    setupAdminActionsSheetListeners() {
        const adminFab = document.getElementById('admin-fab');
        const modal = document.getElementById('admin-actions-modal');
        const closeBtn = document.getElementById('admin-actions-close');

        if (adminFab) {
            adminFab.addEventListener('click', () => {
                if (!this.isAdminUser()) return;
                if (modal) modal.style.display = 'block';
            });
        }

        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                if (modal) modal.style.display = 'none';
            });
        }
    }

    renderAdminActionsSheet() {
        const listEl = document.getElementById('admin-actions-list');
        if (!listEl) return;

        if (!this.hasAdminAccess()) {
            listEl.innerHTML = '';
            return;
        }

        const isAdmin = this.isAdminUser();
        const items = [
            { id: 'settings-btn', label: '系統設定', icon: 'fas fa-cog' },
            { id: 'google-sync-btn', label: 'Google Sheets 同步', icon: 'fas fa-cloud-upload-alt' },
            { id: 'google-load-btn', label: '從 Google Sheets 載入', icon: 'fas fa-cloud-download-alt' },
            { id: 'import-btn', label: '匯入 Excel 書單', icon: 'fas fa-file-import' },
            { id: 'add-book-btn', label: '新增館藏', icon: 'fas fa-plus' },
            { id: 'fetch-all-covers-btn', label: '一鍵搜尋封面', icon: 'fas fa-images' },
            { id: 'reload-csv-btn', label: '重新載入資料', icon: 'fas fa-sync' },
            { id: 'toggle-auto-update-btn', label: '自動更新', icon: 'fas fa-sync-alt' }
        ];

        // 只有主要管理者可以看到重置資料按鈕
        if (isAdmin) {
            items.push({ id: 'reset-btn', label: '重置資料', icon: 'fas fa-trash' });
        }

        listEl.innerHTML = items
            .map(item => {
                return `
<button class="actionsheet-item" type="button" data-target-id="${item.id}">
  <span class="actionsheet-item-left">
    <span class="actionsheet-item-icon"><i class="${item.icon}"></i></span>
    <span class="actionsheet-item-text">${item.label}</span>
  </span>
  <span class="actionsheet-item-right"><i class="fas fa-chevron-right"></i></span>
</button>`;
            })
            .join('');

        listEl.querySelectorAll('[data-target-id]').forEach(btn => {
            btn.addEventListener('click', () => {
                const targetId = btn.getAttribute('data-target-id');
                const target = targetId ? document.getElementById(targetId) : null;
                const modal = document.getElementById('admin-actions-modal');
                if (modal) modal.style.display = 'none';
                if (target) target.click();
            });
        });
    }

    syncBorrowedPanelForViewport() {
        const panel = document.querySelector('.borrowed-section');
        if (!panel) return;

        if (panel.classList.contains('hidden')) {
            this.updateBorrowedToggleIcon();
            return;
        }

        const isMobile = window.innerWidth <= 768;
        if (isMobile) {
            if (!panel.classList.contains('open') && !panel.classList.contains('minimized')) {
                panel.classList.add('minimized');
            }
        } else {
            if (!panel.classList.contains('open') && !panel.classList.contains('minimized')) {
                panel.classList.add('open');
            }
        }

        this.updateBorrowedToggleIcon();
    }

    toggleBorrowedPanel() {
        const panel = document.querySelector('.borrowed-section');
        if (!panel) return;

        const willOpen = !panel.classList.contains('open');
        if (willOpen) {
            panel.classList.remove('hidden');
            panel.classList.add('open');
            panel.classList.remove('minimized');
            // 展開時自動捲動到可見區域，讓使用者直觀看到內容
            try {
                panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } catch (_) {
                // 某些舊版瀏覽器不支援 smooth，忽略即可
                panel.scrollIntoView(true);
            }
        } else {
            panel.classList.remove('open');
            panel.classList.add('minimized');
            panel.classList.add('hidden');
        }

        this.updateBorrowedToggleIcon();
    }

    openBorrowedRecordsPanel() {
        if (!this.currentUser) {
            this.showToast('請先登入以查看借閱紀錄', 'info');
            this.showLoginModal();
            return;
        }

        const panel = document.querySelector('.borrowed-section');
        if (panel) {
            panel.classList.remove('hidden');
            panel.classList.add('open');
            panel.classList.remove('minimized');
            try {
                panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } catch (_) {
                panel.scrollIntoView(true);
            }
            this.updateBorrowedToggleIcon();
        }

        this.renderBorrowedBooks();
    }

    updateBorrowedToggleIcon() {
        const icon = document.querySelector('#borrowed-toggle-btn i');
        const toggleBtn = document.getElementById('borrowed-toggle-btn');
        const fabBtn = document.getElementById('borrowed-fab');
        if (!icon) {
            // 即使找不到 icon，也同步更新無障礙屬性
        }

        const panel = document.querySelector('.borrowed-section');
        if (!panel) return;

        const isOpen = panel.classList.contains('open');
        if (icon) icon.className = isOpen ? 'fas fa-chevron-down' : 'fas fa-chevron-up';
        if (toggleBtn) toggleBtn.setAttribute('aria-expanded', String(isOpen));
        if (fabBtn) fabBtn.setAttribute('aria-pressed', String(isOpen));
    }

    // 設定模態框事件
    setupModalListeners() {
        const modals = document.querySelectorAll('.modal');
        const closes = document.querySelectorAll('.close');

        closes.forEach(close => {
            close.addEventListener('click', (e) => {
                const modal = e.target.closest('.modal');
                modal.style.display = 'none';
            });
        });

        window.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal')) {
                e.target.style.display = 'none';
            }
        });
    }

    // 顯示位置圖
    showLocationMap() {
        const modal = document.getElementById('location-map-modal');
        if (modal) {
            modal.style.display = 'block';
        }
    }

    // 載入資料
    loadData() {
        this.books = JSON.parse(localStorage.getItem('lib_books_v1') || '[]');
        this.borrowedBooks = JSON.parse(localStorage.getItem('lib_borrowed_v1') || '[]');
        this.users = JSON.parse(localStorage.getItem('lib_users_v1') || '[]');
        this.currentUser = JSON.parse(localStorage.getItem('lib_active_user_v1') || 'null');

        const storedSettings = JSON.parse(localStorage.getItem('lib_settings_v1') || 'null');
        if (storedSettings && typeof storedSettings === 'object') {
            this.settings = { ...this.settings, ...storedSettings };
        }

        if (!Number.isFinite(this.settings.autoUpdateInterval) || this.settings.autoUpdateInterval < 600000) {
            this.settings.autoUpdateInterval = 600000;
        }

        if (!this.settings.googleWebAppUrl) {
            this.settings.googleWebAppUrl = this.defaultGoogleWebAppUrl;
        }

        // 確保 subAdmins 存在
        if (!this.settings.subAdmins || !Array.isArray(this.settings.subAdmins)) {
            this.settings.subAdmins = [];
        }

        // 檢查 boyo1314 是否在副管理者列表中
        if (!this.settings.subAdmins.find(sa => sa.username === 'boyo1314')) {
            this.settings.subAdmins.push({
                username: 'boyo1314',
                createdAt: new Date().toISOString()
            });
        }

        localStorage.setItem('lib_settings_v1', JSON.stringify(this.settings));

        // 去重：根據書籍 ID 移除重複項
        const bookMap = new Map();
        this.books.forEach(book => {
            if (book.id && !bookMap.has(book.id)) {
                bookMap.set(book.id, book);
            }
        });
        this.books = Array.from(bookMap.values());

        // 為舊書補上 createdAt 欄位
        this.books = this.books.map((book, index) => ({
            ...book,
            createdAt: book.createdAt || new Date(Number(book.addedAt) || Date.now() - index).toISOString()
        }));

        this.saveData({ skipAutoSync: true });
    }

    // 直接從 Google Sheets 載入書籍
    async loadFromGoogleSheets() {
        if (!this.requireAdmin('從 Google Sheets 載入')) return;

        const url = this.getGoogleWebAppUrl();
        if (!url) {
            this.showToast('請先在系統設定中設定 Google Sheets 同步網址', 'error');
            this.showGoogleSyncModal();
            return;
        }

        const confirmed = confirm('確定要從 Google Sheets 載入書籍資料嗎？\n這會覆蓋目前本機的所有書籍資料。');
        if (!confirmed) return;

        try {
            this.showToast('正在從 Google Sheets 載入書籍資料...', 'info');
            this.showLoadingIndicator(true);

            // 使用 GET 方式，手機不觸發 CORS preflight
            const result = await this.callGoogleApi(url, { action: 'pull' }, 'GET');

            if (!result || !result.ok) {
                throw new Error(`Google Sheets 請求失敗：${result?.error || '請確認部署設定'}`);
            }

            const data = result.data || {};
            if (!Array.isArray(data.books)) {
                throw new Error('資料格式不正確');
            }

            if (data.books.length === 0) {
                const ok = confirm('Google Sheets 中沒有書籍資料。確定要清空本機館藏嗎？');
                if (!ok) {
                    this.showLoadingIndicator(false);
                    return;
                }
            }

            const allowEmpty = data.books.length === 0;
            const allowLargeReduction = allowEmpty;
            const applied = this.applyRemoteBookList([...data.books].reverse(), {
                source: 'Google Sheets',
                allowEmpty,
                allowLargeReduction,
                silent: false
            });
            if (!applied) {
                this.showLoadingIndicator(false);
                return;
            }
            this.setBorrowedBooksFromRemote(Array.isArray(data.borrowedBooks) ? data.borrowedBooks : []);

            // 處理博幼藏書資料
            if (data.boyouBooks && typeof data.boyouBooks === 'object') {
                localStorage.setItem('lib_boyou_books_v1', JSON.stringify(data.boyouBooks));
            }

            // 儲存到本地
            this.saveData({ skipAutoSync: true });
            
            // 重新渲染介面
            this.renderBooks();
            this.renderBorrowedBooks();
            this.updateStats();

            this.showLoadingIndicator(false);
            this.showToast(`成功載入 ${this.books.length} 本書籍資料`, 'success');

        } catch (error) {
            console.error('從 Google Sheets 載入失敗:', error);
            this.showLoadingIndicator(false);
            this.showToast('載入失敗，請檢查網路連線或 Google Sheets 設定', 'error');
        }
    }

    showGoogleSyncModal() {
        if (!this.requireAdmin('Google Sheets 同步')) return;
        const modal = document.getElementById('google-sync-modal');
        const urlInput = document.getElementById('google-webapp-url');
        if (urlInput) {
            urlInput.value = this.settings.googleWebAppUrl || '';
        }
        if (modal) {
            modal.style.display = 'block';
        }
    }

    showSettingsModal() {
        if (!this.requireAdmin('系統設定')) return;

        const modal = document.getElementById('settings-modal');
        const loanDays = document.getElementById('loan-days');
        const guestBorrow = document.getElementById('guest-borrow');
        const defaultCopies = document.getElementById('default-copies');
        const defaultYear = document.getElementById('default-year');
        const googleBooksApiKey = document.getElementById('google-books-api-key');

        if (loanDays) loanDays.value = String(this.settings.loanDays ?? 14);
        if (guestBorrow) guestBorrow.checked = !!this.settings.guestBorrow;
        if (defaultCopies) defaultCopies.value = String(this.settings.defaultCopies ?? 1);
        if (defaultYear) defaultYear.value = String(this.settings.defaultYear ?? 2024);
        if (googleBooksApiKey) googleBooksApiKey.value = this.settings.googleBooksApiKey || '';

        this.normalizeUserLoanSettings();
        this.renderUserLoanSettingsList();

        if (modal) modal.style.display = 'block';
    }

    handleSaveSettings(e) {
        e.preventDefault();
        if (!this.requireAdmin('儲存設定')) return;

        let loanDays = parseInt(document.getElementById('loan-days')?.value, 10);
        if (!Number.isFinite(loanDays) || loanDays < 1) loanDays = 14;
        const guestBorrow = !!document.getElementById('guest-borrow')?.checked;
        const defaultCopies = parseInt(document.getElementById('default-copies')?.value) || 1;
        const defaultYear = parseInt(document.getElementById('default-year')?.value) || 2024;

        const googleBooksApiKey = (document.getElementById('google-books-api-key')?.value || '').trim();

        this.settings.loanDays = loanDays;
        this.settings.guestBorrow = guestBorrow;
        this.settings.defaultCopies = defaultCopies;
        this.settings.defaultYear = defaultYear;
        this.settings.googleBooksApiKey = googleBooksApiKey;

        this.saveData();
        this.renderBooks();

        const modal = document.getElementById('settings-modal');
        if (modal) modal.style.display = 'none';
        this.showToast('設定已儲存', 'success');
    }

    getGoogleWebAppUrlFromUI() {
        const urlInput = document.getElementById('google-webapp-url');
        const url = urlInput ? urlInput.value.trim() : '';
        if (!url) {
            this.showToast('請先填入 Apps Script Web App URL', 'error');
            return null;
        }
        this.settings.googleWebAppUrl = url;
        this.saveData();
        return url;
    }

    async pushBorrowedBooksToGoogleSheets(options = {}) {
        const { silent = false } = options;
        
        const url = this.getGoogleWebAppUrl();
        if (!url) {
            if (!silent) this.showToast('請先由管理者設定 Google Sheets 同步網址', 'error');
            return;
        }

        let borrowedBooksToUpload = Array.isArray(this.borrowedBooks)
            ? this.borrowedBooks.filter(record => record && record.id)
            : [];

        if (borrowedBooksToUpload.length === 0) {
            console.log('[borrowed sync] 本機沒有可上傳的借閱記錄，略過同步以避免清空雲端資料');
            if (!silent) this.showToast('目前沒有借閱記錄可同步，已略過上傳', 'info');
            return;
        }

        try {
            if (!silent) this.showToast('正在上傳借閱記錄到 Google Sheets...', 'info');

            const remoteResult = await this.callGoogleApi(url, { action: 'pull' }, 'GET').catch(() => null);
            const remoteBorrowed = remoteResult?.ok && Array.isArray(remoteResult?.data?.borrowedBooks)
                ? remoteResult.data.borrowedBooks
                : [];
            if (remoteBorrowed.length > 0) {
                borrowedBooksToUpload = this.mergeBorrowedBooks(borrowedBooksToUpload, remoteBorrowed);
                this.borrowedBooks = borrowedBooksToUpload;
                this.saveData({ skipAutoSync: true });
            }
            
            const result = await this.callGoogleApi(url, {
                action: 'pushBorrowedBooks',
                payload: {
                    borrowedBooks: borrowedBooksToUpload,
                    userId: this.currentUser?.username || 'anonymous'
                }
            }, 'POST');

            if (result && result.ok) {
                if (!silent) this.showToast('借閱記錄上傳完成', 'success');
            } else {
                if (!silent) this.showToast('上傳完成，但回應格式不符', 'warning');
            }
        } catch (error) {
            console.error('pushBorrowedBooksToGoogleSheets error:', error);
            if (!silent) this.showToast(`上傳失敗：${error.message || '請檢查網路連線'}`, 'error');
            if (silent) return;
            throw error;
        }
    }

    async pushToGoogleSheets(options = {}) {
        const { silent = false } = options;
        
        // 檢查管理員權限（非靜默操作需要權限）
        if (!silent && !this.requireAdmin('上傳到 Google Sheets')) return;
        
        const url = this.getGoogleWebAppUrl();
        if (!url) {
            if (!silent) this.showToast('請先由管理者設定 Google Sheets 同步網址', 'error');
            return;
        }

        try {
            if (!silent) this.showToast('正在上傳到 Google Sheets...', 'info');
            const boyouBooks = JSON.parse(localStorage.getItem('lib_boyou_books_v1') || 'null') || {};

            // 去重：根據書籍 ID 移除重複項
            const bookMap = new Map();
            (Array.isArray(this.books) ? this.books : []).forEach(book => {
                if (book.id && !bookMap.has(book.id)) {
                    bookMap.set(book.id, book);
                }
            });
            const deduplicatedBooks = Array.from(bookMap.values());
            const uploadValidation = this.validateIncomingBookList(deduplicatedBooks, {
                source: '本機書庫',
                allowEmpty: false,
                allowLargeReduction: false
            });
            if (!uploadValidation.ok) {
                if (!silent) this.showToast(`已取消上傳：${uploadValidation.message}`, 'error', 8000);
                throw new Error(uploadValidation.message);
            }

            // 確保每本書都有 series 與 createdAt 欄位
            const normalizedBooks = uploadValidation.books.map(b => ({
                ...b,
                bookUrl: b.bookUrl || '',
                series: b.series || '',
                createdAt: b.createdAt || b.addedAt || '',
                updatedAt: b.updatedAt || ''
            }));

            const remoteResult = await this.callGoogleApi(url, { action: 'pull' }, 'GET').catch(() => null);
            const remoteBorrowed = remoteResult?.ok && Array.isArray(remoteResult?.data?.borrowedBooks)
                ? remoteResult.data.borrowedBooks
                : [];
            const borrowedBooksToUpload = remoteBorrowed.length > 0
                ? this.mergeBorrowedBooks(this.borrowedBooks, remoteBorrowed)
                : this.borrowedBooks;
            this.borrowedBooks = borrowedBooksToUpload;

            const result = await this.callGoogleApi(url, {
                action: 'push',
                payload: {
                    books: normalizedBooks,
                    borrowedBooks: borrowedBooksToUpload,
                    boyouBooks
                }
            }, 'POST');

            if (result && result.ok) {
                // 上傳成功後，更新版本信息
                this.updateBookListVersion();
                if (!silent) this.showToast('上傳完成', 'success');
            } else {
                if (!silent) this.showToast(`上傳完成，但回應格式不符：${result?.error || ''}`, 'warning');
            }
        } catch (error) {
            console.error('pushToGoogleSheets error:', error);
            if (!silent) this.showToast(`上傳失敗：${error.message || '請檢查網路或 CORS 設定'}`, 'error');
            throw error;
        }
    }

    async pullFromGoogleSheets(options = {}) {
        const { silent = false, protectEmpty = false, closeModal = true } = options;
        const url = silent ? this.getGoogleWebAppUrl() : this.getGoogleWebAppUrlFromUI();
        if (!url) return;

        try {
            if (!silent) this.showToast('正在從 Google Sheets 下載...', 'info');
            // 使用 GET 方式，手機不會觸發 CORS preflight
            const result = await this.callGoogleApi(url, { action: 'pull' }, 'GET');

            if (!result || !result.ok) {
                if (!silent) this.showToast(`下載失敗：${result?.error || '請檢查 Web App 權限/網址'}`, 'error');
                return;
            }

            const data = result.data || {};
            if (!Array.isArray(data.books) || !Array.isArray(data.borrowedBooks)) {
                if (!silent) this.showToast('下載失敗：資料格式不正確', 'error');
                return;
            }

            if (protectEmpty && data.books.length === 0 && Array.isArray(this.books) && this.books.length > 0) {
                // 自動載入模式：線上空資料時不覆蓋本機，避免把館藏清空
                return;
            }

            if (data.books.length === 0 && Array.isArray(this.books) && this.books.length > 0) {
                const ok = confirm('線上 Books 資料是空的，下載會清空目前館藏。確定要覆蓋嗎？');
                if (!ok) {
                    if (!silent) this.showToast('已取消下載覆蓋', 'info');
                    return;
                }
            }

            this.reportRemoteBookLoad(data.books, { source: 'Google Sheets', silent });
            const applied = this.applyRemoteBookList([...data.books].reverse(), {
                source: 'Google Sheets',
                allowEmpty: !protectEmpty && data.books.length === 0,
                allowLargeReduction: false,
                silent
            });
            if (!applied) return;

            this.setBorrowedBooksFromRemote(data.borrowedBooks);

            if (data.boyouBooks && typeof data.boyouBooks === 'object') {
                localStorage.setItem('lib_boyou_books_v1', JSON.stringify(data.boyouBooks));
            }
            this.saveData({ skipAutoSync: true });
            this.renderBooks();
            this.renderBorrowedBooks();
            this.updateStats();
            if (!silent) this.showToast('下載完成並已同步到本機', 'success');

            if (closeModal) {
                const modal = document.getElementById('google-sync-modal');
                if (modal) modal.style.display = 'none';
            }
        } catch (error) {
            console.error('pullFromGoogleSheets error:', error);
            if (!silent) this.showToast('下載失敗，請檢查網路或 CORS 設定', 'error');
        }
    }

    async autoLoadFromGoogleSheets() {
        const url = this.getGoogleWebAppUrl();
        if (!url) {
            console.log('未設定 Google Sheets URL，跳過自動載入');
            this.showToast('尚未設定 Google Sheets 網址，請由管理者設定同步網址', 'warning');
            return;
        }

        try {
            // 記錄載入前本機是否已有書籍，用來判斷是否為首次匯入
            const hadLocalBooks = Array.isArray(this.books) && this.books.length > 0;
            // 檢查是否應該從雲端更新書單
            console.log('正在檢查書單是否需要更新...');
            const shouldUpdate = await this.checkShouldUpdateBookList();
            
            if (!shouldUpdate) {
                // 不需要更新，嘗試從快取加載
                console.log('[快取策略] 不需要更新，嘗試從快取加載');
                const cachedBooks = this.loadBookListCache();
                if (cachedBooks && cachedBooks.length > 0) {
                    this.books = cachedBooks;
                    // 從本地 localStorage 加載借閱資料（不變）
                    this.borrowedBooks = JSON.parse(localStorage.getItem('lib_borrowed_v1') || '[]');
                    this.lastUpdateTime = new Date();
                    this.updateLastUpdateDisplay();
                    this.renderBooks();
                    this.renderBorrowedBooks();
                    this.updateStats();
                    console.log(`[快取策略] 成功加載快取書籍 ${this.books.length} 本`);
                    this.showToast(`已加載快取書籍 ${this.books.length} 本`, 'info');
                    return;
                } else {
                    // 快取不存在，需要下載
                    console.log('[快取策略] 快取不存在，需要從雲端下載');
                }
            }
            
            // 需要從雲端更新書單
            console.log('[快取策略] 開始從 Google Sheets 下載書單');
            this.showToast('正在同步書單...', 'info');
            
            // 使用 GET 方式，手機不觸發 CORS preflight
            let result;
            try {
                result = await this.callGoogleApi(url, { action: 'pull' }, 'GET');
            } catch (fetchErr) {
                console.log('Google Sheets 載入失敗:', fetchErr.message);
                const cachedBooks = this.loadBookListCache();
                if (cachedBooks && cachedBooks.length > 0) {
                    this.books = cachedBooks;
                    this.borrowedBooks = JSON.parse(localStorage.getItem('lib_borrowed_v1') || '[]');
                    this.lastUpdateTime = new Date();
                    this.updateLastUpdateDisplay();
                    this.renderBooks();
                    this.renderBorrowedBooks();
                    this.updateStats();
                    this.showToast(`雲端同步失敗，已加載快取書籍 ${this.books.length} 本`, 'warning');
                    return;
                }
                this.showToast('Google Sheets 載入失敗，請稍後重新整理', 'warning');
                return;
            }

            if (!result || !result.ok) {
                console.log('Google Sheets 載入失敗:', result?.error || '未知錯誤');
                
                // 如果雲端失敗，嘗試從快取加載
                console.log('[快取策略] 雲端加載失敗，嘗試從快取加載');
                const cachedBooks = this.loadBookListCache();
                if (cachedBooks && cachedBooks.length > 0) {
                    this.books = cachedBooks;
                    this.borrowedBooks = JSON.parse(localStorage.getItem('lib_borrowed_v1') || '[]');
                    this.lastUpdateTime = new Date();
                    this.updateLastUpdateDisplay();
                    this.renderBooks();
                    this.renderBorrowedBooks();
                    this.updateStats();
                    this.showToast(`雲端同步失敗，已加載快取書籍 ${this.books.length} 本`, 'warning');
                    return;
                }
                
                this.showToast('Google Sheets 載入失敗，請稍後重新整理', 'warning');
                return;
            }

            const data = result.data || {};
            if (!Array.isArray(data.books)) {
                console.log('Google Sheets 資料格式不正確');
                
                // 如果雲端格式錯誤，嘗試從快取加載
                console.log('[快取策略] 雲端資料格式不正確，嘗試從快取加載');
                const cachedBooks = this.loadBookListCache();
                if (cachedBooks && cachedBooks.length > 0) {
                    this.books = cachedBooks;
                    this.borrowedBooks = JSON.parse(localStorage.getItem('lib_borrowed_v1') || '[]');
                    this.lastUpdateTime = new Date();
                    this.updateLastUpdateDisplay();
                    this.renderBooks();
                    this.renderBorrowedBooks();
                    this.updateStats();
                    this.showToast(`雲端資料格式錯誤，已加載快取書籍 ${this.books.length} 本`, 'warning');
                    return;
                }
                
                this.showToast('Google Sheets 資料格式錯誤，請檢查試算表欄位', 'warning');
                return;
            }

            this.reportRemoteBookLoad(data.books, { source: 'Google Sheets', silent: false });
            const applied = this.applyRemoteBookList([...(data.books || [])].reverse(), {
                source: 'Google Sheets',
                allowEmpty: false,
                allowLargeReduction: false,
                silent: true,
                baselineBooks: hadLocalBooks ? this.getLocalBookBaseline() : []
            });
            if (!applied) {
                const cachedBooks = this.loadBookListCache();
                if (cachedBooks && cachedBooks.length > 0) {
                    this.books = cachedBooks;
                    this.borrowedBooks = JSON.parse(localStorage.getItem('lib_borrowed_v1') || '[]');
                    this.lastUpdateTime = new Date();
                    this.updateLastUpdateDisplay();
                    this.renderBooks();
                    this.renderBorrowedBooks();
                    this.updateStats();
                    this.showToast(`雲端書單異常，已保留快取書籍 ${this.books.length} 本`, 'warning');
                    return;
                }

                this.showToast('雲端書單異常，已保留目前本機資料', 'warning');
                return;
            }

            this.setBorrowedBooksFromRemote(Array.isArray(data.borrowedBooks) ? data.borrowedBooks : []);

            // 處理博幼藏書
            const boyouBooks = data.boyouBooks || {};
            localStorage.setItem('lib_boyou_books_v1', JSON.stringify(boyouBooks));

            // 保存快取
            this.saveBookListCache(this.books, this.borrowedBooks);
            
            // 更新版本信息
            const remoteVersion = data.version || new Date().toISOString();
            this.updateBookListVersion(remoteVersion);

            this.saveData({ skipAutoSync: true });
            this.lastUpdateTime = new Date();
            this.updateLastUpdateDisplay();
            this.renderBooks();
            this.renderBorrowedBooks();
            this.updateStats();

            if (this.books.length > 0) {
                console.log(`成功從 Google Sheets 載入 ${this.books.length} 本書籍`);
                this.showToast(`已從 Google Sheets 載入 ${this.books.length} 本書籍`, 'success');
            } else {
                console.log('Google Sheets 中沒有書籍資料');
                this.showToast('Google Sheets 中沒有書籍資料', 'warning');
            }

        } catch (error) {
            console.error('自動從 Google Sheets 載入失敗:', error);
            
            // 如果出錯，嘗試從快取加載
            console.log('[快取策略] 自動載入失敗，嘗試從快取加載');
            const cachedBooks = this.loadBookListCache();
            if (cachedBooks && cachedBooks.length > 0) {
                this.books = cachedBooks;
                this.borrowedBooks = JSON.parse(localStorage.getItem('lib_borrowed_v1') || '[]');
                this.lastUpdateTime = new Date();
                this.updateLastUpdateDisplay();
                this.renderBooks();
                this.renderBorrowedBooks();
                this.updateStats();
                this.showToast(`同步失敗，已加載快取書籍 ${this.books.length} 本`, 'warning');
                return;
            }
            
            this.showToast('Google Sheets 載入失敗，請稍後重新整理', 'warning');
        }
    }

    // 自動載入 CSV 檔案
    async autoLoadCSV() {
        console.log('開始載入本地 CSV 檔案');
        try {
            // 顯示載入中狀態
            this.showLoadingIndicator(true);
            
            // 載入本地 CSV 檔案
            const response = await fetch('113博幼館藏.csv');
            if (!response.ok) {
                console.log('本地 CSV 檔案載入失敗');
                this.showLoadingIndicator(false);
                return;
            }

            const csvText = await response.text();
            const csvData = this.parseCSV(csvText);
            
            if (csvData.length > 0) {
                this.processCSVData(csvData);
                this.lastUpdateTime = new Date();
                this.updateLastUpdateDisplay();
                this.showToast(`已載入本地 CSV 資料 (${csvData.length} 筆)`, 'success');
            }
            
            this.showLoadingIndicator(false);
        } catch (error) {
            console.log('載入失敗:', error);
            this.showLoadingIndicator(false);
        }
    }

    /**
     * 重新整理書單 - 提供給普通用戶的快捷按鈕
     * 清除快取，強制從雲端重新下載最新書單
     * 不需要管理員權限
     */
    async refreshBookList() {
        try {
            this.showToast('正在重新整理書單...', 'info');
            this.showLoadingIndicator(true);
            
            console.log('[使用者操作] 重新整理書單 - 清除快取');
            // 清除快取，強制重新下載
            this.clearBookListCache();
            
            // 從雲端重新載入書單
            await this.autoLoadFromGoogleSheets();
            
            this.renderBooks();
            this.renderBorrowedBooks();
            this.updateStats();
            this.showLoadingIndicator(false);
            
            this.showToast('書單已重新整理', 'success');
        } catch (error) {
            console.error('重新整理書單失敗:', error);
            this.showLoadingIndicator(false);
            this.showToast('重新整理失敗，請檢查網路連線', 'error');
        }
    }

    // 解析 CSV 文字
    parseCSV(csvText) {
        console.log('開始解析 CSV 文字，長度:', csvText.length);
        const lines = csvText.split('\n');
        console.log('CSV 行數:', lines.length);
        const data = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            // 跳過標題行和空行
            if (i < 4) {
                console.log(`跳過第${i}行 (標題行):`, line);
                continue;
            }
            
            const columns = line.split(',');
            if (columns.length >= 2 && columns[0]) {
                console.log(`處理第${i}行:`, columns[0], columns[1]);
                data.push(columns);
            } else {
                console.log(`跳過第${i}行 (格式不符):`, line);
            }
        }
        
        console.log('CSV 解析完成，共', data.length, '筆有效資料');
        return data;
    }

    // 處理 CSV 資料
    processCSVData(csvData) {
        console.log('開始處理 CSV 資料，共', csvData.length, '筆');
        console.log('處理前書籍數量:', this.books.length);
        
        // 清空現有書籍資料，避免累積
        this.books = [];
        
        let successCount = 0;
        let errorCount = 0;
        const errors = [];
        const bookMap = new Map(); // 用於合併相同書名的書籍

        for (let i = 0; i < csvData.length; i++) {
            const row = csvData[i];
            if (!row || row.length === 0 || !row[0]) continue;

            const id = row[0].toString().trim();
            let title = row[1] ? row[1].toString().trim() : '';

            // 驗證書碼格式
            if (!/^[ABCD]\d+$/.test(id)) {
                errors.push(`第${i+5}行：書碼格式錯誤 (${id})`);
                errorCount++;
                continue;
            }

            // 如果書名為空，跳過此記錄
            if (!title) {
                console.log(`跳過第${i+5}行：書名為空 (${id})`);
                continue;
            }

            // 檢查重複書碼（在當前處理的資料中）
            if (bookMap.has(title) && bookMap.get(title).bookIds.includes(id)) {
                errors.push(`第${i+5}行：書碼重複 (${id})`);
                errorCount++;
                continue;
            }

            const genre = this.getGenreFromId(id);
            const year = this.settings.defaultYear;
            const copies = 1; // 預設冊數為 1

            // 檢查是否已存在相同書名的書籍
            if (bookMap.has(title)) {
                const existingBook = bookMap.get(title);
                existingBook.copies += copies;
                existingBook.availableCopies += copies;
                existingBook.bookIds.push(id); // 記錄所有書碼
            } else {
                const newBook = {
                    id, // 主要書碼
                    bookIds: [id], // 所有書碼列表
                    title,
                    genre,
                    year,
                    copies,
                    availableCopies: copies
                };
                bookMap.set(title, newBook);
            }
            successCount++;
        }

        // 將合併後的書籍添加到陣列中
        for (const book of bookMap.values()) {
            this.books.push(book);
        }

        console.log('處理完成，共載入', this.books.length, '本書籍');
        console.log('書籍列表:', this.books);

        this.saveData({ skipAutoSync: true });

        if (successCount > 0) {
            console.log(`成功載入 ${successCount} 本書籍`);
        }
        if (errorCount > 0) {
            console.log(`有 ${errorCount} 筆資料載入失敗`);
            console.log('載入錯誤:', errors);
        }
    }

    // 儲存資料
    saveData(options = {}) {
        const { skipAutoSync = false } = options;
        localStorage.setItem('lib_books_v1', JSON.stringify(this.books));
        localStorage.setItem('lib_borrowed_v1', JSON.stringify(this.borrowedBooks));
        localStorage.setItem('lib_users_v1', JSON.stringify(this.users));
        localStorage.setItem('lib_active_user_v1', JSON.stringify(this.currentUser));
        localStorage.setItem('lib_settings_v1', JSON.stringify(this.settings));
        
        // 不在 saveData 階段自動上傳，避免登入/初始化/下載流程把本機暫存資料直接覆蓋雲端
    }

    // 安全地從遠端資料設定借閱清單：避免遠端空陣列覆蓋本機已有資料
    setBorrowedBooksFromRemote(remoteBorrowed) {
        try {
            if (!Array.isArray(remoteBorrowed)) return;
            const localBorrowed = Array.isArray(this.borrowedBooks) && this.borrowedBooks.length > 0
                ? this.borrowedBooks
                : JSON.parse(localStorage.getItem('lib_borrowed_v1') || '[]');

            // 如果遠端沒有任何紀錄但本機已有資料，保留本機資料
            if (remoteBorrowed.length === 0) {
                if (Array.isArray(localBorrowed) && localBorrowed.length > 0) {
                    console.log('[borrow] 收到空的遠端借閱清單，保留本機借閱資料');
                    this.borrowedBooks = localBorrowed;
                    return;
                }
                this.borrowedBooks = [];
                return;
            }

            this.borrowedBooks = this.mergeBorrowedBooks(localBorrowed, remoteBorrowed);
        } catch (e) {
            console.error('setBorrowedBooksFromRemote error:', e);
        }
    }

    normalizeBorrowedRecord(record) {
        if (!record || typeof record !== 'object' || !record.id) return null;

        const returnedAt = String(record.returnedAt || '').trim();
        return {
            ...record,
            id: String(record.id),
            bookId: String(record.bookId || ''),
            bookTitle: String(record.bookTitle || ''),
            userId: String(record.userId || ''),
            borrowDate: record.borrowDate || '',
            dueDate: record.dueDate || '',
            returnedAt: returnedAt || null
        };
    }

    mergeBorrowedRecord(localRecord, remoteRecord) {
        const local = this.normalizeBorrowedRecord(localRecord);
        const remote = this.normalizeBorrowedRecord(remoteRecord);
        if (!local) return remote;
        if (!remote) return local;

        const localReturned = !!local.returnedAt;
        const remoteReturned = !!remote.returnedAt;
        const merged = { ...remote, ...local };

        if (localReturned || remoteReturned) {
            const localTime = localReturned ? new Date(local.returnedAt).getTime() : 0;
            const remoteTime = remoteReturned ? new Date(remote.returnedAt).getTime() : 0;
            merged.returnedAt = localTime >= remoteTime ? local.returnedAt : remote.returnedAt;
        } else {
            merged.returnedAt = null;
        }

        return merged;
    }

    mergeBorrowedBooks(localBorrowed, remoteBorrowed) {
        const map = new Map();

        (Array.isArray(remoteBorrowed) ? remoteBorrowed : []).forEach(record => {
            const normalized = this.normalizeBorrowedRecord(record);
            if (normalized) map.set(normalized.id, normalized);
        });

        (Array.isArray(localBorrowed) ? localBorrowed : []).forEach(record => {
            const normalized = this.normalizeBorrowedRecord(record);
            if (!normalized) return;
            map.set(normalized.id, this.mergeBorrowedRecord(normalized, map.get(normalized.id)));
        });

        return Array.from(map.values());
    }

    // 自動同步到 Google Sheets
    async autoSyncToGoogleSheets() {
        const url = this.getGoogleWebAppUrl();
        if (!url) {
            // 如果沒有設定 Google Sheets，靜默跳過
            return;
        }

        try {
            // 防止頻繁上傳，設定一個短暫的延遲
            if (this.autoSyncTimeout) {
                clearTimeout(this.autoSyncTimeout);
            }

            this.autoSyncTimeout = setTimeout(async () => {
                const boyouBooks = JSON.parse(localStorage.getItem('lib_boyou_books_v1') || 'null') || {};
                const response = await fetch(url, {
                    method: 'POST',
                    body: JSON.stringify({
                        action: 'push',
                        payload: {
                            books: this.books,
                            borrowedBooks: this.borrowedBooks,
                            boyouBooks
                        }
                    })
                });

                const result = await response.json().catch(() => null);
                if (response.ok && result && result.ok) {
                    console.log('自動同步到 Google Sheets 成功');
                    // 可以選擇性地顯示一個小圖標或訊息
                    this.showSyncIndicator('已同步', 'success');
                } else {
                    console.log('自動同步到 Google Sheets 失敗');
                }
            }, 1000); // 延遲1秒上傳，避免頻繁請求

        } catch (error) {
            console.error('自動同步到 Google Sheets 失敗:', error);
            // 靜默失敗，不影響本地操作
        }
    }

    // 顯示同步指示器
    showSyncIndicator(message, type = 'info') {
        // 創建或更新同步指示器
        let indicator = document.getElementById('sync-indicator');
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'sync-indicator';
            indicator.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                padding: 8px 16px;
                border-radius: 20px;
                font-size: 0.8rem;
                font-weight: 600;
                z-index: 10000;
                transition: all 0.3s ease;
                pointer-events: none;
            `;
            document.body.appendChild(indicator);
        }

        // 設置樣式和訊息
        if (type === 'success') {
            indicator.style.backgroundColor = '#48bb78';
            indicator.style.color = 'white';
        } else {
            indicator.style.backgroundColor = '#667eea';
            indicator.style.color = 'white';
        }
        
        indicator.textContent = message;
        indicator.style.opacity = '1';

        // 3秒後淡出
        setTimeout(() => {
            indicator.style.opacity = '0';
            setTimeout(() => {
                if (indicator.parentNode) {
                    indicator.parentNode.removeChild(indicator);
                }
            }, 300);
        }, 3000);
    }

    // 顯示登入模態框
    showLoginModal() {
        document.getElementById('login-modal').style.display = 'block';
    }

    showSelectionModal({ title, message, options }) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'modal';
            overlay.style.display = 'block';
            overlay.style.zIndex = '10001';

            const content = document.createElement('div');
            content.className = 'modal-content selection-modal-content';

            const closeBtn = document.createElement('span');
            closeBtn.className = 'close';
            closeBtn.innerHTML = '&times;';

            const h2 = document.createElement('h2');
            h2.textContent = title || '請選擇';
            h2.className = 'selection-modal-title';

            const p = document.createElement('p');
            p.textContent = message || '';
            p.className = 'selection-modal-message';

            const list = document.createElement('div');
            list.className = 'selection-modal-options';

            const safeOptions = Array.isArray(options) ? options : [];
            safeOptions.forEach((opt) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'selection-modal-option';
                btn.dataset.value = opt.value;

                const img = document.createElement('img');
                img.className = 'selection-option-image';
                img.src = opt.image || '';
                img.alt = opt.title || '';
                img.loading = 'lazy';
                // 如果沒有圖片，顯示預設圖標
                if (!opt.image) {
                    img.style.display = 'none';
                }

                const text = document.createElement('div');
                text.className = 'selection-option-text';
                text.innerHTML = `
                    <div class="selection-option-title">${opt.title || ''}</div>
                    <div class="selection-option-code">${opt.code || ''}</div>
                    <div class="selection-option-stock">可借 ${opt.available || 0} / ${opt.total || 1}</div>
                `;

                btn.appendChild(img);
                btn.appendChild(text);

                btn.addEventListener('click', () => {
                    cleanup();
                    resolve(opt.value);
                });
                list.appendChild(btn);
            });

            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'btn btn-outline selection-modal-cancel';
            cancelBtn.textContent = '取消';
            cancelBtn.addEventListener('click', () => {
                cleanup();
                resolve(null);
            });

            const cleanup = () => {
                document.removeEventListener('keydown', onKeyDown);
                overlay.removeEventListener('click', onOverlayClick);
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            };

            const onOverlayClick = (e) => {
                if (e.target === overlay) {
                    cleanup();
                    resolve(null);
                }
            };

            const onKeyDown = (e) => {
                if (e.key === 'Escape') {
                    cleanup();
                    resolve(null);
                }
            };

            closeBtn.addEventListener('click', () => {
                cleanup();
                resolve(null);
            });

            overlay.addEventListener('click', onOverlayClick);
            document.addEventListener('keydown', onKeyDown);

            content.appendChild(closeBtn);
            content.appendChild(h2);
            if (p.textContent) content.appendChild(p);
            content.appendChild(list);
            content.appendChild(cancelBtn);
            overlay.appendChild(content);
            document.body.appendChild(overlay);
        });
    }

    getBookSourceItems(book) {
        if (!book) return [];
        if (Array.isArray(book.mergedBooks) && book.mergedBooks.length) return book.mergedBooks;
        if (Array.isArray(book.bookIds) && book.bookIds.length) {
            const items = book.bookIds
                .map(id => this.books.find(item => item.id === id))
                .filter(Boolean);
            return items.length ? items : [book];
        }
        return [book];
    }

    collectBookIdsFromBooks(books = []) {
        const ids = new Set();
        (books || []).forEach(book => {
            if (!book) return;
            if (book.id) ids.add(String(book.id).toUpperCase().trim());
            if (Array.isArray(book.bookIds)) {
                book.bookIds.forEach(id => {
                    if (id) ids.add(String(id).toUpperCase().trim());
                });
            }
        });
        return ids;
    }

    collectBookTitlesByIdFromBooks(books = []) {
        const titlesById = new Map();
        (books || []).forEach(book => {
            if (!book) return;
            const title = String(book.title || book.name || '').trim();
            const ids = [];
            if (book.id) ids.push(book.id);
            if (Array.isArray(book.bookIds)) ids.push(...book.bookIds);

            ids.forEach(rawId => {
                const id = String(rawId || '').toUpperCase().trim();
                if (id && title && !titlesById.has(id)) {
                    titlesById.set(id, title);
                }
            });
        });
        return titlesById;
    }

    hydrateRemoteBookIdCacheFromBooks(books = []) {
        const sourceBooks = Array.isArray(books) ? books : [];
        if (sourceBooks.length === 0) return;

        const ids = this.collectBookIdsFromBooks(sourceBooks);
        const titlesById = this.collectBookTitlesByIdFromBooks(sourceBooks);
        if (ids.size === 0) return;

        this.remoteBookIdCache.ids = ids;
        this.remoteBookIdCache.titlesById = titlesById;
        this.remoteBookIdCache.fetchedAt = Date.now();
    }

    async refreshRemoteBookIdCache({ silent = true, force = false } = {}) {
        const url = this.getGoogleWebAppUrl();
        if (!url) {
            this.hydrateRemoteBookIdCacheFromBooks(this.books);
            return this.remoteBookIdCache.ids;
        }

        const now = Date.now();
        if (!force && this.remoteBookIdCache.fetchedAt && now - this.remoteBookIdCache.fetchedAt < 5 * 60000) {
            return this.remoteBookIdCache.ids;
        }

        if (this.remoteBookIdCache.inFlight) {
            return this.remoteBookIdCache.inFlight;
        }

        this.hydrateRemoteBookIdCacheFromBooks(this.books);

        this.remoteBookIdCache.inFlight = this.callGoogleApi(url, { action: 'pullBookIds' }, 'GET')
            .catch(error => {
                console.warn('pullBookIds failed, falling back to pull:', error?.message || error);
                return this.callGoogleApi(url, { action: 'pull' }, 'GET');
            })
            .then(result => {
                if (!result?.ok || !Array.isArray(result?.data?.books)) {
                    throw new Error(result?.error || '無法讀取 Google Sheet 書碼');
                }
                this.remoteBookIdCache.ids = this.collectBookIdsFromBooks(result.data.books);
                this.remoteBookIdCache.titlesById = this.collectBookTitlesByIdFromBooks(result.data.books);
                this.remoteBookIdCache.fetchedAt = Date.now();
                if (!silent) {
                    this.showToast(`已讀取 Google Sheet 書碼：${this.remoteBookIdCache.ids.size} 筆`, 'success');
                }
                return this.remoteBookIdCache.ids;
            })
            .catch(error => {
                console.warn('refreshRemoteBookIdCache error:', error);
                if (!silent) this.showToast(`讀取 Google Sheet 書碼失敗：${error?.message || error}`, 'warning');
                return this.remoteBookIdCache.ids;
            })
            .finally(() => {
                this.remoteBookIdCache.inFlight = null;
            });

        return this.remoteBookIdCache.inFlight;
    }

    getBookStock(book) {
        const sourceItems = this.getBookSourceItems(book);
        const ids = [...new Set(sourceItems.map(item => item.id).filter(Boolean))];
        const total = sourceItems.reduce((sum, item) => sum + (Number(item.copies) || 1), 0) || 1;
        const borrowed = this.borrowedBooks.filter(record =>
            ids.includes(record.bookId) &&
            !record.returnedAt
        ).length;
        return {
            ids,
            total,
            borrowed,
            available: Math.max(0, total - borrowed)
        };
    }

    getSingleBookStock(book) {
        if (!book) return { total: 0, borrowed: 0, available: 0 };
        const total = Number(book.copies) || 1;
        const borrowed = this.borrowedBooks.filter(record =>
            record.bookId === book.id &&
            !record.returnedAt
        ).length;
        return {
            total,
            borrowed,
            available: Math.max(0, total - borrowed)
        };
    }

    getActiveBorrowRecordForBook(book) {
        if (!book || !this.currentUser) return null;
        const stock = this.getBookStock(book);
        return this.borrowedBooks.find(record =>
            stock.ids.includes(record.bookId) &&
            record.userId === this.currentUser.username &&
            !record.returnedAt
        ) || null;
    }

    findDisplayBookById(bookId) {
        const allDisplayBooks = this.mergeBooksByTitle(this.books || []);
        return allDisplayBooks.find(book =>
            book.id === bookId ||
            (Array.isArray(book.bookIds) && book.bookIds.includes(bookId)) ||
            (Array.isArray(book.mergedBooks) && book.mergedBooks.some(item => item.id === bookId))
        ) || this.books.find(book => book.id === bookId) || null;
    }

    showBookQuickPanel(bookId) {
        const book = this.findDisplayBookById(bookId);
        if (!book) {
            this.showToast('找不到書籍資料', 'error');
            return;
        }

        const stock = this.getBookStock(book);
        const availableCopies = stock.available;
        const totalCopies = stock.total;
        const genre = book.genre || this.getGenreFromId(book.id) || '未分類';
        const ids = stock.ids.length ? stock.ids : [book.id];
        const userBorrowRecord = this.getActiveBorrowRecordForBook(book);
        const canBorrow = !!this.currentUser && availableCopies > 0;
        const title = book.title || '書籍資訊';
        const coverUrl = book.coverUrl || book.coverImage || '';
        const bookUrl = String(book.bookUrl || '').trim();
        const coverHtml = this.isAllowedCoverUrl(coverUrl)
            ? `<img src="${this.escapeHtml(coverUrl)}" alt="${this.escapeHtml(title)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
               <div class="book-quick-cover-placeholder" style="display:none;"><i class="fas fa-book"></i></div>`
            : `<div class="book-quick-cover-placeholder"><i class="fas fa-book"></i></div>`;
        const volume = (book.volume || '').trim();
        const description = String(book.description || '').trim();
        const series = this.getDisplaySeriesName(book);
        const actionButton = userBorrowRecord
            ? `<button class="btn btn-warning book-quick-action" onclick="library.returnBook('${this.escapeHtml(userBorrowRecord.id)}')"><i class="fas fa-undo"></i> 歸還</button>`
            : `<button class="btn btn-primary book-quick-action" ${canBorrow ? '' : 'disabled'} onclick="library.borrowBook('${this.escapeHtml(book.id)}')"><i class="fas fa-book-reader"></i> ${canBorrow ? '借閱' : '已借完'}</button>`;

        const overlay = document.createElement('div');
        overlay.className = 'modal book-quick-modal';
        overlay.style.display = 'block';
        overlay.innerHTML = `
            <div class="modal-content book-quick-content">
                <button type="button" class="book-quick-close" aria-label="關閉">&times;</button>
                <div class="book-quick-layout">
                    <div class="book-quick-cover">
                        ${coverHtml}
                    </div>
                    <div class="book-quick-body">
                        <h2>${this.escapeHtml(title)}</h2>
                        <div class="book-quick-tags">
                            <span><i class="fas fa-tag"></i> ${this.escapeHtml(genre)}</span>
                            <span><i class="fas fa-copy"></i> 可借 ${availableCopies}/${totalCopies} 本</span>
                        </div>
                        <div class="book-quick-info">
                            <div><i class="fas fa-barcode"></i><span>書碼</span><strong>${this.escapeHtml(ids.join('、'))}</strong></div>
                            ${series !== '單本書' ? `<div><i class="fas fa-layer-group"></i><span>系列</span><strong>${this.escapeHtml(series)}</strong></div>` : ''}
                            ${volume ? `<div><i class="fas fa-hashtag"></i><span>集數</span><strong>${this.escapeHtml(volume)}</strong></div>` : ''}
                            ${book.author ? `<div><i class="fas fa-pen-nib"></i><span>作者</span><strong>${this.escapeHtml(book.author)}</strong></div>` : ''}
                            ${book.year ? `<div><i class="fas fa-calendar"></i><span>年份</span><strong>${this.escapeHtml(book.year)}年</strong></div>` : ''}
                            ${bookUrl ? `<div><i class="fas fa-link"></i><span>網址</span><strong><a class="book-quick-url" href="${this.escapeHtml(bookUrl)}" target="_blank" rel="noopener noreferrer">開啟書籍網址</a></strong></div>` : ''}
                        </div>
                        ${description ? `<div class="book-quick-description"><strong>書籍大綱</strong><p>${this.escapeHtml(description)}</p></div>` : ''}
                    </div>
                </div>
                <div class="book-quick-actions">
                    ${actionButton}
                </div>
            </div>
        `;

        const close = () => overlay.remove();
        overlay.querySelector('.book-quick-close')?.addEventListener('click', close);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close();
        });
        document.body.appendChild(overlay);
    }

    // 處理登入
    handleLogin(e) {
        e.preventDefault();
        const usernameEl = document.getElementById('username');
        const roleEl = document.getElementById('user-role');

        if (!usernameEl) {
            this.showToast('登入表單缺少使用者名稱欄位（#username）', 'error');
            return;
        }

        const username = usernameEl.value;
        const role = roleEl ? roleEl.value : 'student';

        if (!username.trim()) {
            this.showToast('請輸入使用者名稱', 'error');
            return;
        }

        // 檢查是否為副管理者
        const subAdmin = this.settings.subAdmins?.find(sa => sa.username === username);
        if (subAdmin) {
            this.currentUser = { username, role: 'subadmin' };
        } else if (username === this.adminUsername) {
            this.currentUser = { username, role: 'admin' };
        } else {
            this.currentUser = { username, role };
        }

        this.saveData({ skipAutoSync: true });
        this.updateUserDisplay();
        this.updateAdminControls();
        if (!this.hasAdminAccess()) {
            this.stopAutoUpdate();
        } else {
            this.startAutoUpdate();
        }
        this.renderBooks();
        this.renderBorrowedBooks();

        document.getElementById('login-modal').style.display = 'none';
        document.getElementById('login-form').reset();
        this.showToast(`歡迎 ${username}！`, 'success');
    }

    // 登出
    logout() {
        this.currentUser = null;
        this.saveData({ skipAutoSync: true });
        this.updateUserDisplay();
        this.updateAdminControls();
        this.stopAutoUpdate();
        this.renderBooks();
        this.renderBorrowedBooks();
        this.showToast('已登出', 'success');
    }

    // 更新使用者顯示
    updateUserDisplay() {
        const currentUserSpans = document.querySelectorAll('.user-display-name, #current-user, .toolbar-user-name');
        const loginBtn = document.getElementById('login-btn');
        const logoutBtn = document.getElementById('logout-btn');

        if (this.currentUser) {
            const roleLabel = this.isAdminUser()
                ? '<i class="fas fa-crown"></i>'
                : this.isSubAdminUser()
                    ? '管理員'
                    : this.getRoleName(this.currentUser.role || 'student');
            const readingLevel = this.getUserReadingLevel(this.currentUser.username);
            const roleBadgeHtml = this.hasAdminAccess()
                ? `<span class="user-role-badge">${roleLabel}</span>`
                : '';
            currentUserSpans.forEach(span => {
                span.innerHTML = `
                    ${this.escapeHtml(this.currentUser.username)}
                    ${roleBadgeHtml}
                    <span class="user-level-badge" title="累積借閱 ${readingLevel.count} 次">${readingLevel.label}</span>
                `;
                span.classList.toggle('is-admin-user', this.hasAdminAccess());
                span.classList.toggle('is-normal-user', !this.hasAdminAccess());
            });
            loginBtn.style.display = 'none';
            logoutBtn.style.display = 'inline-flex';
        } else {
            currentUserSpans.forEach(span => {
                span.innerHTML = '訪客';
                span.classList.remove('is-admin-user');
                span.classList.add('is-normal-user');
            });
            loginBtn.style.display = 'inline-flex';
            logoutBtn.style.display = 'none';
        }
    }

    getUserBorrowCount(username) {
        const target = String(username || '').trim();
        if (!target) return 0;
        return this.borrowedBooks.filter(record => record && record.userId === target).length;
    }

    getUserReadingLevel(username) {
        const count = this.getUserBorrowCount(username);
        if (count >= 100) return { count, label: `Lv.5 ${count}次` };
        if (count >= 50) return { count, label: `Lv.4 ${count}次` };
        if (count >= 20) return { count, label: `Lv.3 ${count}次` };
        if (count >= 5) return { count, label: `Lv.2 ${count}次` };
        return { count, label: `Lv.1 ${count}次` };
    }

    // 取得角色名稱
    getRoleName(role) {
        const roleNames = {
            'guest': '訪客',
            'student': '學生',
            'staff': '老師/館員'
        };
        return roleNames[role] || '未知';
    }

    // 顯示新增書籍模態框
    async showAddBookModal() {
        if (!this.requireAdmin('新增館藏')) return;
        document.getElementById('add-book-modal').style.display = 'block';

        // 設定預設值
        document.getElementById('book-year').value = this.settings.defaultYear;
        document.getElementById('book-copies').value = this.settings.defaultCopies;

        // 清空表單
        document.getElementById('add-book-form').reset();

        // 重新設定預設值（因為reset會清空）
        document.getElementById('book-year').value = this.settings.defaultYear;
        document.getElementById('book-copies').value = this.settings.defaultCopies;
        const authorInput = document.getElementById('book-author');
        if (authorInput) authorInput.value = '';

        // 預填下一個書碼（仍可手動修改）：先讀 Google Sheet 書碼，避免產生雲端已存在的號碼
        await this.refreshRemoteBookIdCache({ silent: true, force: false });
        const suggestedId = this.suggestNextBookId();
        const bookIdInput = document.getElementById('book-id');
        const bookPrefixSelect = document.getElementById('book-prefix');

        if (bookPrefixSelect) {
            const m = String(suggestedId || '').toUpperCase().match(/^([ABCD])/);
            bookPrefixSelect.value = m ? m[1] : 'C';
        }
        if (bookIdInput && suggestedId) {
            bookIdInput.value = suggestedId;
        }

        if (suggestedId) {
            this.showToast(`已預填書碼 ${suggestedId}，可從此號開始編輯（可自行修改）`, 'info');
        }
        this.updateBookIdNavButtons();
        this.checkBookIdAvailability(suggestedId);
        
        // 聚焦到書碼輸入框
        setTimeout(() => {
            document.getElementById('book-id').focus();
            if (document.getElementById('book-id')?.value) {
                document.getElementById('book-id').select();
            }
        }, 100);
        
        // 添加實時驗證
        this.setupAddBookValidation();
    }

    // 複製新增書籍
    copyBook(bookId) {
        if (!this.requireAdmin('複製新增書籍')) return;

        // 查找書籍
        const book = this.books.find(b => b.id === bookId);
        if (!book) {
            this.showToast('找不到指定的書籍', 'error');
            return;
        }

        // 開啟新增書籍模態框
        this.showAddBookModal();

        // 填入書籍資料
        setTimeout(() => {
            const form = document.getElementById('add-book-form');
            if (!form) return;

            // 保留的欄位
            if (document.getElementById('book-title')) {
                document.getElementById('book-title').value = book.title || '';
            }
            if (document.getElementById('book-author')) {
                document.getElementById('book-author').value = book.author || '';
            }
            if (document.getElementById('book-genre')) {
                document.getElementById('book-genre').value = book.genre || '';
            }
            if (document.getElementById('book-year')) {
                document.getElementById('book-year').value = book.year || this.settings.defaultYear;
            }
            if (document.getElementById('book-publisher')) {
                document.getElementById('book-publisher').value = book.publisher || '';
            }
            if (document.getElementById('book-description')) {
                document.getElementById('book-description').value = book.description || '';
            }
            if (document.getElementById('book-cover-url')) {
                document.getElementById('book-cover-url').value = book.coverUrl || book.coverImage || '';
            }

            // 清空或重新產生的欄位
            const suggestedId = this.suggestNextBookId();
            const bookIdInput = document.getElementById('book-id');
            const bookPrefixSelect = document.getElementById('book-prefix');

            if (bookPrefixSelect) {
                const m = String(suggestedId || '').toUpperCase().match(/^([ABCD])/);
                bookPrefixSelect.value = m ? m[1] : 'C';
            }
            if (bookIdInput && suggestedId) {
                bookIdInput.value = suggestedId;
            }

            // 設定預設值
            if (document.getElementById('book-copies')) {
                document.getElementById('book-copies').value = '1';
            }

            // 清空借閱相關欄位
            if (document.getElementById('book-borrower-name')) {
                document.getElementById('book-borrower-name').value = '';
            }
            if (document.getElementById('book-borrow-date')) {
                document.getElementById('book-borrow-date').value = '';
            }
            if (document.getElementById('book-due-date')) {
                document.getElementById('book-due-date').value = '';
            }
            if (document.getElementById('book-note')) {
                document.getElementById('book-note').value = '';
            }

            this.showToast(`已複製「${book.title}」的資料，請確認後儲存`, 'info');
        }, 100);
    }

    suggestNextBookId() {
        const genreFilter = document.getElementById('genre-filter')?.value;
        const prefixMap = { '繪本': 'A', '漫畫': 'A', '橋梁書': 'B', '文字書': 'C', '雜誌': 'D' };
        const prefix = prefixMap[genreFilter] || 'C';
        return this.generateNextBookId(prefix);
    }

    fillNextBookId() {
        this.fillAdjacentBookId('next');
    }

    getUsedBookNumbers(prefix, options = {}) {
        const normalizedPrefix = String(prefix || '').toUpperCase().trim();
        const { source = 'local' } = options;
        const used = new Set();
        let maxWidth = 4;

        const addIds = (ids) => {
            ids.forEach(rawId => {
                const idStr = String(rawId || '').toUpperCase().trim();
                const match = idStr.match(/^([ABCD])(\d+)$/);
                if (!match || match[1] !== normalizedPrefix) return;
                const numPart = match[2];
                const num = parseInt(numPart, 10);
                if (!Number.isFinite(num)) return;
                used.add(num);
                if (numPart.length > maxWidth) maxWidth = numPart.length;
            });
        };

        if (source === 'local' || source === 'both') {
            (this.books || []).forEach(book => {
                const ids = [];
                if (book?.id) ids.push(book.id);
                if (Array.isArray(book?.bookIds)) ids.push(...book.bookIds);
                addIds(ids);
            });
        }

        if ((source === 'google' || source === 'both') && this.remoteBookIdCache?.ids instanceof Set) {
            addIds(Array.from(this.remoteBookIdCache.ids));
        }

        return { used, maxWidth };
    }

    getBookIdCursor() {
        const bookIdInput = document.getElementById('book-id');
        const bookPrefixSelect = document.getElementById('book-prefix');
        const currentId = String(bookIdInput?.value || '').trim().toUpperCase();
        const match = currentId.match(/^([ABCD])(\d+)?$/);
        const currentPrefix = match?.[1];
        const currentNumber = match?.[2] ? parseInt(match[2], 10) : 0;
        const selectedPrefix = String(bookPrefixSelect?.value || '').toUpperCase().trim();
        const prefix = currentPrefix || selectedPrefix || 'C';
        return { prefix, currentNumber: Number.isFinite(currentNumber) ? currentNumber : 0 };
    }

    findAdjacentAvailableBookId(direction = 'next') {
        const { prefix, currentNumber } = this.getBookIdCursor();
        if (!/^[ABCD]$/.test(prefix)) return null;

        const { used, maxWidth } = this.getUsedBookNumbers(prefix, { source: 'both' });
        if (direction === 'prev') {
            for (let i = Math.max(1, currentNumber - 1); i >= 1; i--) {
                if (!used.has(i)) return `${prefix}${String(i).padStart(maxWidth, '0')}`;
            }
            return null;
        }

        let i = Math.max(0, currentNumber) + 1;
        while (used.has(i)) i++;
        return `${prefix}${String(i).padStart(maxWidth, '0')}`;
    }

    fillAdjacentBookId(direction = 'next') {
        const bookIdInput = document.getElementById('book-id');
        const bookPrefixSelect = document.getElementById('book-prefix');
        const bookGenreManual = document.getElementById('book-genre-manual');
        const nextId = this.findAdjacentAvailableBookId(direction);

        if (!nextId || !bookIdInput) {
            if (direction === 'prev') this.updateBookIdNavButtons(true);
            this.showToast(direction === 'prev' ? '前面沒有可用書碼了' : '無法產生下一個書碼', direction === 'prev' ? 'info' : 'error');
            return;
        }

        const prefix = nextId.match(/^([ABCD])/)?.[1] || 'C';
        bookIdInput.value = nextId;
        if (bookPrefixSelect) bookPrefixSelect.value = prefix;
        const selectedGenre = bookPrefixSelect?.selectedOptions?.[0]?.dataset?.genre;
        const fallbackGenre = selectedGenre || this.getGenreFromId(prefix);
        if (bookGenreManual && fallbackGenre && fallbackGenre !== '未知') {
            bookGenreManual.value = fallbackGenre;
        }
        bookIdInput.focus();
        bookIdInput.select();
        this.hideFieldError?.('book-id');
        this.updateBookIdNavButtons();
        this.checkBookIdAvailability(nextId);
        this.showToast(`已填入${direction === 'prev' ? '上一個' : '下一個'}可用書碼：${nextId}`, 'success');
    }

    async fillAdjacentBookIdFromGoogle(direction = 'next') {
        await this.refreshRemoteBookIdCache({ silent: true, force: false });
        this.fillAdjacentBookId(direction);
    }

    updateBookIdNavButtons(forcePrevDisabled = false) {
        const prevBookIdBtn = document.getElementById('prev-book-id-btn');
        if (!prevBookIdBtn) return;
        prevBookIdBtn.disabled = forcePrevDisabled || !this.findAdjacentAvailableBookId('prev');
    }

    generateNextBookId(prefix) {
        const normalizedPrefix = String(prefix || '').toUpperCase().trim();
        if (!/^[ABCD]$/.test(normalizedPrefix)) return null;

        const { used: usedNumbers, maxWidth } = this.getUsedBookNumbers(normalizedPrefix, { source: 'both' });

        // 先補前面被刪除的空號，再往後新增
        let i = 1;
        while (true) {
            const candidate = `${normalizedPrefix}${String(i).padStart(maxWidth, '0')}`;
            if (!usedNumbers.has(i)) {
                return candidate;
            }
            i++;
        }
    }

    hasBookId(id) {
        const target = String(id || '').trim().toUpperCase();
        if (!target) return false;

        return this.books.some(book => {
            if (!book) return false;
            if (String(book.id || '').toUpperCase() === target) return true;
            if (Array.isArray(book.bookIds) && book.bookIds.some(x => String(x || '').toUpperCase() === target)) return true;
            return false;
        });
    }

    hasGoogleSheetBookId(id) {
        const target = String(id || '').trim().toUpperCase();
        if (!target || !(this.remoteBookIdCache?.ids instanceof Set)) return false;
        return this.remoteBookIdCache.ids.has(target);
    }

    getGoogleSheetBookTitleById(id) {
        const target = String(id || '').trim().toUpperCase();
        if (!target || !(this.remoteBookIdCache?.titlesById instanceof Map)) return '';
        return this.remoteBookIdCache.titlesById.get(target) || '';
    }

    getGoogleSheetBookIdExistsMessage(id) {
        const target = String(id || '').trim().toUpperCase();
        const title = this.getGoogleSheetBookTitleById(target);
        return title
            ? `Google Sheet 已有這個書碼：${target}（${title}）`
            : `Google Sheet 已有這個書碼：${target}`;
    }

    checkBookIdAvailability(bookId) {
        const id = String(bookId || '').trim().toUpperCase();
        const statusEl = document.getElementById('book-id-status');

        if (!id) {
            if (statusEl) {
                statusEl.className = 'book-id-status';
                statusEl.textContent = '';
            }
            this.hideFieldError?.('book-id');
            return;
        }

        // 檢查書碼格式
        if (!/^[ABCD]\d+$/.test(id)) {
            if (statusEl) {
                statusEl.className = 'book-id-status show invalid';
                statusEl.innerHTML = '<i class="fas fa-exclamation-circle"></i> 書碼格式不正確';
            }
            this.showFieldError?.('book-id', '書碼格式：A/B/C/D + 數字');
            return;
        }

        if (this.hasGoogleSheetBookId(id)) {
            const message = this.getGoogleSheetBookIdExistsMessage(id);
            if (statusEl) {
                statusEl.className = 'book-id-status show unavailable';
                statusEl.innerHTML = `<i class="fas fa-times-circle"></i> ${this.escapeHtml(message)}`;
            }
            this.showFieldError?.('book-id', message);
            return;
        }

        // 書碼可用
        if (statusEl) {
            statusEl.className = 'book-id-status show available';
            statusEl.innerHTML = '<i class="fas fa-check-circle"></i> 書碼可用';
        }
        this.hideFieldError?.('book-id');
    }

    findMissingBookIds() {
        const prefixGroups = { A: new Set(), B: new Set(), C: new Set(), D: new Set() };

        const googleSheetIds = this.remoteBookIdCache?.ids instanceof Set
            ? Array.from(this.remoteBookIdCache.ids)
            : [];

        googleSheetIds.forEach(rawId => {
            const id = String(rawId || '').toUpperCase().trim();
            const match = id.match(/^([ABCD])(\d+)$/);
            if (!match) return;
            const prefix = match[1];
            const num = parseInt(match[2], 10);
            if (Number.isFinite(num) && prefixGroups[prefix]) {
                prefixGroups[prefix].add(num);
            }
        });

        // 找出每個類別的缺失書碼
        const missing = {};
        for (const prefix of ['A', 'B', 'C', 'D']) {
            const existing = prefixGroups[prefix];
            const missingIds = [];
            const maxNum = Math.max(...existing, 0);

            // 從 1 開始檢查到最大編號
            for (let i = 1; i <= maxNum; i++) {
                if (!existing.has(i)) {
                    missingIds.push(i);
                }
            }

            if (missingIds.length > 0) {
                missing[prefix] = {
                    count: missingIds.length,
                    ids: missingIds.slice(0, 20).map(n => `${prefix}${String(n).padStart(4, '0')}`),
                    hasMore: missingIds.length > 20
                };
            }
        }

        return missing;
    }

    async showMissingBookIds() {
        await this.refreshRemoteBookIdCache({ silent: true, force: false });
        const missing = this.findMissingBookIds();
        let message = '缺失的書碼：\n\n';

        for (const prefix of ['A', 'B', 'C', 'D']) {
            if (missing[prefix]) {
                message += `${prefix} 類別：共 ${missing[prefix].count} 個缺失\n`;
                message += `前 20 個：${missing[prefix].ids.join(', ')}\n`;
                if (missing[prefix].hasMore) {
                    message += `... 還有 ${missing[prefix].count - 20} 個\n`;
                }
                message += '\n';
            } else {
                message += `${prefix} 類別：無缺失（完整）\n\n`;
            }
        }

        console.log(message);
        alert(message);
    }

    // 根據書名查找相同書籍
    findBookByTitle(title) {
        if (!title || typeof title !== 'string') return null;
        
        const normalizedTitle = this.getBookTitleKey(title);
        
        // 尋找第一個匹配的書籍（忽略大小寫和前後空白）
        return this.books.find(book => {
            if (!book || !book.title) return false;
            return this.getBookTitleKey(book.title) === normalizedTitle;
        });
    }

    findSameTitleDifferentPrefix(title, targetId, excludeId = '') {
        const titleKey = this.getBookTitleKey(title);
        const targetPrefix = this.normalizeBookIdText(targetId).charAt(0);
        const excluded = this.normalizeBookIdText(excludeId);
        if (!titleKey || !/^[ABCD]$/.test(targetPrefix)) return [];

        return (this.books || []).filter(book => {
            const bookId = this.normalizeBookIdText(book?.id || '');
            if (!bookId || bookId === excluded) return false;
            if (this.getBookTitleKey(book?.title || '') !== titleKey) return false;
            const bookPrefix = bookId.charAt(0);
            return /^[ABCD]$/.test(bookPrefix) && bookPrefix !== targetPrefix;
        });
    }

    confirmSameTitleDifferentPrefix(title, targetId, excludeId = '') {
        const conflicts = this.findSameTitleDifferentPrefix(title, targetId, excludeId);
        if (conflicts.length === 0) return true;

        const currentPrefix = this.normalizeBookIdText(targetId).charAt(0);
        const preview = conflicts.slice(0, 5)
            .map(book => `${book.id}（${book.genre || this.getGenreFromId(book.id)}）`)
            .join('、');
        const more = conflicts.length > 5 ? `，另有 ${conflicts.length - 5} 本` : '';

        return confirm(
            `提醒：Google Sheet/目前書庫已有相同書名，但分類字母不同。\n\n` +
            `書名：${title}\n` +
            `你現在要用：${currentPrefix} 類\n` +
            `已存在：${preview}${more}\n\n` +
            `確定仍要使用不同分類嗎？`
        );
    }

    showSameTitleDifferentPrefixHint({ titleFieldId, idFieldId, excludeId = '' }) {
        const title = this.normalizeBookTitle(document.getElementById(titleFieldId)?.value || '');
        const id = this.normalizeBookIdText(document.getElementById(idFieldId)?.value || '');
        if (!title || !this.bookIdPattern.test(id)) return false;

        const conflicts = this.findSameTitleDifferentPrefix(title, id, excludeId);
        if (conflicts.length === 0) return false;

        const preview = conflicts.slice(0, 3)
            .map(book => `${book.id}（${book.genre || this.getGenreFromId(book.id)}）`)
            .join('、');
        const more = conflicts.length > 3 ? `，另有 ${conflicts.length - 3} 本` : '';
        const message = `提醒：同書名已有不同分類：${preview}${more}`;

        if (titleFieldId === 'book-title') {
            this.showFieldError('book-title', message);
        } else {
            const errorDiv = document.getElementById('edit-book-id-error');
            if (errorDiv) {
                errorDiv.textContent = message;
                errorDiv.style.display = 'block';
                errorDiv.style.color = '#f59e0b';
            }
        }
        return true;
    }

    // 測試書籍編號生成邏輯
    testBookIdGeneration() {
        console.log('=== 測試書籍編號生成邏輯 ===');
        
        // 測試 C 前綴
        const cResult = this.generateNextBookId('C');
        console.log(`C 前綴測試結果: ${cResult}`);
        
        // 測試 A 前綴
        const aResult = this.generateNextBookId('A');
        console.log(`A 前綴測試結果: ${aResult}`);
        
        // 測試 B 前綴
        const bResult = this.generateNextBookId('B');
        console.log(`B 前綴測試結果: ${bResult}`);
        
        // 測試不存在的 D 前綴
        const dResult = this.generateNextBookId('D');
        console.log(`D 前綴測試結果: ${dResult}`);
        
        // 顯示結果給用戶
        const results = `
            測試結果：
            C 前綴: ${cResult}
            A 前綴: ${aResult}
            B 前綴: ${bResult}
            D 前綴: ${dResult}
        `;
        
        this.showToast(results, 'info', 5000);
        
        return { cResult, aResult, bResult, dResult };
    }

    // 處理新增書籍
    async handleAddBook(e) {
        e.preventDefault();

        try {
            const idEl = document.getElementById('book-id');
            const titleEl = document.getElementById('book-title');
            const authorEl = document.getElementById('book-author');
            const coverEl = document.getElementById('book-cover-url');
            const bookUrlEl = document.getElementById('book-url');
            const yearEl = document.getElementById('book-year');
            const copiesEl = document.getElementById('book-copies');

            if (!idEl || !titleEl || !yearEl || !copiesEl) {
                this.showToast('新增失敗：表單欄位不存在，請重新整理頁面', 'error');
                return;
            }

            let id = idEl.value.trim().toUpperCase();
            await this.refreshRemoteBookIdCache({ silent: true, force: false });

            if (!id) {
                const prefix = String(document.getElementById('book-prefix')?.value || 'C').toUpperCase().trim();
                id = this.generateNextBookId(prefix) || '';
                idEl.value = id;
            }
            const title = this.normalizeBookTitle(titleEl.value);
            if (titleEl.value !== title) titleEl.value = title;
            let author = (authorEl?.value || '').trim();
            let coverUrl = (coverEl?.value || '').trim();
            let bookUrl = (bookUrlEl?.value || '').trim();
            let year = parseInt(yearEl.value) || this.settings.defaultYear;
            const copies = parseInt(copiesEl.value) || this.settings.defaultCopies;

            // 驗證書碼格式（支援全形和半形字符）
            if (!/^[ABCD]\d+$/.test(id)) {
                this.showToast('書碼格式錯誤：請用 A/B/C/D + 數字（例：D0001）', 'error');
                return;
            }

            // 書碼是否已存在只以 Google Sheet 為準
            if (this.hasGoogleSheetBookId(id)) {
                this.showToast(this.getGoogleSheetBookIdExistsMessage(id), 'error', 8000);
                return;
            }

            if (!title) {
                this.showToast('請輸入書名', 'error');
                return;
            }

            if (!this.confirmSameTitleDifferentPrefix(title, id)) {
                this.showToast('已取消新增，請確認書名或書碼分類', 'info');
                return;
            }

            // 檢查是否有相同書名的書籍，如果有則自動套用資料
            const existingBook = this.findBookByTitle(title);
            if (existingBook) {
                // 自動套用重複書籍的資料
                if (!author && existingBook.author) {
                    author = existingBook.author;
                    if (authorEl) authorEl.value = author;
                }
                if (!coverUrl && existingBook.coverUrl) {
                    coverUrl = existingBook.coverUrl;
                    if (coverEl) coverEl.value = coverUrl;
                }
                if (!bookUrl && existingBook.bookUrl) {
                    bookUrl = existingBook.bookUrl;
                    if (bookUrlEl) bookUrlEl.value = bookUrl;
                }
                if (year === this.settings.defaultYear && existingBook.year) {
                    year = existingBook.year;
                    if (yearEl) yearEl.value = year;
                }

                this.showToast(`偵測到相同書名，已自動套用書籍資料`, 'info');
            }

            // 讀取使用者輸入的系列書名稱
            const seriesEl = document.getElementById('book-series');
            const seriesName = (seriesEl?.value || '').trim();

            const manualGenre = (document.getElementById('book-genre-manual')?.value || '').trim();
            const genre = manualGenre || this.getGenreFromId(id);
            const newBook = {
                id,
                title,
                author,
                coverUrl,
                bookUrl,
                genre,
                year,
                copies,
                availableCopies: copies,
                isNew: true,
                addedAt: Date.now(),
                updatedAt: Date.now(),
                createdAt: new Date().toISOString()
            };

            // 如果使用者輸入了系列書名稱，就保存到書籍對象
            if (seriesName) {
                newBook.series = seriesName;
            }

            // 如果使用者輸入了書籍網址，就保存到書籍對象
            if (bookUrl) {
                newBook.bookUrl = bookUrl;
            }

            this.books.push(newBook);

            // 如果有輸入作者，自動套用到相同書名的其他書籍
            if (author) {
                const sameTitleBooks = this.books.filter(b => b.title === title && b.id !== id);
                if (sameTitleBooks.length > 0) {
                    sameTitleBooks.forEach(sameBook => {
                        sameBook.author = author;
                    });
                    this.showToast(`已自動套用作者到 ${sameTitleBooks.length} 本相同書名的書籍`, 'info');
                }
            }

            // 如果有輸入系列書名稱，自動套用到相同書名的其他書籍
            if (seriesName) {
                const sameTitleBooks = this.books.filter(b => b.title === title && b.id !== id);
                if (sameTitleBooks.length > 0) {
                    sameTitleBooks.forEach(sameBook => {
                        sameBook.series = seriesName;
                    });
                    this.showToast(`已自動套用套書名稱到 ${sameTitleBooks.length} 本相同書名的書籍`, 'info');
                }
            }

            this.saveData({ skipAutoSync: true });
            // 新增館藏後也自動同步到 Google Sheets
            this.triggerSyncForAction('addBook');
            
            // 更新書單版本，讓快取失效
            this.updateBookListVersion();
            
            this.renderBooks();
            this.updateStats();

            const modal = document.getElementById('add-book-modal');
            if (modal) modal.style.display = 'none';
            const form = document.getElementById('add-book-form');
            if (form) form.reset();

            this.showToast('書籍新增成功！', 'success');
        } catch (err) {
            console.error('handleAddBook error:', err);
            this.showToast(`新增失敗：${err?.message || err}`, 'error');
        }
    }

    // 設定新增書籍表單的實時驗證
    setupAddBookValidation() {
        const bookIdInput = document.getElementById('book-id');
        const bookTitleInput = document.getElementById('book-title');
        const bookPrefixSelect = document.getElementById('book-prefix');

        if (!bookIdInput || !bookTitleInput) return;

        // 書碼格式驗證
        if (!bookIdInput.dataset.bound) {
            bookIdInput.dataset.bound = '1';
            bookIdInput.addEventListener('input', async (e) => {
            const value = e.target.value.trim();
            const upper = value.toUpperCase();

            if (bookPrefixSelect) {
                const m = String(e.target.value || '').toUpperCase().match(/^([ABCD])/);
                if (m) bookPrefixSelect.value = m[1];
            }

            const currentValue = e.target.value.trim().toUpperCase();
            const isValid = /^[ABCD]\d+$/.test(currentValue);
            
            if (!currentValue) {
                e.target.style.borderColor = '#e2e8f0';
                this.hideFieldError('book-id');
                return;
            }

            if (currentValue && !isValid) {
                e.target.style.borderColor = '#f56565';
                this.showFieldError('book-id', '書碼格式：A/B/C/D + 數字');
            } else {
                e.target.style.borderColor = '#e2e8f0';
                this.hideFieldError('book-id');
            }

            if (!this.remoteBookIdCache.fetchedAt) {
                await this.refreshRemoteBookIdCache({ silent: true, force: false });
            }
            if (/^[ABCD]\d+$/.test(currentValue) && this.hasGoogleSheetBookId(currentValue)) {
                e.target.style.borderColor = '#f56565';
                this.showFieldError('book-id', this.getGoogleSheetBookIdExistsMessage(currentValue));
                return;
            }
            if (this.showSameTitleDifferentPrefixHint({
                titleFieldId: 'book-title',
                idFieldId: 'book-id'
            })) {
                e.target.style.borderColor = '#f59e0b';
            }
            });
        }
        
        // 書名驗證與重複檢查
        if (!bookTitleInput.dataset.bound) {
            bookTitleInput.dataset.bound = '1';
            bookTitleInput.addEventListener('input', (e) => {
            const value = e.target.value.trim();
            
            if (value.length === 0) {
                e.target.style.borderColor = '#f56565';
                this.showFieldError('book-title', '請輸入書名');
            } else {
                e.target.style.borderColor = '#e2e8f0';
                this.hideFieldError('book-title');
                
                // 檢查是否有相同書名的書籍
                const existingBook = this.findBookByTitle(value);
                this.showSameTitleDifferentPrefixHint({
                    titleFieldId: 'book-title',
                    idFieldId: 'book-id'
                });
                if (existingBook) {
                    // 顯示找到相同書籍的提示
                    this.showFieldError('book-title', `找到相同書名，將自動套用作者、出版年份和封面資料`);
                    
                    // 自動填入作者（如果作者欄位為空）
                    const authorEl = document.getElementById('book-author');
                    if (authorEl && (!authorEl.value.trim() || authorEl.value.trim() === '')) {
                        authorEl.value = existingBook.author || '';
                    }
                    
                    // 自動填入出版年份（如果年份欄位為預設值）
                    const yearEl = document.getElementById('book-year');
                    if (yearEl && (!yearEl.value || parseInt(yearEl.value) === this.settings.defaultYear)) {
                        yearEl.value = existingBook.year || this.settings.defaultYear;
                    }
                    
                    // 自動填入封面網址（如果封面欄位為空）
                    const coverEl = document.getElementById('book-cover-url');
                    if (coverEl && (!coverEl.value.trim() || coverEl.value.trim() === '')) {
                        coverEl.value = existingBook.coverUrl || '';
                    }
                } else {
                    // 清除重複書籍提示
                    const errorDiv = bookTitleInput.parentNode.querySelector('.field-error');
                    if (errorDiv && errorDiv.textContent.includes('找到相同書名')) {
                        this.hideFieldError('book-title');
                    }
                }
            }
            });
        }
    }

    // 顯示欄位錯誤提示
    showFieldError(fieldId, message) {
        const field = document.getElementById(fieldId);
        if (!field) return;

        const container = fieldId === 'book-id'
            ? field.closest('.form-group')
            : field.parentNode;
        let errorDiv = container.querySelector('.field-error');
        
        if (!errorDiv) {
            errorDiv = document.createElement('div');
            errorDiv.className = 'field-error';
            if (fieldId === 'book-id') {
                field.closest('.input-with-button')?.insertAdjacentElement('afterend', errorDiv);
            } else {
                container.appendChild(errorDiv);
            }
        }
        
        errorDiv.textContent = message;
        errorDiv.style.color = '#f56565';
        errorDiv.style.fontSize = '0.8rem';
        errorDiv.style.marginTop = '5px';
    }

    // 隱藏欄位錯誤提示
    hideFieldError(fieldId) {
        const field = document.getElementById(fieldId);
        if (!field) return;
        const container = fieldId === 'book-id'
            ? field.closest('.form-group')
            : field.parentNode;
        const errorDiv = container.querySelector('.field-error');
        
        if (errorDiv) {
            errorDiv.remove();
        }
    }

    // 從書碼取得類別
    getGenreFromId(id) {
        const firstChar = id.charAt(0).toUpperCase();
        const genreMap = {
            'A': '繪本',
            'B': '橋梁書',
            'C': '文字書',
            'D': '雜誌'
        };
        return genreMap[firstChar] || '未知';
    }

    normalizeBookIdText(value) {
        return String(value || '')
            .trim()
            .replace(/[Ａａ]/g, 'A')
            .replace(/[Ｂｂ]/g, 'B')
            .replace(/[Ｃｃ]/g, 'C')
            .replace(/[Ｄｄ]/g, 'D')
            .toUpperCase();
    }

    normalizeBookTitle(value) {
        let title = String(value || '').trim();
        if (!title) return '';

        title = title
            .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
            .replace(/\u3000/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/[﹕∶:]/g, '：')
            .replace(/[;；]/g, '；')
            .replace(/[,，]/g, '，')
            .replace(/[?？]/g, '？')
            .replace(/[!！]/g, '！')
            .replace(/([\u3400-\u9fffA-Za-z0-9）】》])\s*[-－–—]\s*([\u3400-\u9fffA-Za-z0-9（【《])/g, '$1：$2')
            .replace(/^(.+[0-9０-９]{1,3})\s+([^\s].+)$/u, '$1：$2')
            .replace(/\s*：\s*/g, '：')
            .replace(/\s*，\s*/g, '，')
            .replace(/\s*；\s*/g, '；')
            .replace(/\s*？\s*/g, '？')
            .replace(/\s*！\s*/g, '！')
            .replace(/[「『]\s*/g, '《')
            .replace(/\s*[」』]/g, '》')
            .replace(/[\[\(（]\s*/g, '（')
            .replace(/\s*[\]\)）]/g, '）')
            .replace(/\s*-\s*/g, '-')
            .replace(/\s+/g, ' ')
            .trim();

        return title;
    }

    getBookTitleKey(value) {
        return this.normalizeBookTitle(value)
            .toLowerCase()
            .replace(/[《》「」『』（）()[\]\s:：,，;；.。．\-—_~～]/g, '');
    }

    getBookTitleFormatGuide() {
        return '固定格式：主書名：副標題（系列/集數）。例：神奇樹屋：恐龍谷大冒險（第1集）';
    }

    getBookTitleFormatIssues(books = this.books) {
        return (Array.isArray(books) ? books : [])
            .map(book => {
                const original = String(book?.title || '').trim();
                const fixed = this.normalizeBookTitle(original);
                return {
                    id: String(book?.id || '').trim(),
                    original,
                    fixed
                };
            })
            .filter(item => item.original && item.fixed && item.original !== item.fixed);
    }

    async showBookTitleFormatCheck() {
        if (!this.requireAdmin('檢查書名格式')) return;

        await this.pullFromGoogleSheets({ silent: true, protectEmpty: true, closeModal: false });
        const issues = this.getBookTitleFormatIssues(this.books);

        if (issues.length === 0) {
            alert(`${this.getBookTitleFormatGuide()}\n\n目前 Google Sheet 書名格式看起來都一致。`);
            return;
        }

        const preview = issues.slice(0, 30).map((item, index) => {
            const code = item.id ? `${item.id} ` : '';
            return `${index + 1}. ${code}${item.original}\n   建議：${item.fixed}`;
        }).join('\n\n');
        const more = issues.length > 30 ? `\n\n還有 ${issues.length - 30} 筆未顯示。` : '';

        alert(`${this.getBookTitleFormatGuide()}\n\n需要整理的書名共 ${issues.length} 筆：\n\n${preview}${more}`);
    }

    // 智能書名排序：讓相似書名聚集在一起
    smartTitleSort(titleA, titleB, sortOrder) {
        // 提取書名的主要部分（去除數字、括號等）
        const cleanTitleA = this.cleanTitle(titleA);
        const cleanTitleB = this.cleanTitle(titleB);
        
        // 先按清理後的書名排序
        const cleanCompare = cleanTitleA.localeCompare(cleanTitleB, 'zh-TW');
        
        if (cleanCompare !== 0) {
            return sortOrder === 'asc' ? cleanCompare : -cleanCompare;
        }
        
        // 如果清理後的書名相同，則按完整書名排序
        const fullCompare = titleA.localeCompare(titleB, 'zh-TW');
        return sortOrder === 'asc' ? fullCompare : -fullCompare;
    }

    // 清理書名：移除數字、括號等，保留主要書名
    cleanTitle(title) {
        // 移除常見的後綴模式
        return title
            .replace(/[（(].*?[）)]/g, '') // 移除括號內容
            .replace(/\d+.*$/g, '') // 移除末尾的數字
            .replace(/[第].*?[卷冊部集]/g, '') // 移除第X卷/冊/部/集
            .replace(/[上下中].*$/g, '') // 移除上/下/中
            .replace(/[全].*$/g, '') // 移除全
            .replace(/[一二三四五六七八九十百千萬]+/g, '') // 移除中文數字
            .replace(/[IVXLC]+/g, '') // 移除羅馬數字
            .trim();
    }

    getSeriesKey(title) {
        const s = String(title || '')
            .replace(/[（(【\[].*?[）)】\]]/g, ' ')
            .replace(/第\s*[0-9０-９一二三四五六七八九十百千萬IVXLCivxlc]+\s*[卷冊部集篇回話章]/g, ' ')
            .replace(/\b(?:vol|volume)\.?\s*[0-9０-９]+\b/gi, ' ')
            .replace(/[0-9０-９]+\s*[卷冊部集篇回話章]/g, ' ')
            .replace(/\b[IVXLC]+\b/gi, ' ')
            .replace(/\b[0-9０-９]+\b/g, ' ')
            .replace(/[一二三四五六七八九十百千萬]+/g, ' ')
            .replace(/\b(上|中|下|前|後|續|終|全)\b/g, ' ')
            .replace(/[：:，,。．·・\-—_~～]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        return s;
    }

    // 排序書籍，讓同系列書籍排在一起
    sortBooksWithSeries(books, sortOrder = 'asc') {
        // 為每本書添加清理後的書名和系列標記
        const booksWithSeriesInfo = books.map(book => ({
            ...book,
            cleanTitle: this.cleanTitle(book.title),
            seriesKey: this.getSeriesKey(book.title),
            hasSeriesMarkers: /[（(].*?[）)]|\d+.*$|[第].*?[卷冊部集]|[上下中].*$|[全].*$/.test(book.title)
        }));
        
        // 按系列分組
        const seriesMap = new Map();
        const standaloneBooks = [];
        
        booksWithSeriesInfo.forEach(book => {
            const key = (book.seriesKey || '').trim();
            const groupKey = key.length >= 2 ? key : '';

            if (groupKey) {
                if (!seriesMap.has(groupKey)) {
                    seriesMap.set(groupKey, []);
                }
                seriesMap.get(groupKey).push(book);
            } else {
                standaloneBooks.push(book);
            }
        });
        
        const sortedBooks = [];
        
        // 處理系列書籍（至少2本才算系列）
        seriesMap.forEach((seriesBooks, seriesName) => {
            if (seriesBooks.length >= 2) {
                // 系列內書籍排序：嘗試把系列「第一本」放在最前面
                // 1) 若書名含數字（例如卷/冊/號），依數字升冪排序（1、2、3...），
                // 2) 否則若有 createdAt（或 addedAt）欄位，依時間升冪排序（較早的在前），
                // 3) 最後退回到書名排序
                seriesBooks.sort((a, b) => {
                    // 嘗試從書名擷取數字索引
                    const extractIndex = (title) => {
                        if (!title) return NaN;
                        const m = String(title).match(/(\d{1,4})/);
                        if (m) return parseInt(m[1], 10);
                        return NaN;
                    };

                    const aIdx = extractIndex(a.title);
                    const bIdx = extractIndex(b.title);
                    if (!Number.isNaN(aIdx) && !Number.isNaN(bIdx)) {
                        if (aIdx !== bIdx) return aIdx - bIdx; // 升冪，第一冊 (1) 在前
                    }

                    // 若無明確數字索引，使用 createdAt/addedAt 升冪（較早的視為第一本）
                    const aTime = new Date(a.createdAt || a.addedAt || 0).getTime();
                    const bTime = new Date(b.createdAt || b.addedAt || 0).getTime();
                    if (aTime && bTime && aTime !== bTime) {
                        return aTime - bTime; // 較早的在前
                    }

                    // 最後依書名排序
                    return this.smartTitleSort(a.title, b.title, sortOrder);
                });
                sortedBooks.push(...seriesBooks);
            } else {
                // 單本書籍加入獨立書籍
                standaloneBooks.push(...seriesBooks);
            }
        });

        // 獨立書籍排序：優先考慮新書，然後按書名排序
        standaloneBooks.sort((a, b) => {
            // 優先處理新書：最近新增的書籍放在最前面
            const aAddedAt = Number(a.addedAt) || 0;
            const bAddedAt = Number(b.addedAt) || 0;
            const aIsNew = !!a.isNew && aAddedAt > 0;
            const bIsNew = !!b.isNew && bAddedAt > 0;
            
            // 如果其中一本是新書，按 addedAt 降序排列（最新的在前）
            if (aIsNew || bIsNew) {
                if (aIsNew && !bIsNew) return -1; // a 是新書，排在前面
                if (!aIsNew && bIsNew) return 1;  // b 是新書，排在前面
                // 兩本都是新書，按 addedAt 降序排列
                return bAddedAt - aAddedAt;
            }
            
            // 如果都不是新書，或者 addedAt 相同，則按書名排序
            return this.smartTitleSort(a.title, b.title, sortOrder);
        });
        
        sortedBooks.push(...standaloneBooks);
        
        return sortedBooks;
    }

    // 匯入書籍
    importBooks(event) {
        if (!this.requireAdmin('匯入 Excel 書單')) return;
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const sheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[sheetName];
                const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

                this.processImportData(jsonData);
            } catch (error) {
                this.showToast('檔案格式錯誤', 'error');
                console.error('Import error:', error);
            }
        };
        reader.readAsArrayBuffer(file);
    }

    // 處理匯入資料
    processImportData(data) {
        let successCount = 0;
        let errorCount = 0;
        const errors = [];

        // 跳過標題行，從第二行開始處理
        for (let i = 1; i < data.length; i++) {
            const row = data[i];
            if (!row || row.length === 0 || !row[0]) continue;

            const id = row[0].toString().trim();
            const title = row[1] ? row[1].toString().trim() : '';
            const copies = row[2] ? parseInt(row[2]) : this.settings.defaultCopies;

            // 驗證書碼格式
            if (!/^[ABCD]\d+$/.test(id)) {
                errors.push(`第${i+1}行：書碼格式錯誤 (${id})`);
                errorCount++;
                continue;
            }

            // 檢查重複書碼
            if (this.books.find(book => book.id === id)) {
                errors.push(`第${i+1}行：書碼重複 (${id})`);
                errorCount++;
                continue;
            }

            if (!title) {
                errors.push(`第${i+1}行：缺少書名`);
                errorCount++;
                continue;
            }

            const genre = this.getGenreFromId(id);
            const year = this.settings.defaultYear;

            const now = Date.now();
            const newBook = {
                id,
                title,
                genre,
                year,
                copies: copies || this.settings.defaultCopies,
                availableCopies: copies || this.settings.defaultCopies,
                isNew: true,
                addedAt: now,
                updatedAt: now,
                createdAt: new Date(now).toISOString()
            };

            this.books.push(newBook);
            successCount++;
        }

        this.saveData();
        this.renderBooks();
        this.updateStats();

        if (successCount > 0) {
            this.showToast(`成功匯入 ${successCount} 本書籍`, 'success');
        }
        if (errorCount > 0) {
            this.showToast(`有 ${errorCount} 筆資料匯入失敗`, 'warning');
            console.log('Import errors:', errors);
        }
    }

    // 借閱書籍
    async borrowBook(bookId) {
        console.log('借閱按鈕被點擊，書碼:', bookId);
        console.log('當前使用者:', this.currentUser);
        
        if (!this.currentUser) {
            this.showToast('請先登入', 'error');
            return;
        }

        const clickedBook = this.books.find(b => b.id === bookId);
        if (!clickedBook) {
            this.showToast('書籍不存在', 'error');
            return;
        }

        // 若同書名存在多筆（合併顯示/多個書碼），讓使用者選擇要借哪個書碼
        const normalizedTitle = this.normalizeTitle(clickedBook.title);
        const sameTitleBooks = this.books.filter(b => this.normalizeTitle(b.title) === normalizedTitle);

        let selectedBook = clickedBook;
        if (sameTitleBooks.length > 1) {
            const availableCandidates = sameTitleBooks
                .map(b => ({
                    book: b,
                    available: this.getBookStock(b).available,
                    total: this.getBookStock(b).total
                }))
                .filter(x => x.available > 0);

            if (availableCandidates.length === 0) {
                this.showToast('此書籍已全部借出', 'error');
                return;
            }

            const choice = await this.showSelectionModal({
                title: '選擇要借閱的書碼',
                message: '此書名有多個書碼，請點選要借閱的號碼',
                options: availableCandidates.map(x => ({
                    value: x.book.id,
                    image: x.book.coverUrl || '',
                    title: x.book.title,
                    code: x.book.id,
                    available: x.available,
                    total: x.total
                }))
            });

            if (!choice) return;
            const picked = availableCandidates.find(x => x.book.id === choice);
            if (!picked) {
                this.showToast('選擇的借閱號碼無效', 'error');
                return;
            }
            selectedBook = picked.book;
        }

        const book = selectedBook;

        const selectedStock = this.getBookStock(book);
        if (selectedStock.available <= 0) {
            this.showToast('此書籍已全部借出', 'error');
            return;
        }

        // 允許同一使用者借多本（若館藏有多本），但最多不超過該書總冊數
        const userBorrowedCount = this.borrowedBooks.filter(
            b => b.bookId === book.id && b.userId === this.currentUser.username && !b.returnedAt
        ).length;

        if (userBorrowedCount >= (book.copies || 1)) {
            this.showToast('您已借滿此書所有冊數', 'error');
            return;
        }

        // 若此書碼有多冊，讓借閱人選擇要借第幾冊
        let copyNo = null;
        const totalCopies = selectedStock.total;
        if (totalCopies > 1) {
            const usedCopyNos = new Set(
                this.borrowedBooks
                    .filter(b => b.bookId === book.id && !b.returnedAt && Number.isFinite(Number(b.copyNo)))
                    .map(b => Number(b.copyNo))
            );

            const availableCopyNos = [];
            for (let i = 1; i <= totalCopies; i++) {
                if (!usedCopyNos.has(i)) availableCopyNos.push(i);
            }

            if (availableCopyNos.length === 0) {
                this.showToast('此書籍已全部借出', 'error');
                return;
            }

            if (availableCopyNos.length === 1) {
                copyNo = availableCopyNos[0];
            } else {
                const chosen = await this.showSelectionModal({
                    title: '選擇要借閱的冊號',
                    message: '此書有多冊，請點選要借閱的冊號',
                    options: availableCopyNos.map(n => ({
                        value: n,
                        image: book.coverUrl || '',
                        title: book.title,
                        code: `${book.id} - 第 ${n} 冊`,
                        available: 1,
                        total: totalCopies
                    }))
                });

                if (chosen === null) return;
                if (!availableCopyNos.includes(Number(chosen))) {
                    this.showToast('選擇的冊號無效', 'error');
                    return;
                }
                copyNo = Number(chosen);
            }
        }

        const borrowDate = new Date();
        const loanDays = this.getLoanDaysForUser(this.currentUser.username);
        const dueDate = new Date(borrowDate.getTime() + loanDays * 24 * 60 * 60 * 1000);

        const borrowRecord = {
            id: Date.now().toString(),
            bookId: book.id,
            bookTitle: book.title,
            userId: this.currentUser.username,
            borrowDate: borrowDate.toISOString(),
            dueDate: dueDate.toISOString(),
            loanDays,
            copyNo,
            returnedAt: null
        };

        this.borrowedBooks.push(borrowRecord);
        book.availableCopies--;

        this.saveData();
        // 借閱不觸發館藏同步（僅保留本機變更）
        this.triggerSyncForAction('borrow');
        this.renderBooks();
        this.renderBorrowedBooks();
        this.updateStats();
        this.showToast('借閱成功！', 'success');
    }

    // 歸還書籍
    returnBook(borrowId) {
        const borrowRecord = this.borrowedBooks.find(b => b.id === borrowId);
        if (!borrowRecord) {
            this.showToast('借閱記錄不存在', 'error');
            return;
        }

        if (borrowRecord.returnedAt) {
            this.showToast('此書籍已歸還', 'error');
            return;
        }

        borrowRecord.returnedAt = new Date().toISOString();

        const book = this.books.find(b => b.id === borrowRecord.bookId);
        if (book) {
            book.availableCopies++;
        }

        this.saveData();
        // 歸還不觸發館藏同步
        this.triggerSyncForAction('return');
        this.renderBooks();
        this.renderBorrowedBooks();
        this.updateStats();
        this.showToast('歸還成功！', 'success');
    }

    // 判斷封面網址是否允許（避免熱鏈被擋的網域導致錯誤）
    isAllowedCoverUrl(url) {
        if (!url || typeof url !== 'string') return false;
        try {
            const u = new URL(url);
            const blockedHosts = new Set([
                'tse1.mm.bing.net',
                'tse2.mm.bing.net',
                'tse3.mm.bing.net',
                'tse4.mm.bing.net',
                'tse1.explicit.bing.net',
                'tshop.r10s.com',
                'system.chc.edu.tw'
            ]);
            return !blockedHosts.has(u.hostname);
        } catch (_) {
            return false;
        }
    }

    // 渲染書籍列表
    renderBooks() {
        console.log('開始渲染書籍，當前書籍數量:', this.books.length);
        const gridContainer = document.getElementById('gridView');
        const listContainer = document.getElementById('listView');
        const rawSearchTerm = document.getElementById('search-input')?.value || '';
        const normalizedSearchTerm = (rawSearchTerm || '').trim();
        const searchTerm = normalizedSearchTerm.toLowerCase();
        const genreFilter = document.getElementById('genre-filter').value;
        const sortBy = document.getElementById('sort-by').value;
        const sortOrder = document.getElementById('sort-order').value;

        if (!this.virtualScrollState) {
            this.virtualScrollState = { batchSize: 48 };
        }
        this.virtualScrollState.batchSize = 48;
        this.currentPage = Math.max(1, Number(this.currentPage) || 1);

        // 書碼精準搜尋：支援多個書碼（逗號/空白分隔）
        const codeTokens = (normalizedSearchTerm || '')
            .toUpperCase()
            .split(/[\s,，]+/)
            .map(s => s.trim())
            .filter(Boolean);
        const isCodeSearch = codeTokens.length > 0 && codeTokens.every(t => /^[ABCD]\d+$/.test(t));

        let filteredBooks = this.books.filter(book => {
            let matchesSearch;

            if (!searchTerm) {
                matchesSearch = true;
            } else if (isCodeSearch) {
                const mainId = String(book.id || '').toUpperCase();
                const allIds = Array.isArray(book.bookIds)
                    ? book.bookIds.map(id => String(id || '').toUpperCase())
                    : [];
                matchesSearch = codeTokens.some(code => code === mainId || allIds.includes(code));
            } else {
                matchesSearch =
                    String(book.title || '').toLowerCase().includes(searchTerm) ||
                    String(book.author || '').toLowerCase().includes(searchTerm) ||
                    String(book.id || '').toLowerCase().includes(searchTerm) ||
                    (book.bookIds && book.bookIds.some(id => String(id || '').toLowerCase().includes(searchTerm))) ||
                    String(book.year ?? '').toLowerCase().includes(searchTerm) ||
                    String(book.genre || '').toLowerCase().includes(searchTerm);
            }
            
            const matchesGenre = !genreFilter || this.matchesBookGenre(book, genreFilter);
            
            return matchesSearch && matchesGenre;
        });

        // 注意：排序要在「合併」後再套用，避免合併後順序被打亂

        if (filteredBooks.length === 0) {
            const emptyStateHtml = `
                <div class="empty-state">
                    <i class="fas fa-book-open"></i>
                    <h3>沒有找到書籍</h3>
                    <p>請嘗試調整搜尋條件或新增書籍</p>
                    <div class="empty-state-actions">
                        <button class="btn btn-primary" onclick="library.searchBookInfo('${searchTerm}')">
                            <i class="fas fa-search"></i> 搜尋書籍資訊
                        </button>
                        ${this.isAdminUser() ? `
                        <button class="btn btn-info" onclick="library.showAddBookModal()">
                            <i class="fas fa-plus"></i> 新增書籍
                        </button>` : ''}
                    </div>
                </div>
            `;
            if (gridContainer) gridContainer.innerHTML = emptyStateHtml;
            if (listContainer) listContainer.innerHTML = emptyStateHtml;
            return;
        }

        // 合併相同書名的書籍
        const mergedBooks = this.mergeBooksByTitle(filteredBooks);

        // 合併後排序
        mergedBooks.sort((a, b) => {
            // 優先按 createdAt 降序排列（最新的在前）
            const timeA = new Date(a.createdAt || a.addedAt || 0).getTime();
            const timeB = new Date(b.createdAt || b.addedAt || 0).getTime();
            if (timeA !== timeB) {
                return timeB - timeA;
            }

            // 如果 createdAt 相同，則按原來的排序邏輯
            if (sortBy === 'code') {
                const aCode = String(a.id || '').toUpperCase();
                const bCode = String(b.id || '').toUpperCase();
                const aMatch = aCode.match(/^([ABCD])(\d+)$/);
                const bMatch = bCode.match(/^([ABCD])(\d+)$/);

                if (aMatch && bMatch) {
                    const [, aLetter, aNumStr] = aMatch;
                    const [, bLetter, bNumStr] = bMatch;

                    if (aLetter !== bLetter) {
                        return sortOrder === 'asc'
                            ? aLetter.localeCompare(bLetter)
                            : bLetter.localeCompare(aLetter);
                    }

                    const aNum = parseInt(aNumStr, 10);
                    const bNum = parseInt(bNumStr, 10);
                    if (!isNaN(aNum) && !isNaN(bNum)) {
                        return sortOrder === 'asc' ? aNum - bNum : bNum - aNum;
                    }
                    return sortOrder === 'asc'
                        ? aNumStr.localeCompare(bNumStr)
                        : bNumStr.localeCompare(aNumStr);
                }

                return sortOrder === 'asc'
                    ? aCode.localeCompare(bCode)
                    : bCode.localeCompare(aCode);
            }

            // 其他排序方式：首先按類別分組
            const genreOrder = ['繪本', '漫畫', '橋梁書', '文字書', '雜誌'];
            const aGenreIndex = genreOrder.indexOf(a.genre);
            const bGenreIndex = genreOrder.indexOf(b.genre);
            if (aGenreIndex !== bGenreIndex) {
                return aGenreIndex - bGenreIndex;
            }

            // 然後按主要排序條件排序
            let aVal = a[sortBy];
            let bVal = b[sortBy];
            if (sortBy === 'year') {
                aVal = parseInt(aVal);
                bVal = parseInt(bVal);
            } else if (sortBy === 'title') {
                return this.smartTitleSort(a.title, b.title, sortOrder);
            } else {
                aVal = aVal.toString().toLowerCase();
                bVal = bVal.toString().toLowerCase();
            }

            if (sortOrder === 'asc') {
                return aVal > bVal ? 1 : -1;
            }
            return aVal < bVal ? 1 : -1;
        });

        // 所有排序方式都做系列分組，讓同一系列的書整理在一起
        const sortedBooks = this.sortBooksWithSeries(mergedBooks, sortOrder);
        const recentBooks = sortedBooks
            .filter(book => this.isRecentlyUpdatedBook(book))
            .sort((a, b) => this.compareFreshBooks(a, b));
        const recentBookIds = new Set(recentBooks.map(book => book.id));
        const regularSortedBooks = sortedBooks.filter(book => !recentBookIds.has(book.id));
        this.scheduleNewBookPinRefresh(sortedBooks);

        // 按系列分組顯示
        const groupedBooks = this.groupBooksBySeries(regularSortedBooks);
        const seriesNames = Object.keys(groupedBooks);

        // 分成系列書和單本書兩個區塊
        // 邏輯：
        // 1. 如果書籍有顯式 series 屬性，顯示為系列書
        // 2. 如果書籍沒有 series 屬性，顯示為單本書
        const seriesBooks = [];
        const standaloneBooks = [];

        seriesNames.forEach(seriesName => {
            const seriesBooksList = groupedBooks[seriesName];

            // 如果系列名稱是「單本書」，則全部歸類為單本書
            if (seriesName === '單本書') {
                standaloneBooks.push(...seriesBooksList);
            } else {
                // 有 series 屬性的書歸類為系列書
                seriesBooks.push({ seriesName, books: seriesBooksList });
            }
        });

        seriesBooks.sort((a, b) => a.seriesName.localeCompare(b.seriesName, 'zh-TW'));
        seriesBooks.forEach(group => {
            group.books.sort((a, b) => this.smartTitleSort(a.title, b.title, 'asc'));
        });

        // 生成 HTML
        let html = '';
        this.seriesModalData = {};

        if (recentBooks.length > 0) {
            html += `
                <section class="recent-books-section">
                    <div class="recent-books-header">
                        <h3><i class="fas fa-thumbtack"></i> 新增書籍</h3>
                        <span>上方固定 10 分鐘｜${recentBooks.length} 本</span>
                    </div>
                    <div class="books-grid recent-books-grid">
                        ${recentBooks.map(book => this.createBookCard(book)).join('')}
                    </div>
                </section>
            `;
        }

        const hasActiveSearch = !!normalizedSearchTerm;

        // 搜尋時同時顯示系列書與單本書，不被目前分頁限制
        if (hasActiveSearch) {
            if (seriesBooks.length > 0) {
                html += `
                    <section class="search-result-section">
                        <div class="search-result-header">
                            <h3><i class="fas fa-layer-group"></i> 系列書結果</h3>
                            <span>${seriesBooks.length} 組</span>
                        </div>
                        ${seriesBooks.map((seriesGroup, index) => this.createSeriesSectionHtml(seriesGroup, index)).join('')}
                    </section>
                `;
            }

            if (standaloneBooks.length > 0) {
                html += `
                    <section class="search-result-section">
                        <div class="search-result-header">
                            <h3><i class="fas fa-book"></i> 單本書結果</h3>
                            <span>${standaloneBooks.length} 本</span>
                        </div>
                        <div class="books-grid">
                            ${standaloneBooks.map(book => {
                                const originalIndex = this.books.findIndex(b => b.id === book.id);
                                const isLegacy = originalIndex >= 0 && originalIndex < 1493;
                                return this.createBookCard(book, isLegacy);
                            }).join('')}
                        </div>
                    </section>
                `;
            }

            if (seriesBooks.length === 0 && standaloneBooks.length === 0) {
                html += '<div class="empty-state"><i class="fas fa-search"></i><h3>沒有找到書籍</h3><p>請嘗試調整搜尋條件</p></div>';
            }
        } else if (this.currentBookType === 'series') {
            // 系列書區塊
            if (seriesBooks.length > 0) {
                const pageSize = this.virtualScrollState.batchSize;
                const totalPages = Math.max(1, Math.ceil(seriesBooks.length / pageSize));
                if (this.currentPage > totalPages) this.currentPage = totalPages;
                const startIndex = (this.currentPage - 1) * pageSize;
                const seriesToRender = seriesBooks.slice(startIndex, startIndex + pageSize);
                html += seriesToRender.map((seriesGroup, index) => this.createSeriesSectionHtml(seriesGroup, index)).join('');
                html += this.createPaginationHtml(seriesBooks.length, '組');
            } else {
                html += '<div class="empty-state"><i class="fas fa-layer-group"></i><h3>沒有系列書</h3><p>目前沒有符合條件的系列書籍</p></div>';
            }
        } else {
            // 單本書區塊
            if (standaloneBooks.length > 0) {
                const pageSize = this.virtualScrollState.batchSize;
                const totalPages = Math.max(1, Math.ceil(standaloneBooks.length / pageSize));
                if (this.currentPage > totalPages) this.currentPage = totalPages;
                const startIndex = (this.currentPage - 1) * pageSize;
                const booksToRender = standaloneBooks.slice(startIndex, startIndex + pageSize);
                html += booksToRender.map(book => {
                    const originalIndex = this.books.findIndex(b => b.id === book.id);
                    const isLegacy = originalIndex >= 0 && originalIndex < 1493;
                    return this.createBookCard(book, isLegacy);
                }).join('');
                html += this.createPaginationHtml(standaloneBooks.length, '本');
            } else {
                html += '<div class="empty-state"><i class="fas fa-book"></i><h3>沒有單本書</h3><p>目前沒有符合條件的單本書籍</p></div>';
            }
        }

        // 判斷當前視圖模式
        const gridViewBtn = document.getElementById('grid-view');
        const isGridView = !gridViewBtn || gridViewBtn.classList.contains('active');

        if (isGridView) {
            // 網格視圖：渲染卡片
            if (gridContainer) {
                gridContainer.innerHTML = html;
                gridContainer.classList.remove('hidden');
            }
            if (listContainer) {
                listContainer.classList.add('hidden');
            }
        } else {
            // 列表視圖：渲染列表行
            const listHtml = this.generateListHtml(seriesBooks, standaloneBooks);
            if (listContainer) {
                listContainer.innerHTML = listHtml;
                listContainer.classList.remove('hidden');
            }
            if (gridContainer) {
                gridContainer.classList.add('hidden');
            }
        }
    }

    // 生成列表視圖的 HTML
    generateListHtml(seriesBooks, standaloneBooks) {
        let html = '';

        // 系列書區塊
        if (seriesBooks.length > 0) {
            html += seriesBooks.map(({ seriesName, books: seriesBooksList }, index) => {
                const totalBooks = seriesBooksList.length;
                const latestBook = seriesBooksList[0];

                return `
                    <div class="series-section-list">
                        <div class="series-header-list">
                            <h3 class="series-title">${this.escapeHtml(seriesName)}</h3>
                            <span class="series-count">（${totalBooks} 本）</span>
                        </div>
                        <div class="series-books-list">
                            ${seriesBooksList.map(book => this.generateListRow(book)).join('')}
                        </div>
                    </div>
                `;
            }).join('');
        } else {
            html += '<div class="empty-state"><i class="fas fa-layer-group"></i><h3>沒有系列書</h3><p>目前沒有符合條件的系列書籍</p></div>';
        }

        // 單本書區塊
        if (standaloneBooks.length > 0) {
            html += '<div class="standalone-section-list">';
            html += standaloneBooks.map(book => this.generateListRow(book)).join('');
            html += '</div>';
        } else {
            html += '<div class="empty-state"><i class="fas fa-book"></i><h3>沒有單本書</h3><p>目前沒有符合條件的單本書籍</p></div>';
        }

        return html;
    }

    // 生成單個列表行 - 使用新的 grid 結構
    generateListRow(book) {
        const coverUrl = book.coverUrl || book.coverImage || '';
        const coverImg = coverUrl ? `<img class="book-list-cover" src="${this.escapeHtml(coverUrl)}" alt="${this.escapeHtml(book.title)}">` : '<div class="list-cover-placeholder"><i class="fas fa-book"></i></div>';
        const stock = this.getBookStock(book);
        const availableCopies = stock.available;
        const totalCopies = stock.total;
        const isAvailable = availableCopies > 0;
        const userBorrowRecord = this.getActiveBorrowRecordForBook(book);
        const isBorrowed = !!userBorrowRecord;
        const buttonText = isBorrowed ? '歸還' : (isAvailable ? '借閱' : '已借完');
        const buttonClass = isBorrowed ? 'btn-warning' : (isAvailable ? 'btn-primary' : 'btn-secondary');
        const action = isBorrowed ? `returnBook('${this.escapeHtml(userBorrowRecord.id)}')` : `borrowBook('${this.escapeHtml(book.id)}')`;

        return `
            <div class="book-list-row">
                <div class="list-cover" onclick="library.showBookQuickPanel('${this.escapeHtml(book.id)}')" title="查看書籍資訊">
                    ${coverImg}
                </div>
                <div class="list-book-code">${this.escapeHtml(book.id)}</div>
                <div class="list-book-title">
                    <strong>${this.escapeHtml(book.title)}</strong>
                    <span>${this.escapeHtml(book.author)}</span>
                </div>
                <div class="list-book-genre">${this.escapeHtml(book.genre || '')}</div>
                <div class="list-book-year">${this.escapeHtml(book.year || '')}</div>
                <div class="list-book-stock">可借 ${availableCopies}/${totalCopies} 本</div>
                <div class="list-book-actions">
                    <button class="btn ${buttonClass}" onclick="library.${action}">${buttonText}</button>
                </div>
            </div>
        `;
    }

    // 舊按鈕相容：轉成下一頁
    loadMoreBooks() {
        this.goToPage((Number(this.currentPage) || 1) + 1);
    }

    goToPage(page) {
        this.currentPage = Math.max(1, Number(page) || 1);
        this.renderBooks();
        const booksSection = document.querySelector('.books-section');
        if (booksSection) {
            booksSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    createPaginationHtml(totalItems, unit = '本') {
        const pageSize = this.virtualScrollState?.batchSize || 48;
        const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
        if (totalPages <= 1) return '';

        const currentPage = Math.min(Math.max(1, Number(this.currentPage) || 1), totalPages);
        const start = (currentPage - 1) * pageSize + 1;
        const end = Math.min(currentPage * pageSize, totalItems);
        const pages = this.getPaginationPages(currentPage, totalPages);

        return `
            <nav class="pagination-bar" aria-label="書籍分頁">
                <div class="pagination-info">顯示 ${start}-${end}，共 ${totalItems} ${unit}</div>
                <div class="pagination-controls">
                    <button class="pagination-btn pagination-prev" ${currentPage === 1 ? 'disabled' : ''} onclick="library.goToPage(${currentPage - 1})">‹ 上一頁</button>
                    ${pages.map(page => page === 'ellipsis'
                        ? '<span class="pagination-ellipsis">...</span>'
                        : `<button class="pagination-page ${page === currentPage ? 'active' : ''}" onclick="library.goToPage(${page})">${page}</button>`
                    ).join('')}
                    <button class="pagination-btn pagination-next" ${currentPage === totalPages ? 'disabled' : ''} onclick="library.goToPage(${currentPage + 1})">下一頁 ›</button>
                </div>
            </nav>
        `;
    }

    getPaginationPages(currentPage, totalPages) {
        if (totalPages <= 7) {
            return Array.from({ length: totalPages }, (_, i) => i + 1);
        }

        const pages = [1];
        const start = Math.max(2, currentPage - 1);
        const end = Math.min(totalPages - 1, currentPage + 1);

        if (start > 2) pages.push('ellipsis');
        for (let page = start; page <= end; page++) pages.push(page);
        if (end < totalPages - 1) pages.push('ellipsis');
        pages.push(totalPages);
        return pages;
    }

    // 切換系列展開/收合
    toggleSeries(seriesId) {
        this.showSeriesModal(seriesId);
    }

    createSeriesSectionHtml({ seriesName, books: seriesBooksList }, index) {
        const totalBooks = seriesBooksList.length;
        const latestBook = seriesBooksList[0];
        const seriesId = `series-${index}`;
        this.seriesModalData[seriesId] = {
            seriesName,
            books: seriesBooksList
        };

        const originalIndex = this.books.findIndex(b => b.id === latestBook.id);
        const isLegacy = originalIndex >= 0 && originalIndex < 1493;

        return `
            <div class="series-section">
                <div class="series-header" onclick="library.showSeriesModal('${seriesId}')">
                    <h3 class="series-title">
                        <i class="fas fa-layer-group series-toggle-icon" id="${seriesId}-icon"></i>
                        <span class="series-name-text">${this.escapeHtml(seriesName)}</span>
                        <span class="series-count">（${totalBooks} 本）</span>
                    </h3>
                </div>
                <div class="series-actions">
                    <button class="btn btn-outline btn-sm series-expand-btn" onclick="library.showSeriesModal('${seriesId}')">
                        <i class="fas fa-up-right-from-square"></i> 展開全部 ${totalBooks} 本
                    </button>
                </div>
                <div class="series-books books-grid" id="${seriesId}">
                    ${this.createBookCard(latestBook, isLegacy)}
                </div>
            </div>
        `;
    }

    // 切換書籍類型分頁（系列書/單本書）
    switchBookType(type) {
        this.currentBookType = type;

        // 切換書籍類型時重設頁碼
        this.currentPage = 1;

        // 更新按鈕狀態
        document.getElementById('tab-series').classList.toggle('active', type === 'series');
        document.getElementById('tab-standalone').classList.toggle('active', type === 'standalone');

        // 重新渲染書籍列表
        this.renderBooks();
    }

    showSeriesModal(seriesId) {
        const data = this.seriesModalData?.[seriesId];
        if (!data || !Array.isArray(data.books)) return;

        const modal = document.createElement('div');
        modal.className = 'modal series-modal';
        modal.innerHTML = `
            <div class="modal-content series-modal-content">
                <button class="series-modal-close" type="button" aria-label="關閉">
                    <i class="fas fa-times"></i>
                </button>
                <div class="series-modal-header">
                    <div>
                        <h2>${this.escapeHtml(data.seriesName)}</h2>
                        <p>共 ${data.books.length} 本書</p>
                    </div>
                </div>
                <div class="series-modal-list">
                    ${data.books.map(book => this.createSeriesModalItem(book)).join('')}
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        modal.style.display = 'block';

        const close = () => modal.remove();
        modal.querySelector('.series-modal-close')?.addEventListener('click', close);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) close();
        });
    }

    createSeriesModalItem(book) {
        const coverUrl = book.coverUrl || book.coverImage || '';
        const coverImg = this.isAllowedCoverUrl(coverUrl)
            ? `<img src="${this.escapeHtml(coverUrl)}" alt="${this.escapeHtml(book.title)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
               <div class="series-modal-cover-placeholder" style="display:none;"><i class="fas fa-book"></i></div>`
            : `<div class="series-modal-cover-placeholder"><i class="fas fa-book"></i></div>`;
        const stock = this.getBookStock(book);
        const availableCopies = stock.available;
        const totalCopies = stock.total;
        const activeBorrowed = this.getActiveBorrowRecordForBook(book);
        const canBorrow = !!this.currentUser && availableCopies > 0;
        const isNew = this.isRecentlyUpdatedBook(book);
        const escapedId = this.escapeHtml(book.id);
        const actionButton = activeBorrowed
            ? `<button class="btn btn-warning btn-small" onclick="library.returnBook('${this.escapeHtml(activeBorrowed.id)}')"><i class="fas fa-undo"></i> 歸還</button>`
            : `<button class="btn btn-primary btn-small" ${canBorrow ? '' : 'disabled'} onclick="library.borrowBook('${escapedId}')"><i class="fas fa-book-reader"></i> ${canBorrow ? '借閱' : '已借完'}</button>`;
        const adminButtons = this.hasAdminAccess() ? `
            <button class="btn btn-success btn-small" onclick="library.duplicateBookAsNewCopy('${escapedId}')"><i class="fas fa-plus"></i> 複製新增</button>
            <button class="btn btn-info btn-small" onclick="library.editBookFromSeriesModal('${escapedId}')"><i class="fas fa-pen"></i> 編輯</button>
            <button class="btn btn-danger btn-small" onclick="library.deleteBook('${escapedId}')"><i class="fas fa-trash"></i> 刪除</button>
        ` : '';

        return `
            <article class="series-modal-item ${isNew ? 'is-new' : ''}" data-book-id="${escapedId}">
                <div class="series-modal-cover" onclick="library.showBookQuickPanel('${escapedId}')" title="查看書籍資訊">
                    ${coverImg}
                    ${isNew ? '<span class="new-badge">NEW</span>' : ''}
                </div>
                <div class="series-modal-book-info">
                    <div class="series-modal-book-topline">
                        <span class="book-id">${escapedId}</span>
                        <span class="book-genre">${this.escapeHtml(book.genre || this.getGenreFromId(book.id))}</span>
                    </div>
                    <h3>${this.escapeHtml(book.title)}</h3>
                    <div class="series-modal-meta">
                        <span><i class="fas fa-pen-nib"></i> ${this.escapeHtml(book.author || '未填作者')}</span>
                        <span><i class="fas fa-calendar"></i> ${this.escapeHtml(book.year || '未填年份')}</span>
                        <span><i class="fas fa-copy"></i> 可借 ${availableCopies}/${totalCopies} 本</span>
                    </div>
                </div>
                <div class="series-modal-actions">
                    ${actionButton}
                    ${adminButtons}
                </div>
            </article>
        `;
    }

    // 合併相同書名的書籍
    mergeBooksByTitle(books) {
        const titleMap = new Map();
        
        books.forEach(book => {
            const normalizedTitle = this.normalizeTitle(book.title);
            
            if (!titleMap.has(normalizedTitle)) {
                // 創建合併後的書籍對象
                const mergedBook = {
                    ...book,
                    bookIds: [book.id],
                    mergedBooks: [book],
                    totalCopies: book.copies || 1,
                    totalAvailableCopies: book.availableCopies || 0,
                    // 新書標記：合併卡片沿用最新 addedAt
                    isNew: !!book.isNew,
                    addedAt: book.addedAt || null,
                    updatedAt: book.updatedAt || null
                };
                titleMap.set(normalizedTitle, mergedBook);
            } else {
                // 合併到現有的書籍
                const existingBook = titleMap.get(normalizedTitle);
                existingBook.bookIds.push(book.id);
                existingBook.mergedBooks.push(book);
                existingBook.totalCopies += (book.copies || 1);
                existingBook.totalAvailableCopies += (book.availableCopies || 0);

                // 新書標記：只要其中一本是新書就標記；addedAt 取最新
                if (book.isNew) existingBook.isNew = true;
                const existingAddedAt = existingBook.addedAt || 0;
                const nextAddedAt = book.addedAt || 0;
                if (nextAddedAt > existingAddedAt) existingBook.addedAt = nextAddedAt;
                const existingUpdatedAt = existingBook.updatedAt || 0;
                const nextUpdatedAt = book.updatedAt || 0;
                if (nextUpdatedAt > existingUpdatedAt) existingBook.updatedAt = nextUpdatedAt;
                
                // 更新主要資訊（使用第一本書的資訊）
                if (!existingBook.author && book.author) {
                    existingBook.author = book.author;
                }
                if (!existingBook.coverUrl && book.coverUrl) {
                    existingBook.coverUrl = book.coverUrl;
                }
                if (!existingBook.year && book.year) {
                    existingBook.year = book.year;
                }
            }
        });
        
        return Array.from(titleMap.values());
    }

    // 標準化書名（用於比較）
    normalizeTitle(title) {
        if (!title) return '';
        return title
            .toLowerCase()
            .trim()
            .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, '') // 保留中文、英文、數字和空格
            .replace(/\s+/g, ' ') // 合併多個空格
            .trim();
    }

    // 根據書編號自動分類匹配
    matchesBookGenre(book, genreFilter) {
        const explicitGenre = String(book.genre || '').trim();
        if (explicitGenre) {
            return explicitGenre === genreFilter;
        }

        // 以主書碼 book.id 的前綴為準，避免合併書卡因含其他前綴而被放行
        const mainCode = String(book.id || '').toUpperCase();
        const mainMatch = mainCode.match(/^([ABCD])(\d+)$/);
        if (mainMatch) {
            const prefix = mainMatch[1];
            switch (prefix) {
                case 'A':
                    return genreFilter === '繪本';
                case 'B':
                    return genreFilter === '橋梁書';
                case 'C':
                    return genreFilter === '文字書';
                case 'D':
                    return genreFilter === '雜誌';
                default:
                    return false;
            }
        }

        // 主書碼不合法時，才回退檢查 bookIds（例如舊資料/合併資料）
        const allCodes = Array.isArray(book.bookIds)
            ? book.bookIds.map(v => String(v || '').toUpperCase()).filter(Boolean)
            : [];

        const prefixes = allCodes
            .map(code => code.match(/^([ABCD])(\d+)$/))
            .filter(Boolean)
            .map(m => m[1]);

        if (prefixes.length > 0) {
            return prefixes.some(prefix => {
                switch (prefix) {
                    case 'A':
                        return genreFilter === '繪本';
                    case 'B':
                        return genreFilter === '橋梁書';
                    case 'C':
                        return genreFilter === '文字書';
                    case 'D':
                        return genreFilter === '雜誌';
                    default:
                        return false;
                }
            });
        }

        // 如果書碼格式都不正確，最後才使用原有類別判斷
        return book.genre === genreFilter;
    }

    // 判斷是否為國小四年級適合的書籍
    isElementaryGrade4Book(book, genreFilter) {
        // 如果已設定類別，直接檢查
        if (book.genre) {
            return book.genre === genreFilter;
        }

        // 根據書名和作者判斷是否適合國小四年級
        const title = String(book.title || '').toLowerCase();
        const author = String(book.author || '').toLowerCase();
        const year = parseInt(book.year) || 0;
        
        // 適合國小四年級的類別
        const suitableGenres = ['橋梁書', '童話', '冒險', '科普', '傳記', '歷史', '文學'];
        
        // 檢查是否在適合的類別中
        if (suitableGenres.includes(genreFilter)) {
            return true;
        }
        
        // 根據書名關鍵字判斷
        const grade4Keywords = [
            '小學', '國小', '四年級', '童話', '故事', '冒險', 
            '科學', '自然', '歷史', '地理', '傳記', '神話',
            '寓言', '成語', '古詩', '經典', '名著', '兒童'
        ];
        
        const hasGrade4Keyword = grade4Keywords.some(keyword => 
            title.includes(keyword) || author.includes(keyword)
        );
        
        if (hasGrade4Keyword) {
            return true;
        }
        
        // 根據出版年份判斷（較新的書籍通常更適合）
        if (year >= 2000 && suitableGenres.includes(genreFilter)) {
            return true;
        }
        
        return false;
    }

    // 從編輯模態框搜尋書籍資訊
    searchBookInfoFromEdit() {
        const titleInput = document.getElementById('edit-book-title');
        const searchTerm = titleInput.value.trim();
        
        if (!searchTerm) {
            this.showToast('請先輸入書名再進行搜尋', 'warning');
            titleInput.focus();
            return;
        }

        // 直接顯示多選搜尋選項
        this.showMultiSearchOptions(searchTerm);
    }

    // 建立書籍卡片
    createBookCard(book) {
        // 判斷是否為合併書籍
        const isMerged = book.mergedBooks && book.mergedBooks.length > 1;

        // 新增/更新書籍記號（7天內視為新書）
        const isNew = this.isRecentlyUpdatedBook(book);
        
        // 計算可借閱數量（使用合併後的數量）
        const stock = this.getBookStock(book);
        const availableCopies = stock.available;
        const totalCopies = stock.total;
        
        const canBorrow = !!this.currentUser && availableCopies > 0;

        // 計算用戶已借閱數量（需要檢查所有合併的書籍）
        let userBorrowedCount = 0;
        if (this.currentUser) {
            if (isMerged) {
                userBorrowedCount = book.mergedBooks.reduce((count, mergedBook) => {
                    return count + this.borrowedBooks.filter(
                        b => b.bookId === mergedBook.id && b.userId === this.currentUser.username && !b.returnedAt
                    ).length;
                }, 0);
            } else {
                userBorrowedCount = this.borrowedBooks.filter(
                    b => b.bookId === book.id && b.userId === this.currentUser.username && !b.returnedAt
                ).length;
            }
        }

        // 顯示書碼資訊
        const bookIdsDisplay = isMerged 
            ? `${book.id} 等${book.bookIds.length}本` 
            : book.id;

        const canManageBooks = this.hasAdminAccess();

        return `
            <div class="book-card genre-${book.genre} ${availableCopies === 0 ? 'borrowed' : ''} ${isMerged ? 'merged' : ''}" data-book-id="${this.escapeHtml(book.id)}">
                <div class="book-cover" onclick="library.showBookQuickPanel('${this.escapeHtml(book.id)}')" title="查看書籍資訊">
                    ${this.isAllowedCoverUrl(book.coverUrl) ? 
                        `<img src="${book.coverUrl}" alt="${book.title}" class="book-cover-img" referrerpolicy="no-referrer" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                        <div class="book-cover-placeholder" style="display: none;">
                            <i class="fas fa-book"></i>
                        </div>` : 
                        `<div class="book-cover-placeholder" style="display: flex;">
                            <i class="fas fa-book"></i>
                        </div>`
                    }
                    ${isMerged ? '<div class="merged-badge">合併</div>' : ''}
                    ${isNew ? '<div class="new-badge">NEW</div>' : ''}
                </div>
                <div class="book-content">
                    <div class="book-header">
                        <span class="book-id">${bookIdsDisplay}</span>
                        <span class="book-genre">${book.genre}</span>
                    </div>
                    <div class="book-title">${book.title}</div>
                    <div class="book-info">
                        <div class="book-info-item">
                            <i class="fas fa-copy"></i>
                            <span>可借 ${availableCopies}/${totalCopies} 本</span>
                        </div>
                        ${isMerged ? `
                        <div class="book-info-item">
                            <i class="fas fa-layer-group"></i>
                            <span>包含 ${book.mergedBooks.length} 本書</span>
                        </div>` : ''}
                        ${isMerged ? `
                        <div class="book-info-item">
                            <i class="fas fa-list"></i>
                            <span>書碼：${book.bookIds.join(', ')}</span>
                        </div>` : ''}
                        ${book.bookUrl ? `
                        <div class="book-info-item">
                            <i class="fas fa-link"></i>
                            <a href="${this.escapeHtml(book.bookUrl)}" target="_blank" class="book-url-link" title="前往書籍網頁">
                                書籍網址
                            </a>
                        </div>` : ''}
                    </div>
                    <div class="book-actions">
                        ${canBorrow ?
                            `<button class="btn btn-primary btn-small" onclick="library.borrowBook('${book.id}')">
                                <i class="fas fa-book-reader"></i> ${userBorrowedCount > 0 ? '再借' : '借閱'}
                            </button>` :
                            `<button class="btn btn-outline btn-small" disabled>
                                <i class="fas fa-ban"></i> 已借出
                            </button>`
                        }
                        ${canManageBooks ? `
                            <button class="btn btn-success btn-small" onclick="library.duplicateBookAsNewCopy('${book.id}')">
                                <i class="fas fa-plus"></i> 複製新增
                            </button>
                            <button class="btn btn-info btn-small" onclick="library.showEditBookModal('${book.id}')">
                                <i class="fas fa-pen"></i> 編輯
                            </button>
                            <button class="btn btn-warning btn-small" onclick="library.deleteBook('${book.id}')">
                                <i class="fas fa-trash"></i> 刪除
                            </button>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;
    }

    refreshBookCardInPlace(book, previousId = null) {
        const cardSelector = previousId
            ? `.book-card[data-book-id="${CSS.escape(previousId)}"]`
            : `.book-card[data-book-id="${CSS.escape(book.id)}"]`;
        const currentCard = document.querySelector(cardSelector);
        if (!currentCard) return false;

        const replacement = document.createElement('div');
        replacement.innerHTML = this.createBookCard(book).trim();
        const nextCard = replacement.firstElementChild;
        if (!nextCard) return false;

        currentCard.replaceWith(nextCard);
        return true;
    }

    showEditBookModal(bookId) {
        if (!this.requireAdmin('編輯書籍')) return;

        // 查找書籍（包括合併書籍中的個別書籍）
        let targetBook = this.books.find(b => b.id === bookId);
        let allRelatedBooks = [];

        if (targetBook) {
            // 如果是普通書籍，查找所有相同書名的書籍
            const sameTitleBooks = this.books.filter(b => 
                this.normalizeTitle(b.title) === this.normalizeTitle(targetBook.title)
            );
            allRelatedBooks = sameTitleBooks;
        } else {
            // 如果直接找不到，可能在合併書籍中，查找所有相關書籍
            const mergedBooks = this.mergeBooksByTitle(this.books);
            const mergedBook = mergedBooks.find(mb => 
                mb.bookIds && mb.bookIds.includes(bookId)
            );
            
            if (mergedBook) {
                allRelatedBooks = mergedBook.mergedBooks || [];
                targetBook = allRelatedBooks.find(b => b.id === bookId);
            }
        }

        if (!targetBook || allRelatedBooks.length === 0) {
            this.showToast('書籍不存在', 'error');
            return;
        }

        // 如果有多本相同書名的書籍，顯示選擇畫面
        if (allRelatedBooks.length > 1) {
            this.showBookSelectionModal(allRelatedBooks, targetBook.id);
        } else {
            // 只有一本書，直接顯示編輯畫面
            this.openEditBookModal(targetBook);
        }
    }

    editBookFromSeriesModal(bookId) {
        if (!this.requireAdmin('編輯書籍')) return;

        const book = this.books.find(b => b.id === bookId);
        if (!book) {
            this.showToast('書籍不存在', 'error');
            return;
        }

        const seriesModal = document.querySelector('.series-modal');
        if (seriesModal) seriesModal.remove();

        const selectionModal = document.querySelector('.book-selection-modal');
        if (selectionModal) selectionModal.remove();

        this.openEditBookModal(book);
    }

    // 顯示書籍選擇模態框
    showBookSelectionModal(books, selectedBookId) {
        const modal = document.createElement('div');
        modal.className = 'modal book-selection-modal';
        modal.style.display = 'block';
        
        const booksList = books.map(book => `
            <div class="book-selection-item ${book.id === selectedBookId ? 'selected' : ''}" 
                 onclick="library.selectBookForEdit('${book.id}')">
                <div class="book-selection-info">
                    <div class="book-selection-id">書碼：${book.id}</div>
                    <div class="book-selection-details">
                        <div class="book-selection-author">作者：${book.author || '未知'}</div>
                        <div class="book-selection-year">出版年份：${book.year || '未知'}</div>
                        <div class="book-selection-copies">冊數：${book.copies || 1}</div>
                        <div class="book-selection-available">可借：${book.availableCopies || 0}</div>
                    </div>
                </div>
                <div class="book-selection-cover">
                    ${this.isAllowedCoverUrl(book.coverUrl) ? 
                        `<img src="${book.coverUrl}" alt="${book.title}" referrerpolicy="no-referrer" loading="lazy" onerror="this.style.display='none'">` : 
                        '<div class="no-cover">無封面</div>'
                    }
                </div>
                ${book.id === selectedBookId ? 
                    '<div class="book-selection-badge">目前選擇</div>' : 
                    '<div class="book-selection-select-btn">選擇</div>'
                }
            </div>
        `).join('');
        
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 600px;">
                <div class="modal-header">
                    <h3>選擇要編輯的書籍</h3>
                    <span class="close" onclick="this.closest('.modal').remove()">&times;</span>
                </div>
                <div class="modal-body">
                    <p class="selection-hint">找到多本相同書名的書籍，請選擇要編輯的具體書籍：</p>
                    <div class="book-selection-list">
                        ${booksList}
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">
                        <i class="fas fa-times"></i> 取消
                    </button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
    }

    // 選擇書籍進行編輯
    selectBookForEdit(bookId) {
        const book = this.books.find(b => b.id === bookId);
        if (!book) {
            this.showToast('書籍不存在', 'error');
            return;
        }
        
        // 關閉目前的「選擇要編輯的書籍」視窗，不影響真正的編輯視窗
        const selectionModal = document.querySelector('.book-selection-modal');
        if (selectionModal) selectionModal.remove();
        
        // 開啟編輯模態框
        this.openEditBookModal(book);
    }

    // 開啟編輯書籍模態框
    openEditBookModal(book) {
        const modal = document.getElementById('edit-book-modal');
        const originalIdInput = document.getElementById('edit-book-original-id');
        const idInput = document.getElementById('edit-book-id');
        const titleInput = document.getElementById('edit-book-title');
        const authorInput = document.getElementById('edit-book-author');
        const coverInput = document.getElementById('edit-book-cover-url');
        const bookUrlInput = document.getElementById('edit-book-url');
        const yearInput = document.getElementById('edit-book-year');
        const copiesInput = document.getElementById('edit-book-copies');
        const seriesInput = document.getElementById('edit-book-series');
        const genreInput = document.getElementById('edit-book-genre-manual');

        // 清除之前的錯誤提示
        const errorDiv = document.getElementById('edit-book-id-error');
        if (errorDiv) {
            errorDiv.style.display = 'none';
            errorDiv.textContent = '';
        }
        
        // 確保書碼輸入框可編輯
        if (idInput) {
            idInput.classList.remove('error');
            idInput.disabled = false;
            idInput.readOnly = false;
            idInput.removeAttribute('disabled');
            idInput.removeAttribute('readonly');
        }

        if (originalIdInput) originalIdInput.value = book.id;
        if (idInput) idInput.value = book.id;
        if (titleInput) titleInput.value = book.title || '';
        if (authorInput) authorInput.value = book.author || '';
        if (coverInput) coverInput.value = book.coverUrl || '';
        if (bookUrlInput) bookUrlInput.value = book.bookUrl || '';
        if (yearInput) yearInput.value = book.year || this.settings.defaultYear;
        if (copiesInput) copiesInput.value = book.copies || 1;
        if (genreInput) genreInput.value = book.genre || this.getGenreFromId(book.id);

        // 加載系列書名稱
        if (seriesInput) {
            seriesInput.value = book.series || '';
        }

        if (modal) modal.style.display = 'block';

        // 確保書碼輸入框可編輯（延遲確保屬性設置生效）
        setTimeout(() => {
            if (idInput) {
                idInput.disabled = false;
                idInput.readOnly = false;
                idInput.removeAttribute('disabled');
                idInput.removeAttribute('readonly');
                idInput.focus();
            }
        }, 100);

        // 編輯時不主動打 Google Books，避免大量開啟書籍造成 429。
    }

    // 自動搜尋書籍資料（編輯時使用）
    async autoSearchBookInfo(bookTitle) {
        if (!bookTitle || bookTitle.trim() === '') return;

        try {
            // 使用 Google Books API 搜尋
            const query = encodeURIComponent(bookTitle.trim());
            const apiUrl = `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=1&langRestrict=zh${this.getGoogleBooksApiKeyParam()}`;

            const response = await fetch(apiUrl);
            if (!response.ok) return;

            const data = await response.json();
            
            if (!data.items || data.items.length === 0) return;

            const book = data.items[0];
            const info = book.volumeInfo;

            // 檢查是否需要更新現有資料
            const authorInput = document.getElementById('edit-book-author');
            const coverInput = document.getElementById('edit-book-cover-url');
            const yearInput = document.getElementById('edit-book-year');

            let hasUpdates = false;
            let updateMessage = '找到書籍資訊：';

            // 更新作者（如果目前為空）
            if (authorInput && (!authorInput.value || authorInput.value.trim() === '') && info.authors) {
                authorInput.value = info.authors.join(', ');
                hasUpdates = true;
                updateMessage += ' 作者已更新';
            }

            // 更新封面（如果目前為空）
            if (coverInput && (!coverInput.value || coverInput.value.trim() === '') && info.imageLinks) {
                const coverUrl = info.imageLinks.extraLarge || 
                                info.imageLinks.large || 
                                info.imageLinks.medium || 
                                info.imageLinks.thumbnail || 
                                info.imageLinks.smallThumbnail;
                if (coverUrl) {
                    coverInput.value = coverUrl;
                    hasUpdates = true;
                    updateMessage += ' 封面已更新';
                }
            }

            // 更新年份（如果目前為預設值且找到更準確的年份）
            if (yearInput && info.publishedDate) {
                const publishedYear = info.publishedDate.substring(0, 4);
                const currentYear = yearInput.value;
                const defaultYear = this.settings.defaultYear;
                
                if (currentYear == defaultYear && publishedYear !== currentYear) {
                    yearInput.value = publishedYear;
                    hasUpdates = true;
                    updateMessage += ' 年份已更新';
                }
            }

            // 顯示更新結果
            if (hasUpdates) {
                this.showToast(updateMessage, 'success');
            }

        } catch (error) {
            console.error('自動搜尋書籍資訊失敗:', error);
            // 靜默失敗，不影響編輯功能
        }
    }

    // 搜尋借閱記錄
    searchBorrowedBooks() {
        if (!this.currentUser) {
            this.renderBorrowedBooks();
            return;
        }

        const searchTerm = (document.getElementById('borrowed-search-input')?.value || '').trim().toLowerCase();
        const statusFilter = document.getElementById('borrowed-filter-status')?.value || 'all';
        const sortBy = document.getElementById('borrowed-sort')?.value || 'date-desc';

        if (this.hasAdminAccess()) {
            if (statusFilter === 'borrowed') this.adminBorrowedTab = 'active';
            if (statusFilter === 'overdue') this.adminBorrowedTab = 'overdue';
            if (statusFilter === 'returned') this.adminBorrowedTab = 'returned';
        }

        // 根據用戶權限獲取基礎數據
        let filteredBooks;
        if (this.hasAdminAccess()) {
            // 管理者（主要管理者和副管理者）可以搜尋所有借閱記錄
            filteredBooks = [...this.borrowedBooks];
        } else {
            // 一般用戶只能搜尋自己的完整借閱記錄
            filteredBooks = this.borrowedBooks.filter(
                b => b.userId === this.currentUser.username
            );
        }

        // 搜尋過濾
        if (searchTerm) {
            filteredBooks = filteredBooks.filter(record => {
                const book = this.books.find(b => b.id === record.bookId);
                const bookTitle = book ? book.title.toLowerCase() : '';
                const userId = record.userId ? record.userId.toLowerCase() : '';
                const bookId = record.bookId ? record.bookId.toLowerCase() : '';

                return bookTitle.includes(searchTerm) ||
                       userId.includes(searchTerm) ||
                       bookId.includes(searchTerm);
            });
        }

        // 一般使用者使用下拉篩選；管理者由上方分頁切換，避免 0 筆時分頁消失
        if (!this.hasAdminAccess()) {
            const now = new Date();
            filteredBooks = filteredBooks.filter(record => {
                const isReturned = record.returnedAt;
                const isOverdue = !isReturned && record.dueDate && new Date(record.dueDate) < now;

                switch (statusFilter) {
                    case 'borrowed':
                        return !isReturned;
                    case 'returned':
                        return isReturned;
                    case 'overdue':
                        return isOverdue;
                    default:
                        return true;
                }
            });
        }

        // 排序
        filteredBooks.sort((a, b) => {
            switch (sortBy) {
                case 'date-asc':
                    return new Date(a.borrowDate) - new Date(b.borrowDate);
                case 'date-desc':
                    return new Date(b.borrowDate) - new Date(a.borrowDate);
                case 'title':
                    const bookA = this.books.find(b => b.id === a.bookId);
                    const bookB = this.books.find(b => b.id === b.bookId);
                    return (bookA?.title || '').localeCompare(bookB?.title || '');
                case 'borrower':
                    return (a.userId || '').localeCompare(b.userId || '');
                case 'bookId':
                    return a.bookId.localeCompare(b.bookId);
                default:
                    return 0;
            }
        });

        this.renderBorrowedBooks(filteredBooks);
        this.updateBorrowedStatsSummary(filteredBooks);
    }
    
    // 清除借閱記錄搜尋
    clearBorrowedSearch() {
        const searchInput = document.getElementById('borrowed-search-input');
        const statusFilter = document.getElementById('borrowed-filter-status');
        const sortSelect = document.getElementById('borrowed-sort');
        
        if (searchInput) searchInput.value = '';
        if (statusFilter) statusFilter.value = 'all';
        if (sortSelect) sortSelect.value = 'date-desc';
        
        this.renderBorrowedBooks();
        this.updateBorrowedStatsSummary();
    }
    
    // 顯示逾期書籍
    showOverdueBooks() {
        if (!this.currentUser) {
            this.showToast('請先登入', 'error');
            return;
        }

        const now = new Date();
        let overdueBooks;
        
        if (this.currentUser.username === 'sindy16872000') {
            // 管理員可以看到所有逾期書籍
            overdueBooks = this.borrowedBooks.filter(record => {
                return !record.returnedAt && record.dueDate && new Date(record.dueDate) < now;
            });
        } else {
            // 一般用戶只能看到自己的逾期書籍
            overdueBooks = this.borrowedBooks.filter(record => {
                return !record.returnedAt && 
                       record.dueDate && 
                       new Date(record.dueDate) < now &&
                       record.userId === this.currentUser.username;
            });
        }
        
        if (overdueBooks.length === 0) {
            this.showToast('目前沒有逾期書籍', 'success');
            return;
        }
        
        // 設定篩選條件為逾期
        document.getElementById('borrowed-filter-status').value = 'overdue';
        this.searchBorrowedBooks();
        
        this.showToast(`找到 ${overdueBooks.length} 本逾期書籍`, 'warning');
    }
    
    // 顯示借閱統計
    showBorrowingStats() {
        if (!this.currentUser) {
            this.showToast('請先登入', 'error');
            return;
        }

        const records = this.hasAdminAccess()
            ? [...this.borrowedBooks]
            : this.borrowedBooks.filter(record => record.userId === this.currentUser.username);

        const totalBorrowed = records.length;
        const currentlyBorrowed = records.filter(b => !b.returnedAt).length;
        const returnedBooks = records.filter(b => b.returnedAt).length;
        
        const now = new Date();
        const overdueBooks = records.filter(b => {
            return !b.returnedAt && b.dueDate && new Date(b.dueDate) < now;
        });
        
        // 計算最熱門的書籍
        const bookCounts = {};
        records.forEach(record => {
            bookCounts[record.bookId] = (bookCounts[record.bookId] || 0) + 1;
        });
        
        const topBooks = Object.entries(bookCounts)
            .sort(([,a], [,b]) => b - a)
            .slice(0, 5)
            .map(([bookId, count]) => {
                const book = this.books.find(b => b.id === bookId);
                return { book: book?.title || bookId, count };
            });
        
        // 計算最活躍的借閱者
        const borrowerCounts = {};
        records.forEach(record => {
            if (record.userId) {
                borrowerCounts[record.userId] = (borrowerCounts[record.userId] || 0) + 1;
            }
        });
        
        const topBorrowers = Object.entries(borrowerCounts)
            .sort(([,a], [,b]) => b - a)
            .slice(0, 5)
            .map(([name, count]) => ({ name, count }));

        const statItems = [
            { label: '總借閱次數', value: totalBorrowed, tone: 'total' },
            { label: '目前借出', value: currentlyBorrowed, tone: 'active' },
            { label: '已歸還', value: returnedBooks, tone: 'returned' },
            { label: '逾期未還', value: overdueBooks.length, tone: 'overdue' }
        ];

        const renderRanking = (items, getName) => {
            if (!items.length) {
                return '<div class="stats-empty">目前沒有資料</div>';
            }
            return `
                <ol class="stats-ranking">
                    ${items.map((item, index) => `
                        <li>
                            <span class="rank-no">${index + 1}</span>
                            <span class="rank-name">${this.escapeHtml(getName(item))}</span>
                            <strong>${item.count} 次</strong>
                        </li>
                    `).join('')}
                </ol>
            `;
        };
        
        const statsHtml = `
            <div class="borrowing-stats">
                <div class="borrowing-stats-header">
                    <h3><i class="fas fa-chart-bar"></i> 借閱統計</h3>
                    <span>${this.hasAdminAccess() ? '全部借閱資料' : '我的借閱資料'}</span>
                </div>
                
                <div class="stats-grid">
                    <div class="stat-card stat-card-summary">
                        <h4>總體統計</h4>
                        <div class="stats-number-grid">
                            ${statItems.map(item => `
                                <div class="stats-number ${item.tone}">
                                    <span>${item.label}</span>
                                    <strong>${item.value}</strong>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                    
                    <div class="stat-card">
                        <h4>熱門書籍 TOP 5</h4>
                        ${renderRanking(topBooks, item => item.book)}
                    </div>
                    
                    <div class="stat-card">
                        <h4>活躍借閱者 TOP 5</h4>
                        ${renderRanking(topBorrowers, item => item.name)}
                    </div>
                </div>
            </div>
        `;
        
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content borrowing-stats-modal">
                <span class="close">&times;</span>
                ${statsHtml}
            </div>
        `;
        
        document.body.appendChild(modal);
        modal.style.display = 'block';
        
        // 設置關閉事件
        modal.querySelector('.close').onclick = () => modal.remove();
        modal.onclick = (e) => {
            if (e.target === modal) modal.remove();
        };
    }
    
    // 更新借閱統計摘要
    updateBorrowedStatsSummary(filteredBooks = null) {
        let booksToCount = filteredBooks;
        
        // 如果沒有傳入過濾後的書籍，根據用戶權限決定統計範圍
        if (!booksToCount) {
            if (!this.currentUser) {
                // 未登入用戶，顯示 0
                booksToCount = [];
            } else if (this.hasAdminAccess()) {
                // 管理員可以看到所有借閱記錄
                booksToCount = [...this.borrowedBooks];
            } else {
                // 一般用戶只能看到自己的完整借閱記錄
                booksToCount = this.borrowedBooks.filter(
                    b => b.userId === this.currentUser.username
                );
            }
        }
        
        const now = new Date();
        
        const totalCount = booksToCount.length;
        const overdueCount = booksToCount.filter(record => {
            return !record.returnedAt && record.dueDate && new Date(record.dueDate) < now;
        }).length;
        
        const totalElement = document.getElementById('borrowed-count-summary');
        const overdueElement = document.getElementById('overdue-count-summary');
        
        if (totalElement) {
            totalElement.textContent = `總計: ${totalCount} 筆`;
        }
        if (overdueElement) {
            overdueElement.textContent = `逾期: ${overdueCount} 本`;
            overdueElement.style.color = overdueCount > 0 ? '#dc3545' : '#28a745';
        }
    }

    // 檢查書碼重複（編輯時即時驗證）
    async checkBookCodeDuplicate(newId) {
        const originalId = this.normalizeBookIdText(document.getElementById('edit-book-original-id')?.value || '');
        const errorDiv = document.getElementById('edit-book-id-error');
        const inputField = document.getElementById('edit-book-id');
        
        if (!newId || !errorDiv || !inputField) return;

        let upper = this.normalizeBookIdText(newId);
        if (inputField.value !== upper) {
            inputField.value = upper;
        }

        // 清除之前的錯誤狀態
        errorDiv.style.display = 'none';
        errorDiv.style.color = '#f56565';
        inputField.classList.remove('error');

        if (/^[ABCD]$/.test(upper)) {
            errorDiv.textContent = '正在讀取 Google Sheet 書碼...';
            errorDiv.style.display = 'block';
            errorDiv.style.color = '#4a5568';

            await this.refreshRemoteBookIdCache({ silent: true, force: false });
            const suggestedId = this.generateNextBookId(upper);
            if (!suggestedId) {
                errorDiv.textContent = '無法產生下一個書碼';
                errorDiv.style.color = '#f56565';
                inputField.classList.add('error');
                return;
            }

            inputField.value = suggestedId;
            upper = suggestedId;

            const genreInput = document.getElementById('edit-book-genre-manual');
            const genre = this.getGenreFromId(suggestedId);
            if (genreInput && genre !== '未知') {
                genreInput.value = genre;
            }
        }
        
        // 如果書碼沒有改變，不檢查
        if (upper === originalId) return;
        
        // 檢查書碼格式
        if (!this.bookIdPattern.test(upper)) {
            errorDiv.textContent = '書碼格式錯誤：請用 A/B/C/D + 數字（例：D0001）';
            errorDiv.style.display = 'block';
            inputField.classList.add('error');
            return;
        }
        
        await this.refreshRemoteBookIdCache({ silent: true, force: false });
        if (this.hasGoogleSheetBookId(upper)) {
            errorDiv.textContent = this.getGoogleSheetBookIdExistsMessage(upper);
            errorDiv.style.display = 'block';
            errorDiv.style.color = '#f56565';
            inputField.classList.add('error');
        } else {
            // 書碼可用，顯示成功提示（可選）
            errorDiv.textContent = '書碼可用';
            errorDiv.style.display = 'block';
            errorDiv.style.color = '#28a745';
            inputField.classList.remove('error');
            this.showSameTitleDifferentPrefixHint({
                titleFieldId: 'edit-book-title',
                idFieldId: 'edit-book-id',
                excludeId: originalId
            });
        }
    }

    async handleEditBook(e) {
        e.preventDefault();
        if (!this.requireAdmin('編輯書籍')) return;

        const preservedScrollY = window.scrollY || window.pageYOffset || 0;
        const preservedScrollX = window.scrollX || window.pageXOffset || 0;

        const originalId = this.normalizeBookIdText(document.getElementById('edit-book-original-id')?.value || '');
        const editIdInput = document.getElementById('edit-book-id');
        let newId = this.normalizeBookIdText(editIdInput?.value || '');
        const editTitleInput = document.getElementById('edit-book-title');
        const title = this.normalizeBookTitle(editTitleInput?.value || '');
        if (editTitleInput && editTitleInput.value !== title) editTitleInput.value = title;
        const author = (document.getElementById('edit-book-author')?.value || '').trim();
        const coverUrl = (document.getElementById('edit-book-cover-url')?.value || '').trim();
        const bookUrl = (document.getElementById('edit-book-url')?.value || '').trim();
        const year = parseInt(document.getElementById('edit-book-year')?.value) || this.settings.defaultYear;
        const newCopies = parseInt(document.getElementById('edit-book-copies')?.value) || 1;
        const manualGenre = (document.getElementById('edit-book-genre-manual')?.value || '').trim();

        if (/^[ABCD]$/.test(newId)) {
            await this.refreshRemoteBookIdCache({ silent: true, force: false });
            const suggestedId = this.generateNextBookId(newId);
            if (!suggestedId) {
                this.showToast('無法產生下一個書碼', 'error');
                return;
            }
            newId = suggestedId;
        }

        if (editIdInput && editIdInput.value !== newId) {
            editIdInput.value = newId;
        }

        if (!originalId || !newId) {
            this.showToast('編輯失敗：缺少書碼', 'error');
            return;
        }
        if (!title) {
            this.showToast('請輸入書名', 'error');
            return;
        }

        // 驗證新書碼格式
        if (!this.bookIdPattern.test(newId)) {
            this.showToast('書碼格式錯誤：請用 A/B/C/D + 數字（例：D0001）', 'error');
            return;
        }

        // 如果書碼有變更，檢查新書碼是否已存在
        if (newId !== originalId) {
            await this.refreshRemoteBookIdCache({ silent: true, force: false });
            if (this.hasGoogleSheetBookId(newId)) {
                this.showToast(this.getGoogleSheetBookIdExistsMessage(newId), 'error', 8000);
                return;
            }
        }

        const book = this.books.find(b => b.id === originalId);
        if (!book) {
            this.showToast('書籍不存在', 'error');
            return;
        }

        if (!this.confirmSameTitleDifferentPrefix(title, newId, originalId)) {
            this.showToast('已取消編輯，請確認書名或書碼分類', 'info');
            return;
        }

        const borrowedCount = this.borrowedBooks.filter(b => b.bookId === originalId && !b.returnedAt).length;
        if (newCopies < borrowedCount) {
            this.showToast(`冊數不得小於已借出數量 (${borrowedCount})`, 'error');
            return;
        }

        // 更新書籍資訊
        const oldId = book.id;
        book.id = newId;
        book.title = title;
        book.author = author;
        book.coverUrl = coverUrl;
        book.bookUrl = bookUrl;
        book.genre = manualGenre || this.getGenreFromId(newId);
        book.year = year;
        book.copies = newCopies;
        book.availableCopies = newCopies - borrowedCount;
        book.updatedAt = Date.now();
        book.createdAt = book.createdAt || new Date(book.addedAt || Date.now()).toISOString();

        // 讀取使用者輸入的系列書名稱
        const seriesEl = document.getElementById('edit-book-series');
        const seriesName = (seriesEl?.value || '').trim();

        // 更新系列書名稱
        if (seriesName) {
            book.series = seriesName;

            // 如果這本書有多本（相同書名），自動套用套書名稱到其他相同書名的書籍
            const sameTitleBooks = this.books.filter(b => b.title === title && b.id !== originalId);
            if (sameTitleBooks.length > 0) {
                sameTitleBooks.forEach(sameBook => {
                    sameBook.series = seriesName;
                });
                this.showToast(`已自動套用套書名稱到 ${sameTitleBooks.length} 本相同書名的書籍`, 'info');
            }
        } else {
            // 如果使用者清空了系列書名稱，則移除此欄位
            delete book.series;

            // 如果這本書有多本（相同書名），自動清空其他相同書名的書籍的套書名稱
            const sameTitleBooks = this.books.filter(b => b.title === title && b.id !== originalId);
            if (sameTitleBooks.length > 0) {
                sameTitleBooks.forEach(sameBook => {
                    delete sameBook.series;
                });
                this.showToast(`已自動清空 ${sameTitleBooks.length} 本相同書名的書籍的套書名稱`, 'info');
            }
        }

        // 更新作者（自動套用到相同書名的書籍）
        if (author) {
            // 如果這本書有多本（相同書名），自動套用作者到其他相同書名的書籍
            const sameTitleBooks = this.books.filter(b => b.title === title && b.id !== originalId);
            if (sameTitleBooks.length > 0) {
                sameTitleBooks.forEach(sameBook => {
                    sameBook.author = author;
                });
                this.showToast(`已自動套用作者到 ${sameTitleBooks.length} 本相同書名的書籍`, 'info');
            }
        } else {
            // 如果使用者清空了作者，則清空其他相同書名的書籍的作者
            const sameTitleBooks = this.books.filter(b => b.title === title && b.id !== originalId);
            if (sameTitleBooks.length > 0) {
                sameTitleBooks.forEach(sameBook => {
                    sameBook.author = '';
                });
                this.showToast(`已自動清空 ${sameTitleBooks.length} 本相同書名的書籍的作者`, 'info');
            }
        }

        // 更新書碼列表
        if (Array.isArray(book.bookIds)) {
            const index = book.bookIds.indexOf(oldId);
            if (index > -1) {
                book.bookIds[index] = newId;
            }
            if (!book.bookIds.includes(newId)) {
                book.bookIds.unshift(newId);
            }
        } else {
            book.bookIds = [newId];
        }

        // 如果書碼有變更，更新所有相關借閱紀錄
        if (newId !== originalId) {
            this.borrowedBooks.forEach(borrowRecord => {
                if (borrowRecord.bookId === originalId) {
                    borrowRecord.bookId = newId;
                }
            });

            // 更新統計數據中的書碼
            if (this.stats && this.stats.categoryStats) {
                Object.keys(this.stats.categoryStats).forEach(category => {
                    const categoryStat = this.stats.categoryStats[category];
                    if (categoryStat.bookIds && categoryStat.bookIds.includes(originalId)) {
                        const index = categoryStat.bookIds.indexOf(originalId);
                        categoryStat.bookIds[index] = newId;
                    }
                });
            }
        }

        this.saveData();
        // 更新書單版本，讓快取失效
        this.updateBookListVersion();

        // 編輯書籍屬於動作變更，才觸發同步
        this.triggerSyncForAction('editBook');

        this.renderBooks();
        this.updateStats();

        const modal = document.getElementById('edit-book-modal');
        if (modal) modal.style.display = 'none';

        requestAnimationFrame(() => {
            window.scrollTo({
                top: preservedScrollY,
                left: preservedScrollX,
                behavior: 'auto'
            });
        });
        
        const message = newId !== originalId ? 
            `書籍已更新，書碼已從 ${originalId} 變更為 ${newId}` : 
            '書籍已更新';
        this.showToast(message, 'success');
    }

    async autoFillBookInfo({ titleInputId, authorInputId, yearInputId, coverInputId, allowGoogleBooks = true, silentNoResult = false }) {
        const titleInput = document.getElementById(titleInputId);
        const authorInput = document.getElementById(authorInputId);
        const yearInput = document.getElementById(yearInputId);
        const coverInput = coverInputId ? document.getElementById(coverInputId) : null;

        const title = (titleInput?.value || '').trim();

        if (!title) {
            this.showToast('請先輸入書名，系統會自動搜尋其他資料', 'warning');
            if (titleInput) titleInput.focus();
            return;
        }

        try {
            const isbn = this.extractIsbn(title);
            this.showToast(isbn ? '正在依 ISBN 搜尋作者、年份和封面...' : '正在依書名搜尋作者、年份和封面...', 'info');

            const info = isbn ? await this.lookupBookInfoByIsbn(isbn) : await this.lookupBookInfoByTitle(title, { allowGoogleBooks });

            if (!info) {
                if (!silentNoResult) this.showToast('找不到符合的書籍資料', 'warning');
                return;
            }

            const foundAuthors = Array.isArray(info.authors) ? info.authors.join('、') : '';
            const published = (info.publishedDate || '').trim();
            const year = published ? parseInt(published.slice(0, 4), 10) : NaN;
            const coverUrl = (
                info.imageLinks?.extraLarge ||
                info.imageLinks?.large ||
                info.imageLinks?.medium ||
                info.imageLinks?.thumbnail ||
                info.imageLinks?.smallThumbnail ||
                ''
            ).trim();

            let updatedCount = 0;
            if (authorInput && foundAuthors) authorInput.value = foundAuthors;
            if (authorInput && foundAuthors) updatedCount++;
            if (yearInput && Number.isFinite(year)) {
                yearInput.value = String(year);
                updatedCount++;
            }
            if (coverInput && coverUrl) {
                coverInput.value = coverUrl;
                updatedCount++;
            }

            if (updatedCount > 0) {
                this.showToast('已自動填入書名以外的書籍資料', 'success');
            } else {
                this.showToast('有找到資料，但沒有可自動填入的新欄位', 'info');
            }
        } catch (error) {
            const safeError = error || new Error('自動填入書籍資訊失敗');
            console.error('autoFillBookInfo error:', safeError);
            this.handleApiError(safeError, '自動填入書籍資訊失敗');
        }
    }

    scheduleAutoFillBookInfo(options) {
        const titleInput = document.getElementById(options.titleInputId);
        const authorInput = document.getElementById(options.authorInputId);
        const yearInput = document.getElementById(options.yearInputId);
        const coverInput = options.coverInputId ? document.getElementById(options.coverInputId) : null;
        const title = String(titleInput?.value || '').trim();

        if (title.length < 2) return;
        if (authorInput?.value?.trim() && yearInput?.value?.trim() && (!coverInput || coverInput.value.trim())) return;
        if (Date.now() < this.googleBooksCooldownUntil) return;

        const key = options.titleInputId;
        if (this.autoFillTimers.has(key)) {
            clearTimeout(this.autoFillTimers.get(key));
        }

        this.autoFillTimers.set(key, setTimeout(() => {
            this.autoFillTimers.delete(key);
            this.autoFillBookInfo({ ...options, allowGoogleBooks: false, silentNoResult: true });
        }, 1200));
    }

    async lookupBookInfoByTitle(title, options = {}) {
        const { allowGoogleBooks = false } = options;
        const key = String(title || '').trim().toLowerCase();
        if (!key) return null;

        const cached = this.bookLookupCache?.get(key);
        if (cached && Date.now() - cached.cachedAt < 30 * 60 * 1000) {
            return cached.info;
        }

        if (this.bookLookupInFlight?.has(key)) {
            return this.bookLookupInFlight.get(key);
        }

        const lookup = (async () => {
            let info = null;

            try {
                const openLibraryUrl = `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&limit=5&language=chi`;
                const openLibraryData = await this.enqueueApiRequest(async () => {
                    return await this.fetchWithRetry(openLibraryUrl, { retries: 1 });
                });
                const doc = openLibraryData?.docs?.[0];
                if (doc) {
                    info = {
                        authors: Array.isArray(doc.author_name) ? doc.author_name : [],
                        publishedDate: doc.first_publish_year ? String(doc.first_publish_year) : '',
                        imageLinks: doc.cover_i ? {
                            thumbnail: `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`,
                            smallThumbnail: `https://covers.openlibrary.org/b/id/${doc.cover_i}-S.jpg`
                        } : null
                    };
                }
            } catch (error) {
                console.warn('Open Library 查詢失敗，改查 Google Books:', error?.message || error);
            }

            if (!info && allowGoogleBooks && Date.now() >= this.googleBooksCooldownUntil) {
                const googleUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(`intitle:${title}`)}&maxResults=1&langRestrict=zh${this.getGoogleBooksApiKeyParam()}`;
                const googleData = await this.enqueueApiRequest(async () => {
                    return await this.fetchWithRetry(googleUrl, { retries: 1, cooldownOn429: true });
                });
                info = googleData?.items?.find(item => item?.volumeInfo)?.volumeInfo || null;
            }

            this.bookLookupCache.set(key, { info, cachedAt: Date.now() });
            return info;
        })().finally(() => {
            this.bookLookupInFlight.delete(key);
        });

        this.bookLookupInFlight.set(key, lookup);
        return lookup;
    }

    extractIsbn(value) {
        const cleaned = String(value || '').replace(/[-\s]/g, '');
        if (/^\d{13}$/.test(cleaned) && (cleaned.startsWith('978') || cleaned.startsWith('979'))) {
            return cleaned;
        }
        if (/^\d{9}[\dX]$/i.test(cleaned)) {
            return cleaned;
        }
        return null;
    }

    async lookupBookInfoByIsbn(isbn) {
        const cleanIsbn = String(isbn || '').replace(/[-\s]/g, '').toUpperCase();
        const key = `isbn:${cleanIsbn}`;
        if (!cleanIsbn) return null;

        const cached = this.bookLookupCache?.get(key);
        if (cached && Date.now() - cached.cachedAt < 30 * 60 * 1000) {
            return cached.info;
        }

        if (this.bookLookupInFlight?.has(key)) {
            return this.bookLookupInFlight.get(key);
        }

        const lookup = (async () => {
            const apiUrl = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(cleanIsbn)}${this.getGoogleBooksApiKeyParam()}`;
            const data = await this.enqueueApiRequest(async () => {
                return await this.fetchWithRetry(apiUrl, { retries: 1, cooldownOn429: true });
            });
            const info = data?.items?.find(item => item?.volumeInfo)?.volumeInfo || null;
            this.bookLookupCache.set(key, { info, cachedAt: Date.now() });
            return info;
        })().finally(() => {
            this.bookLookupInFlight.delete(key);
        });

        this.bookLookupInFlight.set(key, lookup);
        return lookup;
    }

    // 從網址或書名自動搜尋書籍資料並填入作者和年份
    async fetchUrlMetadata(url, authorInputId, yearInputId) {
        try {
            console.log('fetchUrlMetadata called with:', url, authorInputId, yearInputId);
            this.showToast('正在搜尋書籍資料...', 'info');

            const authorInput = document.getElementById(authorInputId);
            const yearInput = document.getElementById(yearInputId);
            const titleInputId = authorInputId === 'book-author' ? 'book-title' : 'edit-book-title';
            const coverInputId = authorInputId === 'book-author' ? 'book-cover-url' : 'edit-book-cover-url';
            const titleInput = document.getElementById(titleInputId);
            const coverInput = document.getElementById(coverInputId);

            if (!url) {
                this.showToast('請輸入網址', 'warning');
                return;
            }

            const webAppUrl = this.getGoogleWebAppUrl();
            if (webAppUrl) {
                const result = await this.callGoogleApi(webAppUrl, {
                    action: 'lookupBookUrl',
                    url,
                    apiKey: this.getGoogleBooksApiKey()
                }, 'GET').catch((error) => {
                    console.warn('Apps Script URL metadata lookup failed:', error);
                    return null;
                });

                console.log('Apps Script result:', result);

                if (result && result.ok === false && String(result.error || '').includes('Unknown action')) {
                    this.showToast('Google Apps Script 還不是最新版，請重新部署後再貼網址', 'warning', 8000);
                    return;
                }

                const data = result?.ok ? result.data : null;
                let updatedCount = 0;
                if (data) {
                    if (titleInput && data.title && !titleInput.value.trim()) {
                        titleInput.value = data.title;
                        updatedCount++;
                    }
                    if (authorInput && data.author) {
                        authorInput.value = data.author;
                        updatedCount++;
                    }
                    if (yearInput && data.year) {
                        yearInput.value = String(data.year).match(/\d{4}/)?.[0] || data.year;
                        updatedCount++;
                    }
                    if (coverInput && data.coverUrl && !coverInput.value.trim()) {
                        coverInput.value = data.coverUrl;
                        updatedCount++;
                    }
                }

                if (updatedCount > 0) {
                    this.showToast('已從網頁自動填入作者和出版年份', 'success');
                    return;
                }
            }

            // 先嘗試從網址中提取書名（針對博客來等書店網站）
            let bookTitle = '';

            // 針對博客來網址提取書名
            if (url.includes('books.com.tw')) {
                const titleMatch = url.match(/products\/([^\/\?]+)/);
                if (titleMatch && titleMatch[1]) {
                    bookTitle = decodeURIComponent(titleMatch[1]).replace(/-/g, ' ');
                }
            }
            // 針對誠品網址提取書名
            else if (url.includes('eslite.com')) {
                const titleMatch = url.match(/product\/([^\/\?]+)/);
                if (titleMatch && titleMatch[1]) {
                    bookTitle = decodeURIComponent(titleMatch[1]).replace(/-/g, ' ');
                }
            }
            // 針對讀冊網址提取書名
            else if (url.includes('readmoo.com')) {
                const titleMatch = url.match(/book\/([^\/\?]+)/);
                if (titleMatch && titleMatch[1]) {
                    bookTitle = decodeURIComponent(titleMatch[1]).replace(/-/g, ' ');
                }
            }
            // 其他網站，嘗試從 URL 路徑提取最後一段作為書名
            else {
                const urlParts = url.split('/').filter(Boolean);
                if (urlParts.length > 0) {
                    const lastPart = urlParts[urlParts.length - 1].split('?')[0];
                    bookTitle = decodeURIComponent(lastPart).replace(/[-_]/g, ' ').replace(/\.\w+$/, '');
                }
            }

            console.log('Extracted book title:', bookTitle);

            // 博客來、誠品、讀冊的網址最後一段通常是商品編號，不是書名
            const looksLikeProductId = /^\d+$/.test(bookTitle) || /^CN\d+$/i.test(bookTitle);
            if (looksLikeProductId) {
                this.showToast('此網址只包含商品編號，無法直接解析書名；請手動輸入書名，或設定 Google Apps Script 自動抓取', 'warning', 8000);
                return;
            }

            if (!bookTitle || bookTitle.length < 2) {
                this.showToast('無法從網址提取書名，請手動輸入書名', 'warning');
                return;
            }

            if (titleInput && !titleInput.value) {
                titleInput.value = bookTitle;
            }

            // 用書名搜尋作者、年份、封面（支援 Google Books API key）
            const info = await this.lookupBookInfoByTitle(bookTitle);
            console.log('lookupBookInfoByTitle result:', info);

            let updatedCount = 0;

            if (info) {
                const authors = Array.isArray(info.authors) ? info.authors.join('、') : '';
                const published = (info.publishedDate || '').trim();
                const year = published ? parseInt(published.slice(0, 4), 10) : NaN;
                const coverUrl = (
                    info.imageLinks?.extraLarge ||
                    info.imageLinks?.large ||
                    info.imageLinks?.medium ||
                    info.imageLinks?.thumbnail ||
                    info.imageLinks?.smallThumbnail ||
                    ''
                ).trim();

                if (authorInput && authors) {
                    authorInput.value = authors;
                    updatedCount++;
                    console.log('Updated author to:', authors);
                }
                if (yearInput && Number.isFinite(year)) {
                    yearInput.value = String(year);
                    updatedCount++;
                    console.log('Updated year to:', year);
                }
                if (coverInput && coverUrl && !coverInput.value.trim()) {
                    coverInput.value = coverUrl;
                    updatedCount++;
                    console.log('Updated cover to:', coverUrl);
                }
            }

            if (updatedCount > 0) {
                this.showToast('已自動填入書籍資料', 'success');
            } else {
                this.showToast('找不到相關書籍資料', 'warning');
            }
        } catch (error) {
            const safeError = error || new Error('搜尋書籍資料失敗');
            console.error('fetchUrlMetadata error:', safeError);
            this.handleApiError(safeError, '搜尋書籍資料失敗');
        }
    }

    // API 請求隊列處理
    async enqueueApiRequest(requestFn) {
        return new Promise((resolve, reject) => {
            this.apiRequestQueue.push({ requestFn, resolve, reject });
            this.processApiQueue();
        });
    }

    async processApiQueue() {
        if (this.apiRequestInProgress || this.apiRequestQueue.length === 0) return;

        this.apiRequestInProgress = true;

        while (this.apiRequestQueue.length > 0) {
            const { requestFn, resolve, reject } = this.apiRequestQueue.shift();

            // 確保請求間隔
            const now = Date.now();
            const timeSinceLastRequest = now - this.lastApiRequestTime;
            if (timeSinceLastRequest < this.apiRequestDelay) {
                const waitTime = this.apiRequestDelay - timeSinceLastRequest;
                await new Promise(r => setTimeout(r, waitTime));
            }

            this.lastApiRequestTime = Date.now();

            try {
                const result = await requestFn();
                resolve(result);
            } catch (error) {
                reject(error || new Error('API 請求失敗，未知錯誤'));
            }
        }

        this.apiRequestInProgress = false;
    }

    // 帶重試與指數退避的 fetch
    async fetchWithRetry(url, options = {}) {
        const {
            retries = this.apiRetryConfig.maxRetries,
            cooldownOn429 = false,
            cooldownMs = 10 * 60 * 1000,
            ...fetchOptions
        } = options || {};
        let lastError;
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const res = await fetch(url, fetchOptions);
                if (res.ok) return await res.json();
                if (res.status === 429) {
                    if (cooldownOn429) {
                        this.googleBooksCooldownUntil = Date.now() + cooldownMs;
                        console.warn(`Google Books API 429，暫停自動查詢 ${Math.ceil(cooldownMs / 60000)} 分鐘`);
                        return null;
                    }

                    // 429: Too Many Requests，使用指數退避策略
                    const delay = Math.min(
                        this.apiRetryConfig.baseDelay * Math.pow(2, attempt - 1),
                        this.apiRetryConfig.maxDelay
                    );
                    console.warn(`API 429，等待 ${delay}ms 後重試 (${attempt}/${retries})`);
                    
                    // 在第一次 429 錯誤時顯示用戶提示
                    if (attempt === 1) {
                        this.showToast('API 請求過於頻繁，正在自動重試...', 'warning', 3000);
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
                throw new Error(`HTTP ${res.status}`);
            } catch (err) {
                lastError = err;
                if (attempt === retries) break;
                const delay = Math.min(
                    this.apiRetryConfig.baseDelay * Math.pow(2, attempt - 1),
                    this.apiRetryConfig.maxDelay
                );
                console.warn(`API 請求失敗，等待 ${delay}ms 後重試 (${attempt}/${retries})`, err?.message || err);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        // 確保不會拋出 undefined
        if (!lastError) {
            lastError = new Error('API 請求失敗，未知錯誤');
        }
        throw lastError;
    }

    // 統一的 API 錯誤處理
    handleApiError(error, fallbackMessage = 'API 請求失敗') {
        const message = error?.message || '';
        if (message.includes('429')) {
            this.showToast('Google Books API 請求過多，建議稍後再試', 'warning', 8000);
        } else if (message.includes('499') || message.includes('antivirus')) {
            this.showToast('請求被防毒軟體阻擋，請暫時停用防毒或換網路後重試', 'error', 6000);
        } else if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
            this.showToast('網路連線異常，請檢查網路狀態後重試', 'error', 6000);
        } else if (message.includes('timeout')) {
            this.showToast('請求超時，請稍後重試', 'error', 5000);
        } else {
            console.error('API 錯誤詳情:', error);
            this.showToast(fallbackMessage, 'error', 5000);
        }
    }

    deleteBook(bookId) {
        if (!this.requireAdmin('刪除書籍')) return;

        // 查找書籍（包括合併書籍中的個別書籍）
        let targetBook = this.books.find(b => b.id === bookId);
        let allRelatedBooks = [];

        if (targetBook) {
            // 如果是普通書籍，查找所有相同書名的書籍
            const sameTitleBooks = this.books.filter(b => 
                this.normalizeTitle(b.title) === this.normalizeTitle(targetBook.title)
            );
            allRelatedBooks = sameTitleBooks;
        } else {
            // 如果直接找不到，可能在合併書籍中，查找所有相關書籍
            const mergedBooks = this.mergeBooksByTitle(this.books);
            const mergedBook = mergedBooks.find(mb => 
                mb.bookIds && mb.bookIds.includes(bookId)
            );
            
            if (mergedBook) {
                allRelatedBooks = mergedBook.mergedBooks || [];
                targetBook = allRelatedBooks.find(b => b.id === bookId);
            }
        }

        if (!targetBook || allRelatedBooks.length === 0) {
            this.showToast('書籍不存在', 'error');
            return;
        }

        // 如果有多本相同書名的書籍，顯示選擇畫面
        if (allRelatedBooks.length > 1) {
            this.showDeleteSelectionModal(allRelatedBooks, targetBook.id);
        } else {
            // 只有一本書，直接刪除
            this.confirmDeleteBook(targetBook);
        }
    }

    // 顯示刪除書籍選擇模態框
    showDeleteSelectionModal(books, selectedBookId) {
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.style.display = 'block';
        
        const booksList = books.map(book => {
            const borrowedCount = this.borrowedBooks.filter(b => b.bookId === book.id && !b.returnedAt).length;
            const canDelete = borrowedCount === 0;
            
            return `
                <div class="book-selection-item ${book.id === selectedBookId ? 'selected' : ''} ${!canDelete ? 'disabled' : ''}" 
                     onclick="${canDelete ? `library.selectBookForDelete('${book.id}')` : ''}">
                    <div class="book-selection-info">
                        <div class="book-selection-id">書碼：${book.id}</div>
                        <div class="book-selection-details">
                            <div class="book-selection-author">作者：${book.author || '未知'}</div>
                            <div class="book-selection-year">出版年份：${book.year || '未知'}</div>
                            <div class="book-selection-copies">冊數：${book.copies || 1}</div>
                            <div class="book-selection-available">可借：${book.availableCopies || 0}</div>
                        </div>
                        ${borrowedCount > 0 ? 
                            `<div class="book-selection-warning">
                                <i class="fas fa-exclamation-triangle"></i> 
                                有 ${borrowedCount} 本未歸還，無法刪除
                            </div>` : 
                            ''
                        }
                    </div>
                    <div class="book-selection-cover">
                        ${book.coverUrl ? 
                            `<img src="${book.coverUrl}" alt="${book.title}" onerror="this.style.display='none'">` : 
                            '<div class="no-cover">無封面</div>'
                        }
                    </div>
                    ${book.id === selectedBookId ? 
                        '<div class="book-selection-badge">目前選擇</div>' : 
                        (canDelete ? 
                            '<div class="book-selection-select-btn book-selection-delete-btn">刪除</div>' :
                            '<div class="book-selection-disabled-btn">無法刪除</div>'
                        )
                    }
                </div>
            `;
        }).join('');
        
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 600px;">
                <div class="modal-header">
                    <h3><i class="fas fa-trash"></i> 選擇要刪除的書籍</h3>
                    <span class="close" onclick="this.closest('.modal').remove()">&times;</span>
                </div>
                <div class="modal-body">
                    <p class="selection-hint selection-hint-danger">
                        <i class="fas fa-exclamation-triangle"></i>
                        找到多本相同書名的書籍，請選擇要刪除的具體書籍：
                    </p>
                    <div class="book-selection-list">
                        ${booksList}
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">
                        <i class="fas fa-times"></i> 取消
                    </button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
    }

    // 選擇書籍進行刪除
    selectBookForDelete(bookId) {
        const book = this.books.find(b => b.id === bookId);
        if (!book) {
            this.showToast('書籍不存在', 'error');
            return;
        }
        
        // 關閉選擇模態框
        document.querySelector('.modal').remove();
        
        // 確認刪除
        this.confirmDeleteBook(book);
    }

    // 確認刪除書籍
    confirmDeleteBook(book) {
        const borrowedCount = this.borrowedBooks.filter(b => b.bookId === book.id && !b.returnedAt).length;
        if (borrowedCount > 0) {
            this.showToast('此書籍仍有未歸還借閱，無法刪除', 'error');
            return;
        }

        if (!confirm(`確定要刪除「${book.title}」（書碼：${book.id}）嗎？\n\n此操作無法復原！`)) return;

        this.books = this.books.filter(b => b.id !== book.id);
        this.saveData();
        
        // 更新書單版本，讓快取失效
        this.updateBookListVersion();
        
        // 刪除書籍屬於動作變更，才觸發同步
        this.triggerSyncForAction('deleteBook');
        
        this.renderBooks();
        this.updateStats();
        this.showToast(`書籍「${book.title}」已刪除`, 'success');
    }

    // 渲染借閱記錄
    renderBorrowedBooks(borrowedBooksToRender = null) {
        const container = document.getElementById('borrowed-container');

        if (!this.currentUser) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-sign-in-alt"></i>
                    <h3>請先登入</h3>
                    <p>登入後即可查看借閱記錄</p>
                </div>
            `;
            this.updateBorrowedStatsSummary();
            return;
        }

        // 如果沒有傳入要渲染的書籍，使用預設邏輯
        let borrowedBooks = borrowedBooksToRender;
        if (!borrowedBooks) {
            // 根據使用者角色決定顯示範圍
            if (this.hasAdminAccess()) {
                // 管理者（主要管理者和副管理者）可以看到所有借閱記錄
                borrowedBooks = [...this.borrowedBooks];
            } else {
                // 其他使用者只能看到自己的完整借閱記錄
                borrowedBooks = this.borrowedBooks.filter(
                    b => b.userId === this.currentUser.username
                );
            }
        }

        // 更新統計摘要
        this.updateBorrowedStatsSummary(borrowedBooks);

        // 如果已經在 searchBorrowedBooks 中排序過，就不要再排序
        if (!borrowedBooksToRender) {
            // 按借閱日期降序排列（最新的在最上面）
            borrowedBooks.sort((a, b) => {
                const dateA = new Date(a.borrowDate || 0).getTime();
                const dateB = new Date(b.borrowDate || 0).getTime();
                return dateB - dateA;
            });
        }

        if (borrowedBooks.length === 0 && !this.hasAdminAccess()) {
            const message = this.hasAdminAccess()
                ? '目前沒有借閱記錄'
                : '您目前沒有借閱記錄';
            const subMessage = this.hasAdminAccess()
                ? '目前沒有任何借閱資料'
                : '您還沒有借閱資料';

            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-book"></i>
                    <h3>${message}</h3>
                    <p>${subMessage}</p>
                </div>
            `;
            return;
        }

        let headerHtml = '';
        if (this.hasAdminAccess()) {
            headerHtml = `
                <div style="margin-bottom: 16px; text-align: right;">
                    <button id="set-all-due-dates-btn" class="btn btn-warning btn-small">
                        <i class="fas fa-calendar-alt"></i> 設定全部還書時間
                    </button>
                </div>
            `;
        }

        const recordsHtml = this.hasAdminAccess()
            ? this.createAdminBorrowedGroupsHtml(borrowedBooks)
            : borrowedBooks.map(record => this.createBorrowedItem(record)).join('');

        container.innerHTML = headerHtml + recordsHtml;

        // 動態綁定按鈕事件（避免快取問題）
        const setBtn = document.getElementById('set-all-due-dates-btn');
        if (setBtn) {
            setBtn.addEventListener('click', () => this.setAllDueDates());
        }
    }

    getBorrowedRecordStatus(record) {
        if (record?.returnedAt) return 'returned';
        if (record?.dueDate && new Date(record.dueDate) < new Date()) return 'overdue';
        return 'active';
    }

    createAdminBorrowedGroupsHtml(records) {
        const groups = [
            { key: 'active', title: '借閱中', icon: 'fa-book-reader' },
            { key: 'overdue', title: '逾期', icon: 'fa-triangle-exclamation' },
            { key: 'returned', title: '已歸還', icon: 'fa-circle-check' }
        ];

        const counts = groups.reduce((acc, group) => {
            acc[group.key] = records.filter(record => this.getBorrowedRecordStatus(record) === group.key).length;
            return acc;
        }, {});
        const activeTab = groups.some(group => group.key === this.adminBorrowedTab)
            ? this.adminBorrowedTab
            : 'active';
        const activeGroup = groups.find(group => group.key === activeTab) || groups[0];
        const visibleRecords = records.filter(record => this.getBorrowedRecordStatus(record) === activeGroup.key);

        const tabsHtml = groups.map(group => `
            <button type="button" class="borrowed-tab ${activeTab === group.key ? 'active' : ''}" onclick="library.switchAdminBorrowedTab('${group.key}')">
                <i class="fas ${group.icon}"></i>
                <span>${group.title}</span>
                <b>${counts[group.key] || 0}</b>
            </button>
        `).join('');

        const listHtml = visibleRecords.length > 0
            ? visibleRecords.map(record => this.createBorrowedItem(record)).join('')
            : `
                <div class="empty-state borrowed-tab-empty">
                    <i class="fas ${activeGroup.icon}"></i>
                    <h3>目前沒有${activeGroup.title}紀錄</h3>
                </div>
            `;

        return `
            <div class="borrowed-tabs">${tabsHtml}</div>
            <section class="borrowed-group borrowed-group-${activeGroup.key}">
                <div class="borrowed-group-header">
                    <h3><i class="fas ${activeGroup.icon}"></i> ${activeGroup.title}</h3>
                    <span>${visibleRecords.length} 筆</span>
                </div>
                <div class="borrowed-group-list">
                    ${listHtml}
                </div>
            </section>
        `;
    }

    switchAdminBorrowedTab(tabKey) {
        this.adminBorrowedTab = tabKey;
        const statusFilter = document.getElementById('borrowed-filter-status');
        if (statusFilter) {
            statusFilter.value = tabKey === 'active' ? 'borrowed' : tabKey;
        }
        this.searchBorrowedBooks();
    }

    // 建立借閱項目
    createBorrowedItem(record) {
        const borrowDate = record.borrowDate ? new Date(record.borrowDate) : null;
        const dueDate = record.dueDate ? new Date(record.dueDate) : null;
        const returnedDate = record.returnedAt ? new Date(record.returnedAt) : null;
        const now = new Date();
        const daysLeft = dueDate ? Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24)) : null;
        const isReturned = Boolean(record.returnedAt);
        const isOverdue = !isReturned && dueDate && dueDate < now;
        const statusText = isReturned ? '已歸還' : (isOverdue ? '逾期未還' : '借閱中');
        const statusClass = isReturned ? 'returned' : (isOverdue ? 'overdue' : 'active');
        const formatDate = (date) => date && !isNaN(date.getTime()) ? date.toLocaleDateString('zh-TW') : '—';
        const book = this.books.find(b => b.id === record.bookId);
        const coverUrl = book?.coverUrl || book?.coverImage || '';
        const coverHtml = this.isAllowedCoverUrl(coverUrl)
            ? `<img src="${this.escapeHtml(coverUrl)}" alt="${this.escapeHtml(record.bookTitle || '書本封面')}" referrerpolicy="no-referrer" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
               <div class="borrowed-cover-placeholder" style="display:none;"><i class="fas fa-book"></i></div>`
            : `<div class="borrowed-cover-placeholder"><i class="fas fa-book"></i></div>`;

        return `
            <div class="borrowed-item borrowed-status-${statusClass}">
                <div class="borrowed-cover" onclick="library.showBookQuickPanel('${this.escapeHtml(record.bookId)}')" style="cursor: pointer;" title="查看書籍資訊">
                    ${coverHtml}
                </div>
                <div class="borrowed-info">
                    <div class="borrowed-title">
                        ${this.escapeHtml(record.bookTitle || '未命名書籍')}
                        <span class="borrowed-status-badge ${statusClass}">${statusText}</span>
                    </div>
                    <div class="borrowed-details">
                        <div><i class="fas fa-barcode"></i> 書碼：${this.escapeHtml(record.bookId || '—')}${record.copyNo ? ` - 第 ${this.escapeHtml(String(record.copyNo))} 冊` : ''}</div>
                        <div><i class="fas fa-user"></i> 借閱者：${this.escapeHtml(record.userId || '—')}</div>
                        <div><i class="fas fa-calendar-plus"></i> 借閱日期：${formatDate(borrowDate)}</div>
                        <div><i class="fas fa-calendar-check"></i> 應還日期：${formatDate(dueDate)}</div>
                        <div><i class="fas fa-calendar-day"></i> 歸還日期：${formatDate(returnedDate)}</div>
                        ${!isReturned && daysLeft !== null ? `<div><i class="fas fa-clock"></i> ${isOverdue ? `已逾期 ${Math.abs(daysLeft)} 天` : `剩餘 ${daysLeft} 天`}</div>` : ''}
                    </div>
                </div>
                <div class="borrowed-actions">
                    ${!isReturned && this.currentUser.username === 'sindy16872000' ? `
                    <button class="btn btn-info btn-small" onclick="library.adjustDueDate('${record.id}')">
                        <i class="fas fa-calendar-alt"></i> 調整還書時間
                    </button>` : ''}
                    ${!isReturned ? `
                    <button class="btn btn-success btn-small" onclick="library.returnBook('${record.id}')">
                        <i class="fas fa-undo"></i> 歸還
                    </button>` : ''}
                </div>
            </div>
        `;
    }

    // 調整單筆借閱的還書時間（僅限 sindy16872000）
    adjustDueDate(borrowId) {
        if (this.currentUser.username !== 'sindy16872000') {
            this.showToast('無此權限', 'error');
            return;
        }

        const record = this.borrowedBooks.find(b => b.id === borrowId);
        if (!record || record.returnedAt) {
            this.showToast('借閱記錄不存在或已歸還', 'error');
            return;
        }

        const input = window.prompt(`請輸入要幾天後歸還（目前：${new Date(record.dueDate).toLocaleDateString('zh-TW')}）`, '7');
        if (input === null) return;

        const days = parseInt(String(input).trim(), 10);
        if (!Number.isFinite(days) || days < 0) {
            this.showToast('請輸入有效的天數（0 或正整數）', 'error');
            return;
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const newDate = new Date(today.getTime() + days * 24 * 60 * 60 * 1000);

        record.dueDate = newDate.toISOString();

        this.saveData();
        this.renderBorrowedBooks();
        this.showToast(`已將「${record.bookTitle}」的還書時間設為 ${days} 天後（${newDate.toLocaleDateString('zh-TW')}）`, 'success');
    }

    // 批量設定所有借閱的還書時間（僅限 sindy16872000）
    setAllDueDates() {
        if (this.currentUser.username !== 'sindy16872000') {
            this.showToast('無此權限', 'error');
            return;
        }

        const input = window.prompt('請輸入要幾天後歸還（例如：7）', '7');
        if (input === null) return;

        const days = parseInt(String(input).trim(), 10);
        if (!Number.isFinite(days) || days < 0) {
            this.showToast('請輸入有效的天數（0 或正整數）', 'error');
            return;
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const newDate = new Date(today.getTime() + days * 24 * 60 * 60 * 1000);

        const updated = this.borrowedBooks.filter(b => !b.returnedAt).map(b => {
            b.dueDate = newDate.toISOString();
            return b;
        });

        if (updated.length === 0) {
            this.showToast('沒有待更新的借閱記錄', 'info');
            return;
        }

        this.saveData();
        this.renderBorrowedBooks();
        this.showToast(`已將 ${updated.length} 筆借閱的還書時間設為 ${days} 天後（${newDate.toLocaleDateString('zh-TW')}）`, 'success');
    }

    // 切換設定標籤頁
    switchSettingsTab(tabName) {
        // 移除所有標籤的 active 狀態
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

        // 啟用選中的標籤
        const activeBtn = document.querySelector(`.tab-btn[onclick*="${tabName}"]`);
        const activeContent = document.getElementById(`${tabName}-settings`);
        if (activeBtn) activeBtn.classList.add('active');
        if (activeContent) activeContent.classList.add('active');

        // 如果切換到副管理者標籤，渲染副管理者列表
        if (tabName === 'sub-admin') {
            this.renderSubAdminList();
        }
    }

    // 自動補齊書籍空白資料
    async autoFillBookData() {
        if (!this.requireAdmin('資料補齊')) return;

        const url = this.getGoogleWebAppUrl();
        if (!url) {
            this.showToast('請先設定 Google Sheets 同步網址', 'error');
            return;
        }

        const limitInput = document.getElementById('auto-fill-limit');
        const limit = limitInput ? Number(limitInput.value) || 10 : 10;

        const resultBox = document.getElementById('auto-fill-result');
        if (resultBox) {
            resultBox.style.display = 'block';
            resultBox.innerHTML = '<p><i class="fas fa-spinner fa-spin"></i> 正在補齊書籍資料...</p>';
        }

        try {
            this.showToast('正在補齊書籍資料...', 'info');

            const response = await fetch(url, {
                method: 'POST',
                body: JSON.stringify({
                    action: 'autoFillBookData',
                    options: { limit }
                })
            });

            const result = await response.json().catch(() => null);
            if (!response.ok || !result || !result.ok) {
                throw new Error('補齊失敗：' + (result?.error || '未知錯誤'));
            }

            const data = result.result || {};
            const message = data.message || '補齊完成';

            this.showToast(message, data.success > 0 ? 'success' : 'warning');

            if (resultBox) {
                let html = `
                    <div class="result-summary">
                        <p><strong>${message}</strong></p>
                        <ul>
                            <li>成功補齊：${data.success} 本</li>
                            <li>跳過：${data.skipped} 本</li>
                            <li>錯誤：${data.errors} 本</li>
                        </ul>
                    </div>
                `;

                if (data.errorDetails && data.errorDetails.length > 0) {
                    html += '<div class="error-details"><h4>錯誤詳情：</h4><ul>';
                    data.errorDetails.forEach(err => {
                        html += `<li>${err.id || err.title || '未知'}: ${err.error}</li>`;
                    });
                    html += '</ul></div>';
                }

                resultBox.innerHTML = html;
            }

            // 補齊後重新載入資料
            if (data.success > 0) {
                setTimeout(() => {
                    this.pullFromGoogleSheets({ silent: true, protectEmpty: true, closeModal: false });
                }, 2000);
            }
        } catch (error) {
            console.error('補齊失敗:', error);
            this.showToast('補齊失敗：' + error.message, 'error');

            if (resultBox) {
                resultBox.innerHTML = `<p class="error"><i class="fas fa-exclamation-circle"></i> 補齊失敗：${error.message}</p>`;
            }
        }
    }

    // 顯示新增副管理者模態框
    showAddSubAdminModal() {
        if (!this.requireSuperAdmin('新增副管理者')) return;

        const modal = document.getElementById('sub-admin-modal');
        const form = document.getElementById('sub-admin-form');
        const usernameEl = document.getElementById('sub-admin-username');

        if (form) form.reset();
        if (usernameEl) usernameEl.value = '';

        if (modal) modal.style.display = 'block';
    }

    // 新增副管理者
    handleAddSubAdmin(e) {
        e.preventDefault();
        if (!this.requireSuperAdmin('新增副管理者')) return;

        const usernameEl = document.getElementById('sub-admin-username');
        const username = usernameEl?.value?.trim();

        if (!username) {
            this.showToast('請輸入副管理者名稱', 'error');
            return;
        }

        // 檢查是否已存在
        if (this.settings.subAdmins?.find(sa => sa.username === username)) {
            this.showToast('此副管理者已存在', 'error');
            return;
        }

        // 檢查是否與主要管理者相同
        if (username === this.adminUsername) {
            this.showToast('不能將主要管理者設為副管理者', 'error');
            return;
        }

        // 新增副管理者
        if (!this.settings.subAdmins) {
            this.settings.subAdmins = [];
        }
        this.settings.subAdmins.push({
            username: username,
            createdAt: new Date().toISOString()
        });

        this.saveData();
        this.renderSubAdminList();

        // 關閉模態框
        const modal = document.getElementById('sub-admin-modal');
        if (modal) modal.style.display = 'none';

        this.showToast(`副管理者 ${username} 新增成功`, 'success');
    }

    // 刪除副管理者
    deleteSubAdmin(username) {
        if (!this.requireSuperAdmin('刪除副管理者')) return;

        if (!confirm(`確定要刪除副管理者 ${username} 嗎？`)) {
            return;
        }

        this.settings.subAdmins = this.settings.subAdmins.filter(sa => sa.username !== username);
        this.saveData();
        this.renderSubAdminList();

        this.showToast(`副管理者 ${username} 已刪除`, 'success');
    }

    // 渲染副管理者列表
    renderSubAdminList() {
        const container = document.getElementById('sub-admin-list');
        if (!container) return;

        const subAdmins = this.settings.subAdmins || [];

        if (subAdmins.length === 0) {
            container.innerHTML = '<div class="empty-state"><i class="fas fa-user-shield"></i><h3>沒有副管理者</h3><p>目前沒有設定任何副管理者</p></div>';
            return;
        }

        let html = '<div class="sub-admin-list">';
        subAdmins.forEach((subAdmin, index) => {
            html += `
                <div class="sub-admin-item">
                    <div class="sub-admin-info">
                        <i class="fas fa-user-shield"></i>
                        <span class="sub-admin-name">${this.escapeHtml(subAdmin.username)}</span>
                        <span class="sub-admin-date">新增於 ${new Date(subAdmin.createdAt).toLocaleDateString('zh-TW')}</span>
                    </div>
                    <button class="btn btn-danger btn-sm" onclick="library.deleteSubAdmin('${this.escapeHtml(subAdmin.username)}')">
                        <i class="fas fa-trash"></i> 刪除
                    </button>
                </div>
            `;
        });
        html += '</div>';

        container.innerHTML = html;
    }

    // 顯示新增使用者借閱時間設定模態框
    showAddUserLoanModal() {
        if (!this.requireAdmin('使用者借閱時間設定')) return;
        this.normalizeUserLoanSettings();

        const modal = document.getElementById('user-loan-modal');
        const form = document.getElementById('user-loan-form');
        const editingIndex = document.getElementById('user-loan-editing-index');
        const username = document.getElementById('user-loan-username');
        const days = document.getElementById('user-loan-days');
        const reason = document.getElementById('user-loan-reason');
        const deleteBtn = document.getElementById('delete-user-loan-btn');

        if (form) form.reset();
        if (editingIndex) editingIndex.value = '';
        if (username) username.value = '';
        if (days) days.value = '';
        if (reason) reason.value = '';
        if (deleteBtn) deleteBtn.style.display = 'none';

        if (modal) modal.style.display = 'block';
        setTimeout(() => {
            if (username) username.focus();
        }, 0);
    }

    // 搜尋使用者借閱時間設定
    searchUserLoanSettings() {
        this.renderUserLoanSettingsList();
    }

    renderUserLoanSettingsList() {
        const container = document.getElementById('user-loan-list');
        if (!container) return;

        this.normalizeUserLoanSettings();

        const term = String(document.getElementById('user-loan-search')?.value || '').trim().toLowerCase();
        const list = this.settings.userLoanSettings;

        const filtered = term
            ? list.filter(x => String(x.username || '').toLowerCase().includes(term))
            : list;

        if (filtered.length === 0) {
            container.innerHTML = `
                <div class="empty-state" style="padding: 12px;">
                    <i class="fas fa-user-clock"></i>
                    <h3>沒有設定</h3>
                    <p>可在此為特定使用者指定不同的借閱天數</p>
                </div>
            `;
            return;
        }

        container.innerHTML = filtered.map(item => {
            const idx = list.findIndex(x => x.username === item.username);
            const reason = item.reason ? `<div style="opacity: .85; margin-top: 4px;">原因：${this.escapeHtml(item.reason)}</div>` : '';
            return `
                <div class="borrowed-item" style="cursor: pointer;" onclick="library.openUserLoanSetting(${idx})">
                    <div class="borrowed-info">
                        <div class="borrowed-title">${this.escapeHtml(item.username)}</div>
                        <div class="borrowed-details">
                            <div><i class="fas fa-calendar-days"></i> 借閱天數：${item.days} 天</div>
                            ${reason}
                        </div>
                    </div>
                    <div class="borrowed-actions">
                        <button class="btn btn-info btn-small" onclick="event.stopPropagation(); library.openUserLoanSetting(${idx})">
                            <i class="fas fa-pen"></i> 編輯
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    }

    openUserLoanSetting(index) {
        if (!this.requireAdmin('使用者借閱時間設定')) return;
        this.normalizeUserLoanSettings();

        const idx = Number(index);
        if (!Number.isFinite(idx) || idx < 0 || idx >= this.settings.userLoanSettings.length) {
            this.showToast('設定項目不存在', 'error');
            return;
        }

        const item = this.settings.userLoanSettings[idx];

        const modal = document.getElementById('user-loan-modal');
        const editingIndex = document.getElementById('user-loan-editing-index');
        const username = document.getElementById('user-loan-username');
        const days = document.getElementById('user-loan-days');
        const reason = document.getElementById('user-loan-reason');
        const deleteBtn = document.getElementById('delete-user-loan-btn');

        if (editingIndex) editingIndex.value = String(idx);
        if (username) username.value = item.username;
        if (days) days.value = String(item.days);
        if (reason) reason.value = item.reason || '';
        if (deleteBtn) deleteBtn.style.display = '';

        if (modal) modal.style.display = 'block';
        setTimeout(() => {
            if (days) days.focus();
        }, 0);
    }

    handleSaveUserLoanSetting(e) {
        e.preventDefault();
        if (!this.requireAdmin('使用者借閱時間設定')) return;

        this.normalizeUserLoanSettings();

        const editingIndexEl = document.getElementById('user-loan-editing-index');
        const usernameEl = document.getElementById('user-loan-username');
        const daysEl = document.getElementById('user-loan-days');
        const reasonEl = document.getElementById('user-loan-reason');

        const username = String(usernameEl?.value || '').trim();
        const days = parseInt(String(daysEl?.value || '').trim(), 10);
        const reason = String(reasonEl?.value || '').trim();

        if (!username) {
            this.showToast('請輸入使用者名稱', 'error');
            return;
        }
        if (!Number.isFinite(days) || days < 1 || days > 365) {
            this.showToast('借閱天數需為 1-365 的整數', 'error');
            return;
        }

        const nowIso = new Date().toISOString();
        const editingIndex = editingIndexEl && editingIndexEl.value !== ''
            ? parseInt(editingIndexEl.value, 10)
            : -1;

        const existingIndex = this.settings.userLoanSettings.findIndex(x => x.username === username);

        // 編輯模式：若改了 username，避免與其他項目衝突
        if (editingIndex >= 0 && editingIndex < this.settings.userLoanSettings.length) {
            if (existingIndex !== -1 && existingIndex !== editingIndex) {
                this.showToast('已有相同使用者名稱的設定，請先刪除或改名', 'error');
                return;
            }
            this.settings.userLoanSettings[editingIndex] = { username, days, reason, updatedAt: nowIso };
        } else {
            if (existingIndex !== -1) {
                this.settings.userLoanSettings[existingIndex] = { username, days, reason, updatedAt: nowIso };
            } else {
                this.settings.userLoanSettings.push({ username, days, reason, updatedAt: nowIso });
            }
        }

        this.normalizeUserLoanSettings();
        this.saveData();
        this.renderUserLoanSettingsList();

        const modal = document.getElementById('user-loan-modal');
        if (modal) modal.style.display = 'none';

        this.showToast('已儲存使用者借閱時間設定', 'success');
    }

    handleDeleteUserLoanSetting() {
        if (!this.requireAdmin('使用者借閱時間設定')) return;
        this.normalizeUserLoanSettings();

        const editingIndexEl = document.getElementById('user-loan-editing-index');
        const idx = parseInt(String(editingIndexEl?.value || ''), 10);
        if (!Number.isFinite(idx) || idx < 0 || idx >= this.settings.userLoanSettings.length) {
            this.showToast('刪除失敗：找不到設定項目', 'error');
            return;
        }

        const item = this.settings.userLoanSettings[idx];
        const ok = confirm(`確定要刪除「${item.username}」的借閱天數設定嗎？`);
        if (!ok) return;

        this.settings.userLoanSettings.splice(idx, 1);
        this.normalizeUserLoanSettings();
        this.saveData();
        this.renderUserLoanSettingsList();

        const modal = document.getElementById('user-loan-modal');
        if (modal) modal.style.display = 'none';
        this.showToast('已刪除設定', 'success');
    }

    // 更新統計資訊
    updateStats() {
        const totalBooks = this.books.reduce((sum, book) => sum + this.getSingleBookStock(book).total, 0);
        const availableBooks = this.books.reduce((sum, book) => sum + this.getSingleBookStock(book).available, 0);
        const borrowedBooks = Math.min(
            totalBooks,
            this.borrowedBooks.filter(b => !b.returnedAt && this.books.some(book => book.id === b.bookId)).length
        );
        const safeAvailableBooks = Math.max(0, Math.min(totalBooks, availableBooks));

        // 基本統計（所有用戶都看得到）
        document.getElementById('total-books').textContent = totalBooks;
        document.getElementById('available-books').textContent = safeAvailableBooks;
        document.getElementById('borrowed-books').textContent = borrowedBooks;

        // 管理員專用詳細統計
        if (this.isAdminUser()) {
            // 按類別統計
            const statsByGenre = this.calculateStatsByGenre();
            
            // 更新或創建管理員統計區域
            this.updateAdminStats(statsByGenre);
        } else {
            // 非管理員隱藏詳細統計
            this.hideAdminStats();
        }
    }

    // 計算各類別書籍統計
    calculateStatsByGenre() {
        const stats = {
            '繪本': { total: 0, available: 0, borrowed: 0, titles: new Set() },
            '橋梁書': { total: 0, available: 0, borrowed: 0, titles: new Set() },
            '文字書': { total: 0, available: 0, borrowed: 0, titles: new Set() },
            '雜誌': { total: 0, available: 0, borrowed: 0, titles: new Set() },
            '未知': { total: 0, available: 0, borrowed: 0, titles: new Set() }
        };

        this.books.forEach(book => {
            const genre = book.genre || '未知';
            if (!stats[genre]) {
                stats[genre] = { total: 0, available: 0, borrowed: 0, titles: new Set() };
            }

            const stock = this.getSingleBookStock(book);
            stats[genre].total += stock.total;
            stats[genre].available += stock.available;
            stats[genre].borrowed += stock.borrowed;
            stats[genre].titles.add(book.title);
        });

        // 將 Set 轉為數量
        Object.keys(stats).forEach(genre => {
            stats[genre].titleCount = stats[genre].titles.size;
            delete stats[genre].titles;
        });

        return stats;
    }

    // 更新管理員統計顯示
    updateAdminStats(statsByGenre) {
        let adminStatsDiv = document.getElementById('admin-stats');
        
        // 如果不存在，創建管理員統計區域
        if (!adminStatsDiv) {
            adminStatsDiv = document.createElement('div');
            adminStatsDiv.id = 'admin-stats';
            adminStatsDiv.className = 'admin-stats';
            
            // 插入到現有統計區域後面
            const statsContainer = document.querySelector('.stats');
            if (statsContainer) {
                statsContainer.parentNode.insertBefore(adminStatsDiv, statsContainer.nextSibling);
            }
        }

        // 生成統計內容
        const statsHtml = `
            <div class="admin-stats-header">
                <h4><i class="fas fa-chart-bar"></i> 管理員詳細統計</h4>
            </div>
            <div class="admin-stats-grid">
                ${Object.entries(statsByGenre).map(([genre, stats]) => `
                    <div class="admin-stat-card ${genre === '繪本' ? 'picture-book' : genre === '橋梁書' ? 'bridge-book' : genre === '文字書' ? 'chapter-book' : genre === '雜誌' ? 'periodical-book' : 'unknown-book'}">
                        <div class="admin-stat-title">${genre}</div>
                        <div class="admin-stat-numbers">
                            <div class="admin-stat-item">
                                <span class="admin-stat-label">總冊數</span>
                                <span class="admin-stat-value total">${stats.total}</span>
                            </div>
                            <div class="admin-stat-item">
                                <span class="admin-stat-label">可借</span>
                                <span class="admin-stat-value available">${stats.available}</span>
                            </div>
                            <div class="admin-stat-item">
                                <span class="admin-stat-label">已借</span>
                                <span class="admin-stat-value borrowed">${stats.borrowed}</span>
                            </div>
                            <div class="admin-stat-item">
                                <span class="admin-stat-label">書名數</span>
                                <span class="admin-stat-value titles">${stats.titleCount}</span>
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;

        adminStatsDiv.innerHTML = statsHtml;
        adminStatsDiv.style.display = 'block';
    }

    // 隱藏管理員統計
    hideAdminStats() {
        const adminStatsDiv = document.getElementById('admin-stats');
        if (adminStatsDiv) {
            adminStatsDiv.style.display = 'none';
        }
    }

    // 設定視圖模式
    setView(view) {
        const gridBtn = document.getElementById('grid-view');
        const listBtn = document.getElementById('list-view');
        const gridContainer = document.getElementById('gridView');
        const listContainer = document.getElementById('listView');

        if (!gridContainer) {
            console.error('setView: Required elements not found');
            return;
        }

        if (view === 'grid') {
            if (gridBtn) gridBtn.classList.add('active');
            if (listBtn) listBtn.classList.remove('active');
            gridContainer.classList.remove('hidden');
            if (listContainer) listContainer.classList.add('hidden');
        } else {
            if (!listBtn || !listContainer) return;
            listBtn.classList.add('active');
            if (gridBtn) gridBtn.classList.remove('active');
            listContainer.classList.remove('hidden');
            gridContainer.classList.add('hidden');
        }

        // 不重新渲染，保留所有狀態（搜尋、分類、頁碼、捲動位置、系列書展開狀態）
        // 只在首次切換到列表視圖時渲染列表內容
        if (view === 'list' && listContainer.innerHTML.trim() === '') {
            this.renderBooks();
        } else if (view === 'grid' && gridContainer.innerHTML.trim() === '') {
            this.renderBooks();
        }
    }

    // 重置資料
    resetData() {
        if (!this.requireSuperAdmin('重置資料')) return;
        if (confirm('確定要重置所有資料嗎？此操作無法復原！')) {
            localStorage.removeItem('lib_books_v1');
            localStorage.removeItem('lib_borrowed_v1');
            localStorage.removeItem('lib_users_v1');
            localStorage.removeItem('lib_active_user_v1');
            localStorage.removeItem('lib_settings_v1');
            localStorage.removeItem('lib_csv_loaded_v1');
            
            this.books = [];
            this.borrowedBooks = [];
            this.users = [];
            this.currentUser = null;
            
            // 重新載入 Google Sheets（改以線上資料為主）
            this.pullFromGoogleSheets({ silent: false, protectEmpty: false, closeModal: false });
            
            this.renderBooks();
            this.renderBorrowedBooks();
            this.updateStats();
            this.updateUserDisplay();
            
            this.showToast('資料已重置，將重新載入線上資料', 'success');
        }
    }
    
    // 重新載入 Google Sheets 資料
    async reloadCSV() {
        if (!this.requireAdmin('重新載入 Google Sheets')) return;
        
        this.showToast('正在從 Google Sheets 重新載入資料...', 'info');
        
        const url = this.getGoogleWebAppUrl();
        if (!url) {
            this.showToast('尚未設定 Google Sheets 網址，請由管理者設定同步網址', 'warning');
            return;
        }

        try {
            await this.pullFromGoogleSheets({ silent: false, protectEmpty: false, closeModal: false });
        } catch (error) {
            console.error('從 Google Sheets 載入失敗:', error);
            this.showToast('Google Sheets 載入失敗，請稍後重新整理', 'warning');
        }
    }

    // 匯出書籍資料到 CSV 檔案
    async exportToCSV() {
        if (!this.requireAdmin('匯出 CSV')) return;
        
        if (this.books.length === 0) {
            this.showToast('沒有書籍資料可以匯出', 'warning');
            return;
        }

        try {
            this.showToast('正在匯出 CSV 檔案...', 'info');
            this.showLoadingIndicator(true);

            // 建立 CSV 內容
            let csvContent = '博幼藏書,\n,\n欄1,欄2,欄3\n編號,書名,網頁網址\n';
            const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
            
            // 按書碼排序
            const sortedBooks = [...this.books].sort((a, b) => {
                if (a.id && b.id) {
                    return a.id.localeCompare(b.id);
                }
                return (a.title || '').localeCompare(b.title || '');
            });

            // 加入書籍資料
            sortedBooks.forEach(book => {
                const id = book.id || '';
                const title = book.title || '';
                const bookUrl = book.bookUrl || '';
                csvContent += `${csvCell(id)},${csvCell(title)},${csvCell(bookUrl)}\n`;
            });

            // 建立 Blob 物件
            const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
            
            // 建立下載連結
            const link = document.createElement('a');
            const url = URL.createObjectURL(blob);
            link.setAttribute('href', url);
            link.setAttribute('download', '113博幼館藏.csv');
            link.style.visibility = 'hidden';
            
            // 觸發下載
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            this.showLoadingIndicator(false);
            this.showToast(`成功匯出 ${this.books.length} 筆書籍資料到 CSV 檔案`, 'success');
            
            console.log(`CSV 匯出完成，共 ${this.books.length} 筆資料`);

        } catch (error) {
            console.error('匯出 CSV 失敗:', error);
            this.showLoadingIndicator(false);
            this.showToast('匯出 CSV 失敗', 'error');
        }
    }

    // 同步 Google Sheets 資料到本地 CSV
    async syncGoogleSheetsToCSV() {
        if (!this.requireAdmin('同步 Google Sheets 到 CSV')) return;
        
        const url = this.getGoogleWebAppUrl();
        if (!url) {
            this.showToast('請先設定 Google Sheets 同步網址', 'error');
            return;
        }

        try {
            this.showToast('正在從 Google Sheets 載入資料...', 'info');
            this.showLoadingIndicator(true);

            const response = await fetch(url, {
                method: 'POST',
                body: JSON.stringify({ action: 'pull' })
            });

            const result = await response.json().catch(() => null);
            if (!response.ok || !result || !result.ok) {
                throw new Error('Google Sheets 請求失敗');
            }

            const data = result.data || {};
            if (!Array.isArray(data.books)) {
                throw new Error('資料格式不正確');
            }

            if (data.books.length === 0) {
                this.showLoadingIndicator(false);
                this.showToast('Google Sheets 中沒有書籍資料', 'warning');
                return;
            }

            // 更新本地書籍資料
            this.books = data.books;
            this.borrowedBooks = data.borrowedBooks || [];
            
            // 處理博幼藏書資料
            if (data.boyouBooks && typeof data.boyouBooks === 'object') {
                localStorage.setItem('lib_boyou_books_v1', JSON.stringify(data.boyouBooks));
            }

            // 儲存到本地
            this.saveData();
            
            // 匯出為 CSV
            await this.exportToCSVData(data.books);
            
            // 重新渲染介面
            this.renderBooks();
            this.renderBorrowedBooks();
            this.updateStats();
            this.lastUpdateTime = new Date();
            this.updateLastUpdateDisplay();

            this.showLoadingIndicator(false);
            this.showToast(`成功同步 ${data.books.length} 本書籍到 CSV 檔案`, 'success');

        } catch (error) {
            console.error('同步 Google Sheets 到 CSV 失敗:', error);
            this.showLoadingIndicator(false);
            this.showToast('同步失敗，請檢查網路連線或 Google Sheets 設定', 'error');
        }
    }

    // 匯出書籍資料為 CSV (內部函數)
    async exportToCSVData(books) {
        try {
            // 建立 CSV 內容
            let csvContent = '博幼藏書,\n,\n欄1,欄2,欄3\n編號,書名,網頁網址\n';
            const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
            
            // 按書碼排序
            const sortedBooks = [...books].sort((a, b) => {
                if (a.id && b.id) {
                    return a.id.localeCompare(b.id);
                }
                return (a.title || '').localeCompare(b.title || '');
            });

            // 加入書籍資料
            sortedBooks.forEach(book => {
                const id = book.id || '';
                const title = book.title || '';
                const bookUrl = book.bookUrl || '';
                csvContent += `${csvCell(id)},${csvCell(title)},${csvCell(bookUrl)}\n`;
            });

            // 建立 Blob 物件
            const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
            
            // 建立下載連結
            const link = document.createElement('a');
            const url = URL.createObjectURL(blob);
            link.setAttribute('href', url);
            link.setAttribute('download', '113博幼館藏.csv');
            link.style.visibility = 'hidden';
            
            // 觸發下載
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            console.log(`CSV 匯出完成，共 ${books.length} 筆資料`);

        } catch (error) {
            console.error('匯出 CSV 資料失敗:', error);
            throw error;
        }
    }


    // 開始自動更新
    startAutoUpdate() {
        if (!this.isAdminUser()) {
            this.stopAutoUpdate();
            return;
        }
        // 清除現有的定時器
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
        }

        // 設定自動更新定時器
        this.updateTimer = setInterval(() => {
            this.autoUpdateBooks();
        }, this.settings.autoUpdateInterval);

        console.log(`自動更新已啟動，每 ${this.settings.autoUpdateInterval / 1000} 秒檢查一次`);
    }

    // 停止自動更新
    stopAutoUpdate() {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = null;
            console.log('自動更新已停止');
        }
    }

    // 自動更新書籍資料
    async autoUpdateBooks() {
        try {
            console.log('開始自動更新線上 Google Sheets 資料...');

            await this.pullFromGoogleSheets({ silent: true, protectEmpty: true, closeModal: false });
            this.lastUpdateTime = new Date();
            this.updateLastUpdateDisplay();
        } catch (error) {
            console.error('自動更新失敗:', error);
        }
    }

    // 更新最後更新時間顯示
    updateLastUpdateDisplay() {
        const lastUpdateElement = document.getElementById('last-update-time');
        if (lastUpdateElement && this.lastUpdateTime) {
            const timeString = this.lastUpdateTime.toLocaleString('zh-TW');
            lastUpdateElement.textContent = `最後更新：${timeString}`;
        }
    }

    // 切換自動更新狀態
    toggleAutoUpdate() {
        if (!this.requireAdmin('自動更新')) return;
        const button = document.getElementById('toggle-auto-update-btn');
        const statusElement = document.getElementById('auto-update-status');
        
        if (this.updateTimer) {
            // 停止自動更新
            this.stopAutoUpdate();
            button.innerHTML = '<i class="fas fa-play"></i> 啟動自動更新';
            button.className = 'btn btn-warning';
            statusElement.innerHTML = '<i class="fas fa-circle" style="color: #ff6b6b;"></i> 自動更新已停止';
            this.showToast('自動更新已停止', 'warning');
        } else {
            // 啟動自動更新
            this.startAutoUpdate();
            button.innerHTML = '<i class="fas fa-pause"></i> 停止自動更新';
            button.className = 'btn btn-success';
            statusElement.innerHTML = '<i class="fas fa-circle" style="color: #28a745;"></i> 自動更新已啟動';
            this.showToast('自動更新已啟動', 'success');
        }
    }

    // 跳轉到博幼藏書頁面
    goToBoyouBooks() {
        window.location.href = 'boyou-books.html';
    }

    // 顯示通知
    showToast(message, type = 'info') {
        const toast = document.getElementById('toast');
        if (!toast) {
            console.log(`Toast (${type}): ${message}`);
            return;
        }
        toast.textContent = message;
        toast.className = `toast ${type}`;
        toast.classList.add('show');

        setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    }

    // 匯出借閱清單為 Excel
    exportBorrowedToExcel() {
        if (!this.currentUser) {
            this.showToast('請先登入後再匯出', 'error');
            return;
        }

        if (typeof XLSX === 'undefined') {
            this.showToast('Excel 下載套件尚未載入，請重新整理頁面後再試一次', 'error');
            return;
        }

        // 依角色決定匯出內容：一般使用者只匯出自己的完整紀錄，管理員/館員可匯出全部
        let records;
        const canExportAll = this.isAdminUser() || this.currentUser.role === 'staff';
        if (canExportAll) {
            records = this.borrowedBooks;
        } else {
            records = this.borrowedBooks.filter(b => b.userId === this.currentUser.username);
        }

        if (!records || records.length === 0) {
            this.showToast('沒有可匯出的借閱記錄', 'warning');
            return;
        }

        // 老師/館員/管理者：單一檔案、每位借閱者一個工作表
        if (canExportAll) {
            const grouped = new Map();
            records.forEach(r => {
                if (!grouped.has(r.userId)) grouped.set(r.userId, []);
                grouped.get(r.userId).push(r);
            });

            const dateStr = new Date().toISOString().slice(0, 10);
            const header = ['借閱編號', '書碼', '書名', '借閱者', '借閱日期', '應還日期', '歸還日期', '狀態'];
            const formatDate = (value) => value ? new Date(value).toLocaleDateString('zh-TW') : '';

            const wb = XLSX.utils.book_new();

            const sanitizeSheetName = (name) => {
                const invalid = /[\\\/:\*\?\[\]]/g; // Excel 禁止字元
                let safe = String(name).replace(invalid, ' ');
                if (!safe.trim()) safe = '借閱者';
                if (safe.length > 31) safe = safe.slice(0, 31);
                return safe;
            };

            grouped.forEach((userRecords, userId) => {
                const rows = userRecords.map(r => [
                    r.id,
                    r.bookId,
                    r.bookTitle,
                    r.userId,
                    formatDate(r.borrowDate),
                    formatDate(r.dueDate),
                    formatDate(r.returnedAt),
                    r.returnedAt ? '已歸還' : '借閱中'
                ]);

                const aoa = [header, ...rows];
                const ws = XLSX.utils.aoa_to_sheet(aoa);
                const colWidths = header.map((h, idx) => {
                    const maxLen = Math.max(
                        h.length,
                        ...rows.map(row => (row[idx] !== undefined && row[idx] !== null ? String(row[idx]).length : 0))
                    );
                    return { wch: Math.min(Math.max(maxLen + 2, 8), 40) };
                });
                ws['!cols'] = colWidths;

                const sheetName = sanitizeSheetName(userId);
                XLSX.utils.book_append_sheet(wb, ws, sheetName);
            });

            const filename = `借閱紀錄_全部_${dateStr}.xlsx`;
            XLSX.writeFile(wb, filename);
            this.showToast('已匯出完整借閱紀錄（多工作表）', 'success');
            return;
        }

        // 學生/訪客：只匯出自己的活頁簿
        const header = ['借閱編號', '書碼', '書名', '借閱者', '借閱日期', '應還日期', '歸還日期', '狀態'];
        const formatDate = (value) => value ? new Date(value).toLocaleDateString('zh-TW') : '';
        const rows = records.map(r => [
            r.id,
            r.bookId,
            r.bookTitle,
            r.userId,
            formatDate(r.borrowDate),
            formatDate(r.dueDate),
            formatDate(r.returnedAt),
            r.returnedAt ? '已歸還' : '借閱中'
        ]);

        const aoa = [header, ...rows];
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const colWidths = header.map((h, idx) => {
            const maxLen = Math.max(
                h.length,
                ...rows.map(row => (row[idx] !== undefined && row[idx] !== null ? String(row[idx]).length : 0))
            );
            return { wch: Math.min(Math.max(maxLen + 2, 8), 40) };
        });
        ws['!cols'] = colWidths;

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '借閱紀錄');
        const dateStr = new Date().toISOString().slice(0, 10);
        const filename = `借閱紀錄_${this.currentUser.username}_${dateStr}.xlsx`;
        XLSX.writeFile(wb, filename);
        this.showToast('已匯出我的借閱紀錄', 'success');
    }

    // 顯示搜尋封面模態框
    showFetchCoversModal() {
        if (!this.requireAdmin('一鍵搜尋封面')) return;
        
        const modal = document.getElementById('fetch-covers-modal');
        if (modal) {
            modal.style.display = 'block';
            // 重置表單
            document.getElementById('fetch-covers-form').reset();
            document.getElementById('range-options').style.display = 'none';
            document.getElementById('genre-options').style.display = 'none';
        }
    }

    // 處理搜尋封面表單提交
    async handleFetchCovers(e) {
        e.preventDefault();
        if (!this.requireAdmin('一鍵搜尋封面')) return;

        const rangeType = document.getElementById('fetch-range').value;
        const fetchCovers = document.getElementById('fetch-covers').checked;
        const fetchAuthors = document.getElementById('fetch-authors').checked;

        if (!fetchCovers && !fetchAuthors) {
            this.showToast('請至少選擇一種搜尋類型', 'error');
            return;
        }

        // 根據範圍類型篩選書籍
        let searchQueue = [];
        
        if (rangeType === 'all') {
            searchQueue = this.books.filter(book => 
                (fetchCovers && !book.coverUrl) || 
                (fetchAuthors && !book.author)
            );
        } else if (rangeType === 'range') {
            const startCode = document.getElementById('range-start').value.trim().toUpperCase();
            const endCode = document.getElementById('range-end').value.trim().toUpperCase();
            
            if (!startCode || !endCode) {
                this.showToast('請輸入起始和結束書碼', 'error');
                return;
            }

            searchQueue = this.books.filter(book => {
                const bookCode = book.id.toUpperCase();
                const inRange = bookCode >= startCode && bookCode <= endCode;
                const needsUpdate = (fetchCovers && !book.coverUrl) || (fetchAuthors && !book.author);
                return inRange && needsUpdate;
            });
        } else if (rangeType === 'genre') {
            const genre = document.getElementById('fetch-genre').value;
            searchQueue = this.books.filter(book => 
                book.genre === genre && 
                ((fetchCovers && !book.coverUrl) || (fetchAuthors && !book.author))
            );
        }

        if (searchQueue.length === 0) {
            this.showToast('在指定範圍內沒有需要更新的書籍', 'info');
            return;
        }

        // 關閉設定模態框，打開進度模態框
        document.getElementById('fetch-covers-modal').style.display = 'none';
        this.showSearchProgressModal();

        // 開始搜尋
        await this.startSearchProcess(searchQueue, fetchCovers, fetchAuthors);
    }

    // 切換搜尋選項顯示
    toggleFetchOptions(rangeType) {
        const rangeOptions = document.getElementById('range-options');
        const genreOptions = document.getElementById('genre-options');

        rangeOptions.style.display = rangeType === 'range' ? 'block' : 'none';
        genreOptions.style.display = rangeType === 'genre' ? 'block' : 'none';
    }

    // 顯示搜尋進度模態框
    showSearchProgressModal() {
        const modal = document.getElementById('search-progress-modal');
        if (modal) {
            modal.style.display = 'block';
            // 重置進度顯示
            this.updateProgressDisplay();
        }
    }

    // 開始搜尋處理
    async startSearchProcess(searchQueue, fetchCovers, fetchAuthors) {
        this.searchState = {
            isRunning: true,
            isPaused: false,
            shouldStop: false,
            currentIndex: 0,
            totalBooks: searchQueue.length,
            successCount: 0,
            failCount: 0,
            searchQueue: searchQueue,
            fetchCovers: fetchCovers,
            fetchAuthors: fetchAuthors
        };

        this.updateProgressDisplay();

        while (this.searchState.currentIndex < this.searchState.searchQueue.length && !this.searchState.shouldStop) {
            // 檢查是否暫停
            while (this.searchState.isPaused && !this.searchState.shouldStop) {
                await this.sleep(100);
            }

            if (this.searchState.shouldStop) break;

            const book = this.searchState.searchQueue[this.searchState.currentIndex];
            
            try {
                // 更新目前處理的書籍名稱
                document.getElementById('current-book-title').textContent = book.title;

                let success = false;

                // 搜尋封面
                if (this.searchState.fetchCovers && !book.coverUrl) {
                    const coverUrl = await this.searchBookCover(book.title, book.author);
                    if (coverUrl) {
                        book.coverUrl = coverUrl;
                        success = true;
                    }
                }

                // 搜尋作者
                if (this.searchState.fetchAuthors && !book.author) {
                    const author = await this.searchBookAuthor(book.title);
                    if (author) {
                        book.author = author;
                        success = true;
                    }
                }

                if (success) {
                    this.searchState.successCount++;
                } else {
                    this.searchState.failCount++;
                }

                this.searchState.currentIndex++;
                this.updateProgressDisplay();

                // 避免請求過於頻繁
                await this.sleep(1000);

            } catch (error) {
                console.error(`搜尋時發生錯誤 (${book.title}):`, error);
                this.searchState.failCount++;
                this.searchState.currentIndex++;
                this.updateProgressDisplay();
            }
        }

        // 搜尋完成
        this.finishSearchProcess();
    }

    // 更新進度顯示
    updateProgressDisplay() {
        const progress = (this.searchState.currentIndex / this.searchState.totalBooks) * 100;
        
        document.getElementById('progress-count').textContent = this.searchState.currentIndex;
        document.getElementById('progress-total').textContent = this.searchState.totalBooks;
        document.getElementById('success-count').textContent = this.searchState.successCount;
        document.getElementById('fail-count').textContent = this.searchState.failCount;
        document.getElementById('progress-fill').style.width = `${progress}%`;
    }

    // 暫停搜尋
    pauseSearch() {
        this.searchState.isPaused = true;
        document.getElementById('pause-search-btn').style.display = 'none';
        document.getElementById('resume-search-btn').style.display = 'inline-flex';
        this.showToast('搜尋已暫停', 'info');
    }

    // 繼續搜尋
    resumeSearch() {
        this.searchState.isPaused = false;
        document.getElementById('pause-search-btn').style.display = 'inline-flex';
        document.getElementById('resume-search-btn').style.display = 'none';
        this.showToast('搜尋已繼續', 'info');
    }

    // 停止搜尋
    stopSearch() {
        this.searchState.shouldStop = true;
        this.showToast('搜尋已停止', 'warning');
    }

    // 完成搜尋處理
    finishSearchProcess() {
        this.searchState.isRunning = false;
        
        // 儲存資料並更新顯示
        this.saveData();
        this.renderBooks();
        
        // 關閉進度模態框
        document.getElementById('search-progress-modal').style.display = 'none';
        
        // 顯示結果
        this.showToast(`搜尋完成！成功: ${this.searchState.successCount}, 失敗: ${this.searchState.failCount}`, 'success');
        
        // 搜尋完成不會觸發館藏同步（若需要可改為 'bulkImport'）
        this.triggerSyncForAction('search');
    }

    // 搜尋書籍作者
    async searchBookAuthor(title) {
        try {
            const info = await this.lookupBookInfoByTitle(title);
            if (Array.isArray(info?.authors) && info.authors.length > 0) {
                return info.authors.join(', ');
            }
            return null;
        } catch (error) {
            console.error('搜尋作者時發生錯誤:', error);
            return null;
        }
    }

    // 搜尋單本書籍封面
    async searchBookCover(title, author = '') {
        try {
            // 建構搜尋查詢
            let query = title;
            if (author) {
                query += ` ${author}`;
            }

            const info = await this.lookupBookInfoByTitle(query);
            const imageLinks = info?.imageLinks;
            if (imageLinks) {
                return imageLinks.extraLarge ||
                       imageLinks.large ||
                       imageLinks.medium ||
                       imageLinks.thumbnail ||
                       imageLinks.smallThumbnail ||
                       null;
            }
            
            return null;
        } catch (error) {
            console.error('搜尋封面時發生錯誤:', error);
            return null;
        }
    }

    // 延遲函數
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // 顯示載入指示器
    showLoadingIndicator(show) {
        const statusElement = document.getElementById('auto-update-status');
        if (statusElement) {
            if (show) {
                statusElement.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 正在載入最新資料...';
                statusElement.style.color = '#007bff';
            } else if (this.updateTimer) {
                statusElement.innerHTML = '<i class="fas fa-circle" style="color: #28a745;"></i> 自動更新已啟動';
            } else {
                statusElement.innerHTML = '<i class="fas fa-circle" style="color: #ff6b6b;"></i> 自動更新已停止';
            }
        }

        let indicator = document.getElementById('loading-indicator');
        
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'loading-indicator';
            indicator.innerHTML = `
                <div class="loading-overlay">
                    <div class="loading-spinner">
                        <i class="fas fa-spinner fa-spin"></i>
                        <div class="loading-text">處理中...</div>
                    </div>
                </div>
            `;
            
            // 添加載入指示器的樣式
            const style = document.createElement('style');
            style.textContent = `
                .loading-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(0, 0, 0, 0.5);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 9999;
                }
                
                .loading-spinner {
                    background: white;
                    padding: 30px;
                    border-radius: 12px;
                    text-align: center;
                    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.3);
                }
                
                .loading-spinner i {
                    font-size: 2rem;
                    color: #667eea;
                    margin-bottom: 15px;
                }
                
                .loading-text {
                    font-size: 1.1rem;
                    color: #4a5568;
                    font-weight: 600;
                }
            `;
            
            document.head.appendChild(style);
            document.body.appendChild(indicator);
        }
        
        indicator.style.display = show ? 'flex' : 'none';
    }

    // 搜尋書籍資訊（當找不到書籍時使用）
    async searchBookInfo(searchTerm, preferredSource = null) {
        if (!searchTerm || searchTerm.trim() === '') {
            this.showToast('請輸入書名進行搜尋', 'error');
            return;
        }

        try {
            this.showToast('正在搜尋書籍資訊...', 'info');
            this.showLoadingIndicator(true);

            let results = [];

            // 如果指定了特定書庫，直接使用手動搜尋選項
            if (preferredSource === 'bookscom' || preferredSource === 'kingstone' || preferredSource === 'eslite') {
                this.showManualSearchOptions(searchTerm, []);
                return;
            }

            // 如果指定了多選搜尋，顯示多選介面
            if (preferredSource === 'multi') {
                this.showMultiSearchOptions(searchTerm);
                return;
            }

            // 先嘗試 Google Books API
            results = await this.searchFromGoogleBooks(searchTerm);
            
            // 如果 Google Books 沒有結果，直接提供書庫選擇
            if (results.length === 0) {
                this.showLoadingIndicator(false);
                this.showToast('Google Books 沒有找到資料，請選擇其他書庫', 'info');
                this.showManualSearchOptions(searchTerm, []);
                return;
            }
            
            // 如果 Google Books 結果不足，嘗試 Open Library
            if (results.length < 3) {
                this.showToast('正在擴大搜尋範圍...', 'info');
                
                // 嘗試 Open Library
                const openLibraryResults = await this.searchFromOpenLibrary(searchTerm);
                results = [...results, ...openLibraryResults];
                
                // 如果結果仍然不足，提供手動搜尋選項
                if (results.length < 8) {
                    this.showManualSearchOptions(searchTerm, results);
                    return;
                }
            }

            if (results.length === 0) {
                this.showLoadingIndicator(false);
                this.showToast('找不到相關書籍資訊', 'warning');
                return;
            }

            // 顯示搜尋結果
            this.showBookSearchResults(results, searchTerm);

        } catch (error) {
            console.error('搜尋書籍資訊失敗:', error);
            this.showLoadingIndicator(false);
            this.showToast('搜尋失敗，請檢查網路連線', 'error');
        }
    }

    // 從 Google Books API 搜尋
    async searchFromGoogleBooks(searchTerm) {
        try {
            const query = encodeURIComponent(searchTerm.trim());
            const apiUrl = `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=5&langRestrict=zh${this.getGoogleBooksApiKeyParam()}`;

            // 使用 API 隊列機制
            const data = await this.enqueueApiRequest(async () => {
                return await this.fetchWithRetry(apiUrl, { retries: 1, cooldownOn429: true });
            });

            if (!data.items || data.items.length === 0) return [];

            return data.items.map(book => ({
                source: 'Google Books',
                volumeInfo: book.volumeInfo,
                id: book.id
            }));

        } catch (error) {
            console.error('Google Books 搜尋失敗:', error);
            this.handleApiError(error, 'Google Books 搜尋失敗');
            return [];
        }
    }

    // 從 Open Library API 搜尋
    async searchFromOpenLibrary(searchTerm) {
        try {
            const query = encodeURIComponent(searchTerm.trim());
            const apiUrl = `https://openlibrary.org/search.json?q=${query}&limit=5&language=chi`;

            // 使用 API 隊列機制
            const data = await this.enqueueApiRequest(async () => {
                return await this.fetchWithRetry(apiUrl);
            });
            
            if (!data.docs || data.docs.length === 0) return [];

            return data.docs.map(book => ({
                source: 'Open Library',
                volumeInfo: {
                    title: book.title,
                    authors: book.author_name || [],
                    publisher: book.publisher ? [book.publisher] : [],
                    publishedDate: book.first_publish_year ? book.first_publish_year.toString() : '',
                    description: book.first_sentence ? book.first_sentence.join(' ') : '無簡介',
                    industryIdentifiers: book.isbn ? [
                        { type: 'ISBN_13', identifier: book.isbn[0] },
                        { type: 'ISBN_10', identifier: book.isbn[0] }
                    ] : [],
                    imageLinks: book.cover_i ? {
                        thumbnail: `https://covers.openlibrary.org/b/id/${book.cover_i}-M.jpg`,
                        smallThumbnail: `https://covers.openlibrary.org/b/id/${book.cover_i}-S.jpg`,
                        medium: `https://covers.openlibrary.org/b/id/${book.cover_i}-M.jpg`,
                        large: `https://covers.openlibrary.org/b/id/${book.cover_i}-L.jpg`
                    } : null
                },
                id: book.key.replace('/works/', '')
            }));

        } catch (error) {
            console.error('Open Library 搜尋失敗:', error);
            this.handleApiError(error, 'Open Library 搜尋失敗');
            return [];
        }
    }

    // 從博客來搜尋（使用代理方式）
    async searchFromBooksCom(searchTerm) {
        try {
            // 由於CORS限制，我們使用博客來的搜尋API代理
            const query = encodeURIComponent(searchTerm.trim());
            const apiUrl = `https://search.books.com.tw/search/query/key/${query}/cat/all`;

            // 使用CORS代理服務
            const proxyUrl = `https://cors-anywhere.herokuapp.com/${apiUrl}`;
            
            const response = await fetch(proxyUrl, {
                headers: {
                    'X-Requested-With': 'XMLHttpRequest'
                }
            });
            
            if (!response.ok) return [];

            const html = await response.text();
            
            // 解析HTML提取書籍資訊
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            
            const books = [];
            const bookElements = doc.querySelectorAll('.item');
            
            bookElements.forEach(element => {
                try {
                    const titleElement = element.querySelector('.title a');
                    const authorElement = element.querySelector('.author');
                    const imageElement = element.querySelector('img');
                    const publisherElement = element.querySelector('.publisher');
                    const yearElement = element.querySelector('.date');
                    
                    if (titleElement) {
                        const title = titleElement.textContent.trim();
                        const author = authorElement ? authorElement.textContent.trim() : '未知作者';
                        const coverUrl = imageElement ? imageElement.src || imageElement.getAttribute('data-src') : '';
                        const publisher = publisherElement ? publisherElement.textContent.trim() : '未知出版社';
                        const year = yearElement ? yearElement.textContent.trim().match(/\d{4}/)?.[0] || '未知年份' : '未知年份';
                        
                        books.push({
                            source: '博客來',
                            volumeInfo: {
                                title,
                                authors: [author],
                                publisher,
                                publishedDate: year,
                                description: '博客來書籍資料',
                                industryIdentifiers: [],
                                imageLinks: coverUrl ? {
                                    thumbnail: coverUrl,
                                    smallThumbnail: coverUrl
                                } : null
                            },
                            id: `bookscom_${books.length}`
                        });
                    }
                } catch (e) {
                    console.warn('解析博客來書籍資訊失敗:', e);
                }
            });
            
            return books.slice(0, 5); // 限制返回5本

        } catch (error) {
            console.error('博客來搜尋失敗:', error);
            return [];
        }
    }

    // 從金石堂搜尋（使用代理方式）
    async searchFromKingstone(searchTerm) {
        try {
            // 由於CORS限制，我們使用金石堂的搜尋API代理
            const query = encodeURIComponent(searchTerm.trim());
            const apiUrl = `https://www.kingstone.com.tw/search/search.aspx?searchkey=${query}`;

            // 使用CORS代理服務
            const proxyUrl = `https://cors-anywhere.herokuapp.com/${apiUrl}`;
            
            const response = await fetch(proxyUrl, {
                headers: {
                    'X-Requested-With': 'XMLHttpRequest'
                }
            });
            
            if (!response.ok) return [];

            const html = await response.text();
            
            // 解析HTML提取書籍資訊
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            
            const books = [];
            const bookElements = doc.querySelectorAll('.pdbookbox');
            
            bookElements.forEach(element => {
                try {
                    const titleElement = element.querySelector('.title a');
                    const authorElement = element.querySelector('.author');
                    const imageElement = element.querySelector('img');
                    const publisherElement = element.querySelector('.publish');
                    
                    if (titleElement) {
                        const title = titleElement.textContent.trim();
                        const author = authorElement ? authorElement.textContent.trim() : '未知作者';
                        const coverUrl = imageElement ? imageElement.src || imageElement.getAttribute('data-src') : '';
                        const publisher = publisherElement ? publisherElement.textContent.trim() : '未知出版社';
                        const year = '未知年份';
                        
                        books.push({
                            source: '金石堂',
                            volumeInfo: {
                                title,
                                authors: [author],
                                publisher,
                                publishedDate: year,
                                description: '金石堂書籍資料',
                                industryIdentifiers: [],
                                imageLinks: coverUrl ? {
                                    thumbnail: coverUrl,
                                    smallThumbnail: coverUrl
                                } : null
                            },
                            id: `kingstone_${books.length}`
                        });
                    }
                } catch (e) {
                    console.warn('解析金石堂書籍資訊失敗:', e);
                }
            });
            
            return books.slice(0, 5); // 限制返回5本

        } catch (error) {
            console.error('金石堂搜尋失敗:', error);
            return [];
        }
    }

    // 顯示手動搜尋選項
    showManualSearchOptions(searchTerm, currentResults) {
        this.showLoadingIndicator(false);
        
        // 處理特殊字符，避免JavaScript語法錯誤
        const safeSearchTerm = searchTerm.replace(/'/g, "\\'").replace(/"/g, '\\"');

        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 600px;">
                <span class="close">&times;</span>
                <h2><i class="fas fa-search"></i> 選擇書庫搜尋</h2>
                <p>請選擇要搜尋的書庫，或使用自動搜尋：</p>
                
                <div class="search-source-buttons">
                    <button class="btn btn-primary" onclick="this.closest('.modal').remove(); library.searchBookInfo('${safeSearchTerm}', 'auto')">
                        <i class="fas fa-globe"></i> 自動搜尋
                    </button>
                    <button class="btn btn-info" onclick="this.closest('.modal').remove(); library.searchBookInfo('${safeSearchTerm}', 'multi')">
                        <i class="fas fa-check-square"></i> 多選搜尋
                    </button>
                    <button class="btn btn-success" onclick="this.closest('.modal').remove(); library.openBooksComSearch('${safeSearchTerm}')">
                        <i class="fas fa-book"></i> 博客來
                    </button>
                    <button class="btn btn-warning" onclick="this.closest('.modal').remove(); library.openKingstoneSearch('${safeSearchTerm}')">
                        <i class="fas fa-book-open"></i> 金石堂
                    </button>
                    <button class="btn btn-secondary" onclick="this.closest('.modal').remove(); library.openEsliteSearch('${safeSearchTerm}')">
                        <i class="fas fa-globe"></i> 誠品線上
                    </button>
                </div>
                
                <div class="search-source-info">
                    <h4><i class="fas fa-info-circle"></i> 書庫說明</h4>
                    <div class="source-grid">
                        <div class="source-item">
                            <strong>自動搜尋</strong>
                            <p>Google Books + Open Library，適合搜尋外文書籍</p>
                        </div>
                        <div class="source-item">
                            <strong>博客來</strong>
                            <p>台灣最大線上書店，中文書籍最齊全</p>
                        </div>
                        <div class="source-item">
                            <strong>金石堂</strong>
                            <p>知名連鎖書店，暢銷書豐富</p>
                        </div>
                        <div class="source-item">
                            <strong>誠品線上</strong>
                            <p>文化藝術書店，文學設計類豐富</p>
                        </div>
                    </div>
                </div>
                
                <div class="form-actions">
                    <button type="button" class="btn btn-outline" onclick="this.closest('.modal').remove()">
                        <i class="fas fa-times"></i> 取消
                    </button>
                    <button type="button" class="btn btn-success" onclick="library.openBooksComSearch('${safeSearchTerm}')">
                        <i class="fas fa-external-link-alt"></i> 測試博客來
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        modal.style.display = 'block';

        // 設置關閉事件
        modal.querySelector('.close').onclick = () => modal.remove();
        modal.onclick = (e) => {
            if (e.target === modal) modal.remove();
        };
    }

    // 開啟博客來搜尋
    openBooksComSearch(searchTerm) {
        const query = encodeURIComponent(searchTerm.trim());
        const url = `https://search.books.com.tw/search/query/key/${query}/cat/all`;
        window.open(url, '_blank');
        this.showToast('已開啟博客來搜尋頁面', 'info');
    }

    // 開啟金石堂搜尋
    openKingstoneSearch(searchTerm) {
        const query = encodeURIComponent(searchTerm.trim());
        const url = `https://www.kingstone.com.tw/search/search.aspx?searchkey=${query}`;
        window.open(url, '_blank');
        this.showToast('已開啟金石堂搜尋頁面', 'info');
    }

    // 開啟誠品搜尋
    openEsliteSearch(searchTerm) {
        const query = encodeURIComponent(searchTerm.trim());
        const url = `https://www.eslite.com/Search.aspx?keyword=${query}`;
        window.open(url, '_blank');
        this.showToast('已開啟誠品搜尋頁面', 'info');
    }

    openCoverImageSearch(titleInputId, authorInputId = null) {
        const title = (document.getElementById(titleInputId)?.value || '').trim();
        const author = authorInputId ? (document.getElementById(authorInputId)?.value || '').trim() : '';

        if (!title) {
            this.showToast('請先輸入書名，再搜尋封面圖片', 'warning');
            const titleInput = document.getElementById(titleInputId);
            if (titleInput) titleInput.focus();
            return;
        }

        const query = [title, author, '書籍 封面'].filter(Boolean).join(' ');
        const url = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(query)}`;
        window.open(url, '_blank');
        this.showToast('已開啟圖片搜尋，找到封面後可複製圖片網址貼回來', 'info');
    }

    // 顯示多選搜尋選項
    showMultiSearchOptions(searchTerm) {
        this.showLoadingIndicator(false);
        
        // 處理特殊字符，避免JavaScript語法錯誤
        const safeSearchTerm = searchTerm.replace(/'/g, "\\'").replace(/"/g, '\\"');

        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 700px;">
                <span class="close">&times;</span>
                <h2><i class="fas fa-search"></i> 多選書庫搜尋</h2>
                <p>選擇要搜尋的書庫，可以同時開啟多個書庫：</p>
                
                <div class="multi-search-grid">
                    <div class="search-source-item">
                        <label class="checkbox-container">
                            <input type="checkbox" id="google-books" checked>
                            <span class="checkmark"></span>
                            <div class="source-info">
                                <strong>🌐 Google Books</strong>
                                <p>國際書籍資料庫，外文書籍豐富</p>
                            </div>
                        </label>
                    </div>
                    
                    <div class="search-source-item">
                        <label class="checkbox-container">
                            <input type="checkbox" id="open-library" checked>
                            <span class="checkmark"></span>
                            <div class="source-info">
                                <strong>📚 Open Library</strong>
                                <p>開放書籍資料庫，書籍數量龐大</p>
                            </div>
                        </label>
                    </div>
                    
                    <div class="search-source-item">
                        <label class="checkbox-container">
                            <input type="checkbox" id="books-com">
                            <span class="checkmark"></span>
                            <div class="source-info">
                                <strong>📖 博客來</strong>
                                <p>台灣最大線上書店，中文書籍最齊全</p>
                            </div>
                        </label>
                    </div>
                    
                    <div class="search-source-item">
                        <label class="checkbox-container">
                            <input type="checkbox" id="kingstone">
                            <span class="checkmark"></span>
                            <div class="source-info">
                                <strong>📕 金石堂</strong>
                                <p>知名連鎖書店，暢銷書豐富</p>
                            </div>
                        </label>
                    </div>
                    
                    <div class="search-source-item">
                        <label class="checkbox-container">
                            <input type="checkbox" id="eslite">
                            <span class="checkmark"></span>
                            <div class="source-info">
                                <strong>🎨 誠品線上</strong>
                                <p>文化藝術書店，文學設計類豐富</p>
                            </div>
                        </label>
                    </div>
                </div>
                
                <div class="search-actions">
                    <button class="btn btn-primary" onclick="library.executeMultiSearch('${safeSearchTerm}')">
                        <i class="fas fa-search"></i> 開始搜尋
                    </button>
                    <button class="btn btn-success" onclick="library.selectAllSources()">
                        <i class="fas fa-check-square"></i> 全選
                    </button>
                    <button class="btn btn-outline" onclick="library.deselectAllSources()">
                        <i class="fas fa-square"></i> 取消全選
                    </button>
                </div>
                
                <div class="form-actions">
                    <button type="button" class="btn btn-outline" onclick="this.closest('.modal').remove()">
                        <i class="fas fa-times"></i> 取消
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        modal.style.display = 'block';

        // 設置關閉事件
        modal.querySelector('.close').onclick = () => modal.remove();
        modal.onclick = (e) => {
            if (e.target === modal) modal.remove();
        };
    }

    // 執行多選搜尋
    async executeMultiSearch(searchTerm) {
        const sources = {
            'google-books': document.getElementById('google-books').checked,
            'open-library': document.getElementById('open-library').checked,
            'books-com': document.getElementById('books-com').checked,
            'kingstone': document.getElementById('kingstone').checked,
            'eslite': document.getElementById('eslite').checked
        };

        // 關閉多選介面
        document.querySelector('.modal').remove();

        // 開啟選中的書庫
        if (sources['books-com']) {
            this.openBooksComSearch(searchTerm);
        }
        if (sources['kingstone']) {
            this.openKingstoneSearch(searchTerm);
        }
        if (sources['eslite']) {
            this.openEsliteSearch(searchTerm);
        }

        // 對於API書庫，執行搜尋並顯示結果
        let apiResults = [];
        
        if (sources['google-books']) {
            this.showToast('正在搜尋 Google Books...', 'info');
            const googleResults = await this.searchFromGoogleBooks(searchTerm);
            apiResults = [...apiResults, ...googleResults];
        }
        
        if (sources['open-library']) {
            this.showToast('正在搜尋 Open Library...', 'info');
            const openLibraryResults = await this.searchFromOpenLibrary(searchTerm);
            apiResults = [...apiResults, ...openLibraryResults];
        }

        // 如果有API結果，顯示搜尋結果
        if (apiResults.length > 0) {
            this.showBookSearchResults(apiResults, searchTerm);
        } else if (!sources['books-com'] && !sources['kingstone'] && !sources['eslite']) {
            this.showToast('請至少選擇一個書庫', 'warning');
        } else {
            this.showToast('已開啟選中的書庫網站', 'info');
        }
    }

    // 全選所有書庫
    selectAllSources() {
        const checkboxes = document.querySelectorAll('.multi-search-grid input[type="checkbox"]');
        checkboxes.forEach(checkbox => checkbox.checked = true);
    }

    // 取消全選所有書庫
    deselectAllSources() {
        const checkboxes = document.querySelectorAll('.multi-search-grid input[type="checkbox"]');
        checkboxes.forEach(checkbox => checkbox.checked = false);
    }

    // 顯示書籍搜尋結果
    showBookSearchResults(books, searchTerm) {
        this.showLoadingIndicator(false);
        
        // 保存搜尋結果供其他函數使用
        this.searchResults = books;

        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 800px;">
                <span class="close">&times;</span>
                <h2><i class="fas fa-search"></i> 書籍搜尋結果</h2>
                <div class="search-results">
                    ${books.map((book, index) => {
                        const info = book.volumeInfo;
                        const coverUrl = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || '';
                        const authors = info.authors ? info.authors.join(', ') : '未知作者';
                        const publisher = info.publisher || '未知出版社';
                        const publishedDate = info.publishedDate ? info.publishedDate.substring(0, 4) : '未知年份';
                        const isbn = info.industryIdentifiers?.find(id => id.type === 'ISBN_13')?.identifier || 
                                     info.industryIdentifiers?.find(id => id.type === 'ISBN_10')?.identifier || '';
                        const description = info.description ? info.description.substring(0, 200) + '...' : '無簡介';

                        return `
                            <div class="search-result-item">
                                <div class="search-result-cover">
                                    ${coverUrl ? `<img src="${coverUrl}" alt="${info.title}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                                    <div class="search-result-cover-placeholder" style="display: none;">
                                        <i class="fas fa-book"></i>
                                    </div>` : `
                                    <div class="search-result-cover-placeholder">
                                        <i class="fas fa-book"></i>
                                    </div>`}
                                </div>
                                <div class="search-result-info">
                                    <div class="search-result-header">
                                        <h3 class="search-result-title">${info.title}</h3>
                                        <span class="search-result-source ${book.source === 'Google Books' ? 'google-books' : book.source === 'Open Library' ? 'open-library' : book.source === '博客來' ? 'books-com' : book.source === '金石堂' ? 'kingstone' : ''}">${book.source || '未知來源'}</span>
                                    </div>
                                    <div class="search-result-details">
                                        <p><strong>作者：</strong>${authors}</p>
                                        <p><strong>出版社：</strong>${publisher}</p>
                                        <p><strong>出版年份：</strong>${publishedDate}</p>
                                        ${isbn ? `<p><strong>ISBN：</strong>${isbn}</p>` : ''}
                                        <p><strong>簡介：</strong>${description}</p>
                                    </div>
                                    <div class="search-result-actions">
                                        <button class="btn btn-primary btn-sm" onclick="library.copyBookInfo(${index})">
                                            <i class="fas fa-copy"></i> 複製資訊
                                        </button>
                                        ${this.isAdminUser() ? `
                                        <button class="btn btn-success btn-sm" onclick="library.addBookFromSearch(${index})">
                                            <i class="fas fa-plus"></i> 新增到館藏
                                        </button>` : ''}
                                    </div>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
                <div class="form-actions">
                    <button type="button" class="btn btn-outline" onclick="this.closest('.modal').remove()">
                        <i class="fas fa-times"></i> 關閉
                    </button>
                </div>
            </div>
        `;

        // 儲存搜尋結果供後續使用
        this.searchResults = books;
        this.searchTerm = searchTerm;

        document.body.appendChild(modal);
        modal.style.display = 'block';

        // 設置關閉事件
        modal.querySelector('.close').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });
    }

    // 複製書籍資訊
    copyBookInfo(index) {
        const book = this.searchResults[index];
        const info = book.volumeInfo;
        
        const authors = info.authors ? info.authors.join(', ') : '未知作者';
        const publisher = info.publisher || '未知出版社';
        const publishedDate = info.publishedDate ? info.publishedDate.substring(0, 4) : '未知年份';
        const isbn = info.industryIdentifiers?.find(id => id.type === 'ISBN_13')?.identifier || 
                     info.industryIdentifiers?.find(id => id.type === 'ISBN_10')?.identifier || '';
        const coverUrl = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || '';

        // 檢查編輯模態框是否開啟
        const editModal = document.getElementById('edit-book-modal');
        const isEditModalOpen = editModal && editModal.style.display === 'block';

        if (isEditModalOpen) {
            // 如果編輯模態框開啟，直接填入表單
            this.fillEditFormWithBookInfo(info.title, authors, coverUrl, publishedDate);
            this.showToast('書籍資訊已填入編輯表單', 'success');
        } else {
            // 否則複製到剪貼簿
            const bookInfo = `書名：${info.title}
作者：${authors}
出版社：${publisher}
出版年份：${publishedDate}
${isbn ? `ISBN：${isbn}` : ''}
封面圖片：${coverUrl}`;

            // 複製到剪貼簿
            navigator.clipboard.writeText(bookInfo).then(() => {
                this.showToast('書籍資訊已複製到剪貼簿', 'success');
            }).catch(() => {
                // 如果剪貼簿 API 失敗，使用傳統方法
                const textArea = document.createElement('textarea');
                textArea.value = bookInfo;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
                this.showToast('書籍資訊已複製到剪貼簿', 'success');
            });
        }
    }

    // 將書籍資訊填入編輯表單
    fillEditFormWithBookInfo(title, author, coverUrl, year) {
        const titleInput = document.getElementById('edit-book-title');
        const authorInput = document.getElementById('edit-book-author');
        const coverInput = document.getElementById('edit-book-cover-url');
        const yearInput = document.getElementById('edit-book-year');

        // 只填入空白的欄位
        if (titleInput && !titleInput.value.trim()) {
            titleInput.value = title;
        }
        if (authorInput && !authorInput.value.trim()) {
            authorInput.value = author;
        }
        if (coverInput && !coverInput.value.trim()) {
            coverInput.value = coverUrl;
        }
        if (yearInput && yearInput.value === this.settings.defaultYear) {
            yearInput.value = year;
        }
    }

    // 從搜尋結果新增書籍
    addBookFromSearch(index) {
        const book = this.searchResults[index];
        const info = book.volumeInfo;
        
        // 預填新增書籍表單
        const suggestedId = this.suggestNextBookId();
        const idEl = document.getElementById('book-id');
        if (idEl && !idEl.value.trim()) idEl.value = suggestedId;
        document.getElementById('book-title').value = info.title || '';
        document.getElementById('book-author').value = info.authors ? info.authors.join(', ') : '';
        document.getElementById('book-year').value = info.publishedDate ? info.publishedDate.substring(0, 4) : new Date().getFullYear();
        document.getElementById('book-cover-url').value = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || '';
        
        // 關閉搜尋結果模態框
        document.querySelector('.modal').remove();
        
        // 顯示新增書籍模態框
        this.showAddBookModal();
        
        this.showToast('已將書籍資訊填入新增表單', 'success');
    }

}

// 初始化系統
const library = new LibrarySystem();

// 全域函數（供HTML調用）
window.library = library;
