const THRESHOLD = 9;
const PAGE = 100;
// Service Worker が同期の途中で停止すると status が running のまま残るため、古いものは無視する
const STALE_MS = 3 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const tpl = $('row-tpl');

let comments = [];
let selectedYear = null;
let rankLimit = PAGE;

function watchUrl(c) {
  return `https://www.nicovideo.jp/watch/${c.videoId}?from=${Math.floor(c.vpos / 100)}`;
}

function formatPos(vpos) {
  const s = Math.floor(vpos / 100);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function renderRow(c, rank) {
  const li = tpl.content.firstElementChild.cloneNode(true);
  if (rank != null) {
    const r = document.createElement('span');
    r.className = 'rank';
    r.textContent = `${rank}位`;
    li.prepend(r);
  }
  li.querySelector('.count').textContent = c.max;
  li.querySelector('.text').textContent = c.body;
  const a = li.querySelector('.video');
  a.textContent = c.title;
  if (c.videoId) a.href = watchUrl(c);
  li.querySelector('.pos').textContent = formatPos(c.vpos);
  li.querySelector('.posted').textContent = `投稿 ${c.postedAt.slice(0, 10)}`;
  li.querySelector('.owner').hidden = !c.ownerNicoru;
  li.querySelector('.deleted').hidden = !c.deleted;
  return li;
}

function byCountDesc(a, b) {
  return b.max - a.max || b.postedAt.localeCompare(a.postedAt);
}

// ---- 月別 ----

// 削除された動画のコメントは本文が置き換えられて中身がわからないため、既定で隠す
function visible() {
  return $('hide-deleted').checked ? comments.filter((c) => !c.deleted) : comments;
}

function renderMonthly() {
  // postedAt は +09:00 表記なので先頭 7 文字がそのまま日本時間の年月になる
  const hits = visible().filter((c) => c.max >= THRESHOLD);
  const byMonth = new Map();
  for (const c of hits) {
    const ym = c.postedAt.slice(0, 7);
    if (!byMonth.has(ym)) byMonth.set(ym, []);
    byMonth.get(ym).push(c);
  }
  const years = [...new Set([...byMonth.keys()].map((ym) => ym.slice(0, 4)))].sort().reverse();
  if (!years.includes(selectedYear)) selectedYear = years[0] ?? null;

  const yearsEl = $('years');
  yearsEl.replaceChildren(
    ...years.map((y) => {
      const n = [...byMonth].filter(([ym]) => ym.startsWith(y)).reduce((s, [, v]) => s + v.length, 0);
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `${y}年（${n}）`;
      b.setAttribute('aria-pressed', String(y === selectedYear));
      b.onclick = () => {
        selectedYear = y;
        renderMonthly();
      };
      return b;
    }),
  );

  const months = [...byMonth.keys()].filter((ym) => ym.startsWith(selectedYear)).sort().reverse();
  $('months').replaceChildren(
    ...months.map((ym) => {
      const list = byMonth.get(ym).sort(byCountDesc);
      const sec = document.createElement('section');
      sec.className = 'month';
      const h = document.createElement('h2');
      h.textContent = `${Number(ym.slice(5))}月`;
      const small = document.createElement('small');
      small.textContent = `${list.length}件`;
      h.append(small);
      const ol = document.createElement('ol');
      ol.className = 'list';
      ol.append(...list.map((c) => renderRow(c)));
      sec.append(h, ol);
      return sec;
    }),
  );
}

// ---- ランキング ----

function renderRanking() {
  const q = $('search').value.trim().toLowerCase();
  const all = visible()
    .filter((c) => !q || c.body.toLowerCase().includes(q) || c.title.toLowerCase().includes(q))
    .sort(byCountDesc);

  // 同数は同順位にする（1, 2, 2, 4 …）
  const ranks = [];
  all.forEach((c, i) => ranks.push(i > 0 && c.max === all[i - 1].max ? ranks[i - 1] : i + 1));

  $('rank-summary').textContent = `${all.length}件のコメント（1回以上ニコられたもの）`;
  $('rank-list').replaceChildren(...all.slice(0, rankLimit).map((c, i) => renderRow(c, ranks[i])));
  $('more').hidden = all.length <= rankLimit;
}

// ---- 状態表示 ----

function formatDate(iso) {
  return new Date(iso).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
}

function renderStatus(status, meta) {
  const el = $('status');
  const btn = $('sync-btn');
  const isRunning = status?.state === 'running' && Date.now() - new Date(status.at).getTime() < STALE_MS;
  btn.disabled = isRunning;
  el.classList.toggle('error', status?.state === 'error');
  if (isRunning) {
    el.textContent = `更新中… ${status.added ?? 0}件取得`;
  } else if (status?.state === 'error') {
    el.textContent = `更新失敗: ${status.error}`;
  } else if (meta?.lastSyncAt) {
    el.textContent = `最終更新 ${formatDate(meta.lastSyncAt)}（+${meta.lastAdded ?? 0}件）`;
  } else {
    el.textContent = '未取得';
  }
}

async function refresh() {
  const s = await chrome.storage.local.get(['comments', 'meta', 'status']);
  comments = Object.values(s.comments ?? {});
  $('empty').hidden = comments.length > 0;
  renderStatus(s.status, s.meta);
  renderMonthly();
  renderRanking();
}

// ---- イベント ----

document.querySelectorAll('.tabs button').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== tab.dataset.view));
  };
});

$('sync-btn').onclick = () => chrome.runtime.sendMessage({ type: 'sync' });
$('search').oninput = () => {
  rankLimit = PAGE;
  renderRanking();
};
$('hide-deleted').onchange = () => {
  rankLimit = PAGE;
  renderMonthly();
  renderRanking();
};
$('more').onclick = () => {
  rankLimit += PAGE;
  renderRanking();
};

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (changes.comments || changes.meta) {
    await refresh();
  } else if (changes.status) {
    const { meta } = await chrome.storage.local.get('meta');
    renderStatus(changes.status.newValue, meta);
  }
});

refresh();
