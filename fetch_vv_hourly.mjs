// 灯塔「正片播放 · 分时」采集 —— 嫁金钗
//
// 为什么要自己攒：这个接口只回"今天到此刻"的格子，昨天的一律拿不到
// （showDate / date / bizDate / queryDate / dateRange 五个参数 10-20 实测全部被忽略，
//   永远回当天那 17~23 行）。所以这个文件必须"读旧-合并-写新"，不能整份覆盖。
//
// 环境变量：
//   VVH_OUT    产出路径，默认 vv-hourly.json
//   VVH_KEEP   最多留多少天，默认 30
//   VVH_PROBE  只探连通性、不写文件（用来验 Actions 的机房 IP 能不能取到数）
//   VVH_MTOP   签名代理，默认 https://proxy.jiuchu.asia/mtop
//
// 取的是 platform:'ALL'（灯塔全网口径），和看板上「今日实时播放量」那几张卡同一个口径。
// 传 youku 会偏高一截（同一分钟 ALL 387.3 万 / youku 698.3 万），别混。

import fs from 'node:fs';

const MTOP = process.env.VVH_MTOP || 'https://proxy.jiuchu.asia/mtop';
const API = 'mtop.alipictures.gravitywave.media.vv.detail.list';
const MEDIA_ID = Number(process.env.VVH_MEDIA || 1577466);
const OUT = process.env.VVH_OUT || 'vv-hourly.json';
const KEEP = Number(process.env.VVH_KEEP || 30);

async function callMtop(dataObj, tries = 3) {
  const u = `${MTOP}?api=${encodeURIComponent(API)}&v=1.0&data=${encodeURIComponent(JSON.stringify(dataObj))}`;
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(20000), cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      if (!(j.ret || []).some(x => String(x).includes('SUCCESS'))) throw new Error('ret=' + JSON.stringify(j.ret));
      return (j.data || {});
    } catch (e) {
      last = e;
      if (i < tries - 1) await new Promise(r => setTimeout(r, 2500 * (i + 1)));
    }
  }
  throw last;
}

/* 「12点-13点」→ from 12。个别版本会回「0点-1点」以外的写法，所以只认开头那个数字。 */
function hourOf(hh) {
  const m = /^(\d{1,2})点/.exec(String(hh || ''));
  return m ? Number(m[1]) : null;
}
function pct(s) {
  const v = parseFloat(String(s || '').replace('%', ''));
  return Number.isFinite(v) ? v : null;
}
function bjStamp(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 16) + ' +08';
}

const now = new Date();
const [hourly, daily] = await Promise.all([
  callMtop({ mediaId: MEDIA_ID, platform: 'ALL', dateType: 'HOUR' }),
  callMtop({ mediaId: MEDIA_ID, platform: 'ALL', dateType: 'DAY' }),
]);

const rows = (hourly.dataList || []).filter(r => /^\d{8}$/.test(String(r.showDate)) && hourOf(r.hh) !== null);
const dayRows = (daily.dataList || []).filter(r => /^\d{8}$/.test(String(r.showDate)));

if (process.env.VVH_PROBE) {
  console.log(`PROBE OK · ${bjStamp(now)} · 分时 ${hourly.count ?? rows.length} 格 · 逐日 ${dayRows.length} 天` +
    (rows.length ? ` · 最新一格 ${rows[0].hh} ${rows[0].vvCntWithUnit?.value ?? '?'}万 ${rows[0].marketShare ?? '-'}` : ' · 今天还没有闭合的一格'));
  process.exit(0);
}
if (!rows.length && !dayRows.length) {
  console.error('分时和逐日都回空 —— 上游结构变了或这轮没给数据，不写文件');
  process.exit(2);
}

let prev = {};
try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')) || {}; } catch { /* 首次 */ }
const days = (prev.days && typeof prev.days === 'object') ? prev.days : {};

const today = String(rows[0]?.showDate || dayRows[0]?.showDate || '');
const slot = days[today] && Array.isArray(days[today].hours) ? days[today] : { hours: [] };
const byHour = new Map(slot.hours.map(h => [h.from, h]));
let added = 0, revised = 0;
for (const r of rows) {
  const from = hourOf(r.hh);
  const v = { from, hh: r.hh, vvCnt: Number(r.vvCnt) || 0, share: pct(r.marketShare) };
  const old = byHour.get(from);
  if (!old) added++;
  else if (old.vvCnt !== v.vvCnt || old.share !== v.share) revised++;
  byHour.set(from, v);
}
slot.hours = [...byHour.values()].sort((a, b) => a.from - b.from);
days[today] = slot;

/* 顺手把灯塔逐日那一行的当日累计存进当天（口径和分时不同，见下面的注释，所以各存各的）。
   过 0 点之后这一行的值就是那天的终值，不再动。 */
const totals = new Map(dayRows.map(r => [String(r.showDate), Number(r.vvCnt) || 0]));
for (const [d, v] of totals) if (days[d]) days[d].total = v;

/* 每天 23点-0点 那一格接口永远不给：过 0 点它算昨天，而它只回今天，
   所以任何时刻能拿到的最后一格都是"上一个完整小时"。
   第二天再补 —— 那天各格都已终值，用 灯塔逐日的当日累计 减 0..22 点之和才是它。
   ⚠ 当天不能这么算：10-20 18:24 实测 Σ(0点-17点)=5,120.1 万，而同一分钟的当日累计只有
      5,030.3 万 —— 逐日那行比小时行慢大约 40 分钟，两套数在同一天里对不上，
      拿它倒推当天任何一格都是假的。只对已经翻篇的日子做，且打上 derived 标记。 */
for (const [d, rec] of Object.entries(days)) {
  if (d === today) continue;
  const have = rec.hours.filter(h => !h.derived);
  const total = totals.get(d);
  if (!Number.isFinite(total) || have.length !== 23 || have[0].from !== 0) continue;
  const sum = have.reduce((a, h) => a + h.vvCnt, 0);
  const rest = total - sum;
  /* 两道合理性检查：非负，且不超过最大一格的三倍。超出就丢弃并说明，不硬凑。 */
  const peak = have.reduce((a, h) => Math.max(a, h.vvCnt), 0);
  if (rest < 0 || rest > peak * 3) {
    console.log(`${d} 23点-0点 倒推得 ${rest}（日累计 ${total} / 各格和 ${sum} / 最大一格 ${peak}），不合理，丢掉`);
    continue;
  }
  /* 每次真跑都重算：先剔掉上一轮推的那一格，别攒出两格 23 点。 */
  rec.hours = have.sort((a, b) => a.from - b.from).concat([{ from: 23, hh: '23点-0点', vvCnt: rest, share: null, derived: true }]);
}

const keys = Object.keys(days).sort();
while (keys.length > KEEP) delete days[keys.shift()];

const changed = added || revised;
const body = {
  ok: true,
  mediaId: MEDIA_ID,
  platform: 'ALL',
  asof: today,
  days,
  count: slot.hours.length,
  /* fetchedAt = 分时格子最后一次真的动过的时刻；lastRun = 最近一次成功采样。
     看板上「最后一次采集」用 lastRun，它是链路通没通的判据。 */
  fetchedAt: changed || !prev.fetchedAt ? now.toISOString() : prev.fetchedAt,
  lastRun: now.toISOString(),
  lastRunBJ: bjStamp(now),
};

fs.writeFileSync(OUT, JSON.stringify(body, null, 1));
console.log(`${body.lastRunBJ} · 今天 ${today} 攒到 ${slot.hours.length} 格（新增 ${added}、修正 ${revised}）· 已存 ${keys.length} 天 · 最新一格 ` +
  (slot.hours.length ? `${slot.hours[slot.hours.length - 1].hh} ${(slot.hours[slot.hours.length - 1].vvCnt / 1e4).toFixed(1)}万` : '无'));
