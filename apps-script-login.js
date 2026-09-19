// 博幼圖書館登入驗證（Google Apps Script）
// 部署為 Web App：執行身分 = 我，存取對象 = 任何人（含未登入使用者）
// 所需試算表工作表：Users，欄位：username | phone | role
// 前端傳送格式：{ action: 'login', payload: { username, phone } }

const SPREADSHEET_ID = '1sBfSMhJ21j_2dC7ZTcmOsK_EEw53HEl0elIywZH-qDA';
const FEEDBACK_SHEET_NAMES = ['表單回覆 1', 'Form_Responses', 'Form Responses', '表單回應', '表單回應 1', 'Form Responses 1'];

function getSpreadsheet_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const req = params.payload ? JSON.parse(params.payload) : {};
    return handleRequest_(req, 'GET');
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  try {
    const bodyText = (e && e.postData && e.postData.contents) ? e.postData.contents : '';
    const req = bodyText ? JSON.parse(bodyText) : {};
    return handleRequest_(req, 'POST');
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function handleRequest_(req, method) {
  const action = req.action;

  if (action === 'replyFeedback') {
    if (method !== 'POST') return json_({ ok: false, error: '回覆必須使用 POST' });
    return json_({ ok: true, data: saveFeedbackReply_(req.payload || {}) });
  }

  if (action === 'login') {
    const payload = req.payload || {};
    const username = String(payload.username || '').trim();
    const phone = String(payload.phone || '').trim();

    if (!username || !phone) {
      return json_({ ok: false, error: 'Missing username or phone' });
    }

    const user = findUser_(username, phone);
    if (user) {
      return json_({ ok: true, data: { role: user.role || 'student' } });
    }

    return json_({ ok: false, error: '使用者名稱或電話不正確' });
  }

  if (action === 'getFeedback') {
    const feedback = readFeedback_();
    return json_({ ok: true, data: feedback });
  }

  return json_({ ok: false, error: 'Unknown action: ' + String(action) });
}

function findUser_(username, phone) {
  const sh = getSheet_('Users');
  const values = sh.getDataRange().getValues();
  if (values.length <= 1) return null;

  const header = values[0];
  const idx = indexMap_(header);

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const u = String(row[idx.username] || '').trim();
    const p = String(row[idx.phone] || '').trim();
    if (u === username && p === phone) {
      return {
        username: u,
        phone: p,
        role: String(row[idx.role] || 'student')
      };
    }
  }

  return null;
}

function getFeedbackSheet_() {
  const ss = getSpreadsheet_();
  let sh = null;
  for (const name of FEEDBACK_SHEET_NAMES) {
    sh = ss.getSheetByName(name);
    if (sh) break;
  }
  if (!sh) {
    const available = ss.getSheets().map(s => s.getName()).join(', ');
    throw new Error('找不到留言工作表。可用的工作表：' + available);
  }

  return sh;
}

// 以原始留言內容辨識留言，排序或插入列後仍不會寫錯列。
function feedbackId_(header, row) {
  const original = header.map((name, i) => [String(name), row[i] instanceof Date ? row[i].toISOString() : String(row[i] || '')])
    .filter(([name]) => !['管理員回復', '管理員回覆', '第 6 欄', '回覆者', '回覆時間'].includes(name.trim()));
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(original))
    .map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}

function saveFeedbackReply_(payload) {
  const username = String(payload.username || '').trim();
  if (!['sindy16872000', 'boyo1314'].includes(username)) {
    throw new Error('只有管理員帳號可以回復留言');
  }
  const reply = String(payload.reply || '').trim();
  if (!reply || reply.length > 2000) throw new Error('請填寫 1 至 2000 字的回覆');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = getFeedbackSheet_();
    const values = sh.getDataRange().getValues();
    const header = values[0].map(String);
    const matches = [];
    for (let i = 1; i < values.length; i++) {
      if (feedbackId_(header, values[i]) === payload.id) matches.push(i);
    }
    if (matches.length !== 1) throw new Error('留言已變更或無法唯一辨識，請重新開啟留言板');
    const row = matches[0];
    const replyIndex = 6;
    if (!['管理員回復', '管理員回覆', '第 6 欄', ''].includes(String(header[6] || '').trim())) throw new Error('G 欄不是管理員回復欄位，請確認工作表設定');
    const previous = replyIndex < 0 ? '' : String(values[row][replyIndex] || '').trim();
    if (previous !== String(payload.previousReply || '')) throw new Error('這則回覆已被更新，請重新開啟留言板後再編輯');
    const time = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm:ss');
    const fields = [['管理員回復', reply], ['回覆者', username], ['回覆時間', time]];
    fields.forEach(([name, value]) => {
      let index = name === '管理員回復' ? 6 : header.indexOf(name);
      if (name === '管理員回復' && header[6] !== name) { header[6] = name; sh.getRange(1, 7).setValue(name); }
      if (index < 0) {
        index = header.length;
        header.push(name);
        sh.getRange(1, index + 1).setValue(name);
      }
      // 以純文字寫入，避免把回覆當成試算表公式。
      sh.getRange(row + 1, index + 1).setNumberFormat('@').setValue("'" + value);
    });
    SpreadsheetApp.flush();
    return { reply, replyBy: username, replyAt: time };
  } finally {
    lock.releaseLock();
  }
}

function readFeedback_() {
  const sh = getFeedbackSheet_();
  const values = sh.getDataRange().getValues();
  if (values.length <= 1) return [];

  const header = values[0];
  const keys = header.map(normalizeFeedbackHeader_);

  const result = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const item = {};
    for (let j = 0; j < keys.length; j++) {
      const key = keys[j] || ('col' + (j + 1));
      let value = row[j];
      if (value instanceof Date) {
        value = Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm:ss');
      } else {
        value = String(value || '').trim();
      }
      item[key] = value;
    }
    item.reply = String(row[6] || item.reply || '').trim();
    item.id = feedbackId_(header, row);
    result.push(item);
  }

  return result.reverse();
}

function normalizeFeedbackHeader_(header) {
  const h = String(header || '').trim();
  const map = {
    '時間戳記': 'timestamp',
    '姓名': 'name',
    '名稱': 'name',
    '電子郵件': 'email',
    '電話': 'phone',
    '連絡電話': 'phone',
    '留言類型': 'type',
    '留言內容': 'message',
    '備註': 'notes',
    '管理員回覆': 'reply',
    '管理員回復': 'reply',
    '回覆者': 'replyBy',
    '回覆時間': 'replyAt'
  };
  return map[h] || h;
}

function getSheet_(name) {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, 3).setValues([['username', 'phone', 'role']]);
  }
  return sh;
}

function indexMap_(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => {
    map[String(h || '').trim()] = i;
  });
  return {
    username: map.username ?? 0,
    phone: map.phone ?? 1,
    role: map.role ?? 2
  };
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
