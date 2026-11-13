// ニコられた履歴（1 ニコる = 1 イベント）をコメント単位に集約する同期ロジック。
// chrome.* に依存しないので、Node のテストやページ上でもそのまま動かせる。

export const API = 'https://nvapi.nicovideo.jp/v1/users/me/nicoru/receive';
export const API_HEADERS = { 'X-Frontend-Id': '6', 'X-Frontend-Version': '0' };

export function pageUrl(cursor) {
  const url = new URL(API);
  url.searchParams.set('pageSize', '100');
  if (cursor) url.searchParams.set('cursor', cursor);
  return url.toString();
}

// 本文は後から変わりうる（削除など）ので、動画・再生位置・投稿日時でコメントを識別する
export function commentKey(item) {
  return `${item.video?.id ?? 'unknown'}|${item.commentVpos}|${item.commentCreatedAt}`;
}

export function mergeItem(comments, item) {
  const key = commentKey(item);
  const count = Math.max(item.count ?? 0, item.totalCount ?? 0);
  const prev = comments[key];
  if (!prev) {
    comments[key] = {
      key,
      videoId: item.video?.id ?? null,
      title: item.video?.title ?? '(不明な動画)',
      thumbnail: item.video?.thumbnail?.listingUrl ?? null,
      vpos: item.commentVpos ?? 0,
      body: item.commentBody ?? '',
      postedAt: item.commentCreatedAt,
      max: count,
      lastNicoruAt: item.createdAt,
      ownerNicoru: !!item.isVideoOwnerNicoru,
      deleted: !!item.isDeletedComment,
    };
    return;
  }
  prev.max = Math.max(prev.max, count);
  prev.ownerNicoru ||= !!item.isVideoOwnerNicoru;
  // 日時はすべて +09:00 の同一書式なので文字列比較で前後を判定できる
  if (item.createdAt > prev.lastNicoruAt) {
    prev.lastNicoruAt = item.createdAt;
    if (item.video?.title) prev.title = item.video.title;
    prev.deleted = !!item.isDeletedComment;
    if (item.commentBody) prev.body = item.commentBody;
  }
}

/**
 * 新しい順にページを辿り、前回同期の最新イベント ID に到達したら止める（差分同期）。
 * イベント ID は ULID なので文字列比較で新旧を判定できる。
 * 途中で中断されても resume から再開でき、集約は max ベースなので重複取り込みしても結果は変わらない。
 */
export async function syncCore({ fetchPage, load, save, onProgress, saveEvery = 25 }) {
  const { comments, meta, resume } = await load();
  const stopId = meta.newestId ?? null;
  let cursor = resume?.cursor ?? null;
  let topId = resume?.topId ?? null;
  let pages = resume?.pages ?? 0;
  let added = resume?.added ?? 0;
  let done = false;

  while (!done) {
    const data = await fetchPage(cursor);
    for (const item of data.items ?? []) {
      if (stopId && item.id <= stopId) {
        done = true;
        break;
      }
      topId ??= item.id;
      mergeItem(comments, item);
      added++;
    }
    pages++;
    cursor = data.next ?? null;
    if (!cursor) done = true;
    await onProgress?.({ pages, added });
    if (!done && pages % saveEvery === 0) {
      await save({ comments, resume: { cursor, topId, pages, added } });
    }
  }

  const newMeta = {
    ...meta,
    newestId: topId ?? stopId,
    lastSyncAt: new Date().toISOString(),
    lastAdded: added,
  };
  await save({ comments, meta: newMeta, resume: null });
  return { pages, added };
}
