import { API_HEADERS, pageUrl, syncCore } from './lib/sync.js';

const ALARM = 'nicoru-sync';
const SYNC_INTERVAL_MIN = 360; // 6 時間ごと
const NICO_TAB_PATTERN = 'https://www.nicovideo.jp/*';

let running = null;

async function load() {
  const s = await chrome.storage.local.get(['comments', 'meta', 'resume']);
  return { comments: s.comments ?? {}, meta: s.meta ?? {}, resume: s.resume ?? null };
}

async function save({ comments, meta, resume }) {
  const out = { comments };
  if (meta) out.meta = meta;
  if (resume) out.resume = resume;
  await chrome.storage.local.set(out);
  if (resume === null) await chrome.storage.local.remove('resume');
}

function setStatus(status) {
  return chrome.storage.local.set({ status: { ...status, at: new Date().toISOString() } });
}

class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

async function fetchDirect(url) {
  const res = await fetch(url, { credentials: 'include', headers: API_HEADERS });
  if (!res.ok) throw new HttpError(res.status);
  return (await res.json()).data;
}

// 拡張から直接だと Cookie が付かない環境向けに、開いている nicovideo.jp タブの中で取得する
async function fetchViaTab(url) {
  const [tab] = await chrome.tabs.query({ url: NICO_TAB_PATTERN });
  if (!tab) {
    throw new Error('ログイン状態を確認できませんでした。nicovideo.jp にログインしたタブを開いてから更新してください');
  }
  const [r] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async (u, h) => {
      const res = await fetch(u, { credentials: 'include', headers: h });
      return { status: res.status, body: res.ok ? await res.json() : null };
    },
    args: [url, API_HEADERS],
  });
  if (r.result.status !== 200) throw new HttpError(r.result.status);
  return r.result.body.data;
}

async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = e instanceof HttpError && (e.status === 429 || e.status >= 500);
      if (!retryable || attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
}

function makeFetchPage() {
  let viaTab = false;
  return async (cursor) => {
    const url = pageUrl(cursor);
    if (!viaTab) {
      try {
        return await withRetry(() => fetchDirect(url));
      } catch (e) {
        const authFailed = (e instanceof HttpError && (e.status === 401 || e.status === 403)) || e instanceof TypeError;
        if (!authFailed) throw e;
        viaTab = true;
      }
    }
    return withRetry(() => fetchViaTab(url));
  };
}

async function doSync() {
  await setStatus({ state: 'running', pages: 0, added: 0 });
  try {
    const result = await syncCore({
      fetchPage: makeFetchPage(),
      load,
      save,
      onProgress: ({ pages, added }) => (pages % 5 === 0 ? setStatus({ state: 'running', pages, added }) : undefined),
    });
    await setStatus({ state: 'idle', ...result });
  } catch (e) {
    await setStatus({ state: 'error', error: e.message });
  }
}

function runSync() {
  running ??= doSync().finally(() => {
    running = null;
  });
  return running;
}

async function ensureAlarm() {
  if (!(await chrome.alarms.get(ALARM))) {
    await chrome.alarms.create(ALARM, { periodInMinutes: SYNC_INTERVAL_MIN, delayInMinutes: SYNC_INTERVAL_MIN });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  runSync();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  runSync();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) runSync();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'sync') {
    runSync();
    sendResponse({ ok: true });
  }
});

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('dashboard.html');
  const [tab] = await chrome.tabs.query({ url });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});
