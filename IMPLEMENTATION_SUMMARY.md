# 書單快取機制 - 實現總結

## 📋 實現概況

本次實現為博幼圖書館管理系統添加了「一般使用者書單雲端快取機制」，旨在減少不必要的雲端下載，提升系統響應速度。

## ✅ 已完成的功能

### 1. 快取系統核心函數
在 `LibrarySystem` 類中添加了以下函數：

- **`initCacheSystem()`**
  - 在系統初始化時調用
  - 從 localStorage 讀取快取狀態

- **`checkShouldUpdateBookList()`**
  - 檢查是否應該從雲端更新書單
  - 邏輯：
    1. 檢查今天是否已下載過
    2. 如果已下載，檢查版本是否更新
    3. 根據結果決定是否需要重新下載

- **`saveBookListCache(books, borrowedBooks)`**
  - 保存書單到 localStorage
  - 記錄下載日期

- **`loadBookListCache()`**
  - 從 localStorage 加載書單
  - 返回快取的書籍列表

- **`updateBookListVersion(timestamp)`**
  - 更新書單版本時間戳
  - 標記為"剛剛更新"

- **`clearBookListCache()`**
  - 清除所有快取數據
  - 用於強制刷新

- **`getCacheStatus()`**
  - 獲取當前快取狀態信息
  - 用於調試和監控

### 2. 修改的核心流程

#### `autoLoadFromGoogleSheets()`
- 在載入前檢查是否需要更新
- 如果不需要更新，從快取加載
- 如果需要更新，從雲端下載
- 成功後保存快取和版本信息
- 失敗時嘗試加載快取作為備選

#### `handleAddBook()`
- 新增書籍後調用 `updateBookListVersion()`
- 讓普通用戶下次訪問時重新下載

#### `handleEditBook()`
- 編輯書籍後調用 `updateBookListVersion()`
- 自動同步到 Google Sheets

#### `confirmDeleteBook()`
- 刪除書籍後調用 `updateBookListVersion()`
- 自動同步到 Google Sheets

#### `pushToGoogleSheets()`
- 上傳後調用 `updateBookListVersion()`
- 確保雲端版本已更新

### 3. 新增的使用者功能

#### 「重新整理書單」按鈕
- **位置**：主控制面板（Google Sheets 載入按鈕之後）
- **權限**：任何使用者可用（不需要管理員權限）
- **功能**：
  1. 清除本地快取
  2. 強制從雲端重新下載書單
  3. 更新 UI
  4. 顯示成功消息

- **實現函數**：`refreshBookList()`

### 4. localStorage 鍵值

系統使用以下新增的 localStorage 鍵值：

| 鍵值 | 用途 | 類型 |
|------|------|------|
| `lib_cache_version` | 記錄當前書單版本時間戳 | String (ISO timestamp) |
| `lib_cache_download_date` | 記錄上次下載日期 | String (YYYY-MM-DD) |
| `lib_books_cache_v1` | 快取的書籍列表 | JSON 字符串 |

原有的 localStorage 鍵值保持不變：
- `lib_books_v1` - 書籍列表
- `lib_borrowed_v1` - 借閱記錄
- `lib_users_v1` - 用戶列表
- `lib_active_user_v1` - 當前活躍用戶
- `lib_settings_v1` - 系統設置
- `lib_boyou_books_v1` - 博幼藏書信息

## 🔄 工作流程

### 網站首次載入
```
1. 調用 init()
   ↓
2. 調用 initCacheSystem() - 初始化快取
   ↓
3. 調用 autoLoadFromGoogleSheets()
   ↓
4. 調用 checkShouldUpdateBookList() - 檢查是否需要更新
   ├─ 返回 true（需要更新）
   │   ↓
   │   5a. 從雲端下載書單
   │   ↓
   │   5b. 保存快取和版本信息
   │   ↓
   │   6a. 顯示書單
   │
   └─ 返回 false（不需要更新）
       ↓
       5c. 從快取加載書單
       ↓
       6b. 顯示書單
```

### 管理員新增書籍
```
1. 點擊「新增館藏」
   ↓
2. 填寫表單並提交
   ↓
3. handleAddBook() 執行
   ├─ 驗證數據
   ├─ 添加到 this.books
   ├─ 調用 saveData()
   ├─ 調用 pushToGoogleSheetsNow() - 同步到雲端
   ├─ 調用 updateBookListVersion() - 標記版本已更新
   ├─ 刷新 UI
   └─ 顯示成功消息
   ↓
4. 普通用戶下次訪問時會檢測到版本變更
   ↓
5. 自動重新下載最新書單
```

### 用戶手動刷新
```
1. 點擊「重新整理書單」
   ↓
2. refreshBookList() 執行
   ├─ 調用 clearBookListCache() - 清除快取
   ├─ 調用 autoLoadFromGoogleSheets() - 重新下載
   ├─ 刷新 UI
   └─ 顯示成功消息
```

## 📊 快取檢查邏輯

```javascript
checkShouldUpdateBookList() {
    今天的日期 = 獲取當前日期 (YYYY-MM-DD)
    上次下載日期 = 從 localStorage 讀取
    
    if (上次下載日期 !== 今天) {
        // 新的一天，需要下載
        return true
    }
    
    try {
        本地版本 = 從 localStorage 讀取
        雲端版本 = 從 Google Sheets 取得
        
        if (雲端版本 !== 本地版本) {
            // 版本不同，需要下載
            return true
        }
        
        // 版本相同，使用快取
        return false
    } catch (error) {
        // 版本檢查失敗，使用快取
        return false
    }
}
```

## 🎯 完成的需求檢查

### ✅ 一般使用者需求
- ✅ 每天最多從雲端下載書單一次
- ✅ 如果今天已下載過，就直接讀取 localStorage 快取
- ✅ 除非雲端資料有更新，才重新下載
- ✅ 切換列表/圖示/橫式顯示時，不重新下載
- ✅ 搜尋書籍時，不重新下載
- ✅ 點擊單本書、系列書、借閱按鈕時，不重新下載
- ✅ 只有四種情況才重新下載：
  - ✅ 今天第一次進入網站
  - ✅ 管理員新增/修改/刪除書籍後
  - ✅ 偵測到雲端版本有更新
  - ✅ 用戶手動按「重新整理書單」

### ✅ 管理員需求
- ✅ 新增、修改、刪除書籍後，可重新同步雲端資料
- ✅ 更新資料後，自動更新書單版本時間
- ✅ 普通用戶下次偵測到版本不同時，才重新下載

### ✅ 限制條件檢查
- ✅ 不重構整個項目
- ✅ 不刪除原本功能
- ✅ 不刪除 localStorage
- ✅ 不改變 Google Sheet 原本欄位資料
- ✅ 不破壞搜尋功能
- ✅ 不破壞借閱功能
- ✅ 不破壞系列書顯示
- ✅ 不破壞單本書顯示
- ✅ 不破壞管理員新增書籍功能
- ✅ 只新增快取與版本檢查機制

## 📁 修改的文件

### 1. `script.js`
- 添加快取系統函數
- 修改 `init()` 函數
- 修改 `autoLoadFromGoogleSheets()` 函數
- 修改 `handleAddBook()` 函數
- 修改 `handleEditBook()` 函數
- 修改 `confirmDeleteBook()` 函數
- 修改 `pushToGoogleSheets()` 函數
- 添加 `refreshBookList()` 函數
- 修改 `setupEventListeners()` 函數
- 修改 `checkShouldUpdateBookList()` 函數的實現

### 2. `index.html`
- 添加「重新整理書單」按鈕

### 3. 新增文件
- `CACHE_MECHANISM.md` - 詳細技術文檔
- `CACHE_QUICK_GUIDE.md` - 用戶快速指南

## 🔍 測試建議

### 功能測試
1. **首次訪問測試**
   - 打開新瀏覽器/隱私模式
   - 觀察是否從雲端下載
   - 檢查 localStorage 是否創建了快取鍵值

2. **快取複用測試**
   - 刷新頁面
   - 觀察控制台是否看到 `[快取策略]` 日誌
   - 確認沒有從雲端重新下載

3. **管理員操作測試**
   - 管理員新增書籍
   - 觀察版本是否更新
   - 用普通用戶訪問，確認自動下載了新書籍

4. **手動刷新測試**
   - 點擊「重新整理書單」
   - 確認快取被清除
   - 確認強制重新下載

### 效能測試
- 記錄首次訪問時間（3-5 秒）
- 記錄後續訪問時間（< 0.1 秒）
- 對比改進效果

### 邊界情況測試
- 斷網後訪問（應使用快取）
- 跨天訪問（應重新下載）
- localStorage 已滿（應處理錯誤）
- 版本檢查失敗（應使用快取作為備選）

## 📝 日誌輸出

### 快取相關日誌（[快取] 標籤）
系統會在瀏覽器控制台輸出以下日誌幫助調試：

```
[快取] 今天第一次進入，需要下載。上次下載日期: null, 今天: 2026-06-04
[快取] 已保存書單快取，日期: 2026-06-04, 書籍數: 150
[快取] 成功加載快取書單，書籍數: 150, 快取日期: 2026-06-04
[快取策略] 不需要更新，嘗試從快取加載
[快取策略] 成功加載快取書籍 150 本
[快取] 已更新書單版本: 2026-06-04T10:30:00.000Z
```

### 使用者操作日誌
```
[使用者操作] 重新整理書單 - 清除快取
[快取] 已清除書單快取
```

## 🚀 部署注意事項

1. **瀏覽器兼容性**
   - localStorage 支持所有現代瀏覽器
   - IE11 及以上版本支持

2. **安全考慮**
   - 快取完全本地化，不涉及服務器
   - 不存儲敏感信息

3. **性能考慮**
   - localStorage 限制通常為 5-10 MB
   - 快取大小通常 < 1 MB

4. **升級路徑**
   - 現有用戶的快取會在系統升級後自動更新
   - 無需清除現有 localStorage

## 📞 故障排查指南

### 快取不工作
**檢查項：**
1. 瀏覽器開發者工具 → Application → Local Storage
2. 搜索 `lib_cache_` 開頭的鍵值
3. 查看瀏覽器控制台的 `[快取]` 日誌

### 版本不同步
**檢查項：**
1. 確認管理員已完成同步
2. 檢查 Google Sheets 應用程式是否正常
3. 查看 `lib_cache_version` 是否有時間戳

### 效能未改善
**檢查項：**
1. 確認快取已啟用（檢查 localStorage）
2. 確認用戶在同一天訪問
3. 查看網路連接速度

## 🎓 開發者注意事項

### 添加新功能時
1. 如果涉及書籍數據修改，記得調用 `updateBookListVersion()`
2. 如果涉及雲端同步，記得調用 `pushToGoogleSheetsNow()`
3. 如果需要強制刷新，調用 `clearBookListCache()`

### 調試快取問題
1. 打開瀏覽器控制台
2. 執行 `library.getCacheStatus()` 查看快取狀態
3. 執行 `library.clearBookListCache()` 清除快取
4. 刷新頁面重新測試

### 監控快取性能
在 `checkShouldUpdateBookList()` 前後記錄時間戳：
```javascript
const start = performance.now();
const shouldUpdate = await this.checkShouldUpdateBookList();
const duration = performance.now() - start;
console.log(`版本檢查耗時: ${duration.toFixed(2)}ms`);
```
