// =========================================================================
// scanTaskKey.js —— 扫描任务键的单一实现（主进程 scanWorker + worker.scan 共用）
//
// 各库的 albums.id / album_scan_tasks.album_id 都**各库独立自增**。任何以裸 albumId
// 为键的 Map（派活去重 dispatched、主进程任务视图 active、worker 的 running /
// pendingStops）都会在两班同号相册时塌缩：
//   · 派活去重把另一班的任务挡掉（同号第二班永远扫不起来）；
//   · 暂停/停止取到另一班的任务 token，误暂停/误停别人的扫描；
//   · done/error 消息按裸 id 清理，把另一班的任务记录一起删掉。
// 键必须 (slug, albumId) 复合。slug 为空（老消息/异常路径）时退回裸 id，
// 保持旧行为不崩，但正常流程所有消息都带 slug。
// =========================================================================

function scanTaskKey(slug, albumId) {
  return slug ? `${slug}|${albumId}` : String(albumId);
}

module.exports = { scanTaskKey };
