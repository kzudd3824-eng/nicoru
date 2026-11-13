import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeItem, syncCore, pageUrl } from '../lib/sync.js';

// ULID 風の昇順 ID と、同じ書式の日時を作る
const id = (n) => `01M${String(n).padStart(23, '0')}`;
const at = (n) => `2026-11-${String(1 + Math.floor(n / 100)).padStart(2, '0')}T00:00:${String(n % 60).padStart(2, '0')}+09:00`;

function ev(n, { video = 'sm1', vpos = 100, posted = '2026-10-01T00:00:00+09:00', count, body = 'こめ' } = {}) {
  return {
    id: id(n),
    count,
    totalCount: count,
    createdAt: at(n),
    commentBody: body,
    commentCreatedAt: posted,
    commentVpos: vpos,
    video: { id: video, title: `title-${video}`, thumbnail: { listingUrl: null } },
    isVideoOwnerNicoru: false,
    isDeletedComment: false,
  };
}

// 新しい順に並んだイベント列を pageSize 件ずつ返す偽 API
function fakeApi(eventsNewestFirst, pageSize = 3) {
  let calls = 0;
  const fetchPage = async (cursor) => {
    calls++;
    const start = cursor ? Number(cursor) : 0;
    const items = eventsNewestFirst.slice(start, start + pageSize);
    const next = start + pageSize < eventsNewestFirst.length ? String(start + pageSize) : null;
    return { items, next };
  };
  return { fetchPage, calls: () => calls };
}

function memStore(initial = {}) {
  const s = { comments: {}, meta: {}, resume: null, ...initial };
  return {
    s,
    load: async () => structuredClone({ comments: s.comments, meta: s.meta, resume: s.resume }),
    save: async ({ comments, meta, resume }) => {
      s.comments = structuredClone(comments);
      if (meta) s.meta = meta;
      if (resume !== undefined) s.resume = resume;
    },
  };
}

test('mergeItem は同じコメントの最大ニコる数を残す', () => {
  const c = {};
  mergeItem(c, ev(1, { count: 1 }));
  mergeItem(c, ev(3, { count: 3 }));
  mergeItem(c, ev(2, { count: 2 }));
  const v = Object.values(c);
  assert.equal(v.length, 1);
  assert.equal(v[0].max, 3);
  assert.equal(v[0].lastNicoruAt, at(3));
});

test('同じ本文でも投稿日時や位置が違えば別コメントとして扱う', () => {
  const c = {};
  mergeItem(c, ev(1, { count: 5, posted: '2026-10-01T00:00:00+09:00' }));
  mergeItem(c, ev(2, { count: 2, posted: '2026-10-02T00:00:00+09:00' }));
  mergeItem(c, ev(3, { count: 1, vpos: 999 }));
  assert.equal(Object.keys(c).length, 3);
});

test('初回は全件、2 回目は新着分だけ取得する', async () => {
  const events = [];
  for (let n = 10; n >= 1; n--) events.push(ev(n, { count: n, video: `sm${n % 3}` }));
  const store = memStore();
  const api1 = fakeApi(events);
  const r1 = await syncCore({ fetchPage: api1.fetchPage, load: store.load, save: store.save });
  assert.equal(r1.added, 10);
  assert.equal(store.s.meta.newestId, id(10));
  assert.equal(Object.keys(store.s.comments).length, 3);

  const events2 = [ev(12, { count: 20, video: 'sm0' }), ev(11, { count: 11, video: 'sm9' }), ...events];
  const api2 = fakeApi(events2);
  const r2 = await syncCore({ fetchPage: api2.fetchPage, load: store.load, save: store.save });
  assert.equal(r2.added, 2);
  assert.equal(api2.calls(), 1);
  assert.equal(store.s.meta.newestId, id(12));
  const sm0 = Object.values(store.s.comments).find((c) => c.videoId === 'sm0');
  assert.equal(sm0.max, 20);
  assert.equal(Object.keys(store.s.comments).length, 4);
});

test('途中で中断しても再開して最後まで取り込める', async () => {
  const events = [];
  for (let n = 30; n >= 1; n--) events.push(ev(n, { count: n, vpos: n }));
  const store = memStore();
  const api = fakeApi(events, 3);
  let failAt = 5;
  const flaky = async (cursor) => {
    if (--failAt === 0) throw new Error('SW 停止を模擬');
    return api.fetchPage(cursor);
  };
  await assert.rejects(syncCore({ fetchPage: flaky, load: store.load, save: store.save, saveEvery: 2 }));
  assert.ok(store.s.resume, '途中経過が保存されている');
  assert.equal(store.s.meta.newestId, undefined, '完了前は newestId を更新しない');

  const r = await syncCore({ fetchPage: api.fetchPage, load: store.load, save: store.save, saveEvery: 2 });
  assert.equal(store.s.resume, null);
  assert.equal(store.s.meta.newestId, id(30));
  assert.equal(Object.keys(store.s.comments).length, 30);
  assert.equal(r.added, 30);
});

test('pageUrl は cursor を付ける', () => {
  assert.match(pageUrl(null), /pageSize=100$/);
  assert.match(pageUrl('ABC'), /cursor=ABC/);
});
