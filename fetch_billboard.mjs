// 优酷 7日畅销榜采集 —— 匿名 h5 签名，不需要 cookie、不需要浏览器、不需要 secret。
//
// 产出 billboard.json：samples[] 是自己一天一天攒出来的（优酷只给当前值，没有历史接口），
// 所以这个文件必须"读旧-追加-写新"，不能整份覆盖。
//
// 环境变量：
//   BILLBOARD_OUT   产出路径，默认 billboard.json
//   BILLBOARD_KEEP  最多留多少个采样点，默认 1000（约 20 天）
//   BILLBOARD_PROBE 只探连通性、不写文件（用来验 Actions 的机房 IP 能不能取到数）

import crypto from 'node:crypto';
import fs from 'node:fs';

const HOST = 'https://acs.youku.com';
const API = 'mtop.youku.columbus.home.query';
const APPKEY = '23570660';
const UA = 'Mozilla/5.0 (Linux; Android 12; SM-S9080) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';

const SHOW = process.env.BILLBOARD_SHOW || '嫁金钗';
const OUT = process.env.BILLBOARD_OUT || 'billboard.json';
const KEEP = Number(process.env.BILLBOARD_KEEP || 1000);
const BOARDS = { week: 10423, year: 10422 };
const TABNAME = { 10423: '7日畅销榜', 10422: '年度畅销榜' };

function buildData(bid) {
  const biz = JSON.stringify({ billboardId: bid, requestType: 'tabSwitch', tabName: TABNAME[bid], clarity: 4 });
  const params = JSON.stringify({
    bizContext: biz, bizKey: 'kuflix_phone_home', debug: 0, gray: 0,
    nodeKey: 'TV_BD', pageNo: 1, reqSubNode: 1, showNodeList: 0,
  });
  const sysinfo = JSON.stringify({
    appPackageKey: 'com.youku.phone', os: 'ios', ver: '11.2.17', osVer: '12',
    pid: '19babfbcea8e1838', deviceId: 'atWHBxws2gUDAHN0R19Qhy9q',
    resolution: '1600*900', btype: 'SM-S9080', network: 'WIFI',
    guid: '3199b989b7458168953936b2eb78201b',
  });
  return JSON.stringify({ method: 'POST', ms_codes: '2019061000', params, system_info: sysinfo });
}

// mtop h5 的两步握手：第一次故意签错，只为换一枚 _m_h5_tk；第二次才是真请求。
// 服务端既查 sign 也查 Cookie 里那枚 token，所以 cookie 要带回去，光有 token 不够。
async function callBoard(bid) {
  const data = buildData(bid);
  let token = '';
  let cookie = '';
  let last = null;
  for (let i = 0; i < 3; i++) {
    const t = String(Date.now());
    const sign = crypto.createHash('md5').update(`${token}&${t}&${APPKEY}&${data}`).digest('hex');
    const q = new URLSearchParams({
      jsv: '2.6.1', appKey: APPKEY, t, sign, api: API, v: '1.0',
      type: 'originaljson', dataType: 'json', data,
    });
    const headers = { 'User-Agent': UA, Referer: 'https://m.youku.com/', Accept: 'application/json' };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(`${HOST}/h5/${API}/1.0/?${q}`, { headers });
    const raw = await res.text();
    last = JSON.parse(raw);
    if ((last.ret || []).some(r => String(r).includes('SUCCESS'))) return last;
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : String(res.headers.get('set-cookie') || '').split(/,(?=\s*_m_h5_tk)/);
    for (const c of sc) {
      const kv = c.split(';')[0];
      if (!/_m_h5_tk(_enc)?=/.test(kv)) continue;
      cookie = cookie ? `${cookie}; ${kv}` : kv;
      const m = /^_m_h5_tk=([^_;]+)/.exec(kv);
      if (m) token = m[1].split('_')[0];
    }
    if (!token) throw new Error(`拿不到 _m_h5_tk，ret=${JSON.stringify(last.ret)}`);
  }
  throw new Error(`签名三轮没通过，ret=${JSON.stringify((last && last.ret) || '?')}`);
}

// 榜单值只活在 data.subtitle 这个中文字符串里，结构层级会随版本漂，所以递归找。
function parseBoard(o, want) {
  const out = [];
  (function walk(x) {
    if (Array.isArray(x)) return x.forEach(walk);
    if (x && typeof x === 'object') {
      const s = x.subtitle;
      if (typeof s === 'string' && s.startsWith(want)) {
        const v = parseFloat(s.slice(want.length));
        if (x.title && Number.isFinite(v)) out.push({ title: x.title, value: v });
      }
      Object.values(x).forEach(walk);
    }
  })(o);
  return out;
}

function cnParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, iso: new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' +08' };
}

function locate(rows, show) {
  const i = rows.findIndex(r => r.title === show);
  return i < 0 ? { rank: null, value: null } : { rank: i + 1, value: rows[i].value };
}

let prev = {};
try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')) || {}; } catch { /* 首次 */ }

const week = parseBoard(await callBoard(BOARDS.week), '畅销度');
const year = parseBoard(await callBoard(BOARDS.year), '畅销度');
if (!week.length) {
  console.error('榜单解析出 0 条 —— 上游结构变了或这轮没给数据，不写文件');
  process.exit(2);
}

const now = new Date();
const { date, hm, iso } = cnParts(now);
const w = locate(week, SHOW), y = locate(year, SHOW);

if (process.env.BILLBOARD_PROBE) {
  console.log(`PROBE OK · ${date} ${hm} 北京时间 · 7日榜 ${week.length} 条 · ${SHOW} 第${w.rank ?? '?'}名 ${w.value ?? '?'}万 · 年度榜第${y.rank ?? '?'}名`);
  process.exit(0);
}

const samples = Array.isArray(prev.samples) ? prev.samples : [];
samples.push({ date, hm, weekRank: w.rank, weekValue: w.value, yearRank: y.rank, yearValue: y.value });
while (samples.length > KEEP) samples.shift();

// fetchedAt = 数值最后一次真正变化的时刻（榜是台阶式跳的，跳之前一直冻着）；
// lastRun = 最近一次成功采样。卡片上「最后一次采集」用 lastRun，它是链路通没通的判据。
const before = samples[samples.length - 2];
const moved = !before || before.weekValue !== w.value || before.weekRank !== w.rank
  || before.yearValue !== y.value || before.yearRank !== y.rank;

const body = {
  ok: true,
  show: SHOW,
  board: '7日畅销榜',
  asof: date,
  latest: { date, hm, iso, weekRank: w.rank, weekValue: w.value, yearRank: y.rank, yearValue: y.value },
  top: week.slice(0, 20).map((r, i) => ({ rank: i + 1, title: r.title, value: r.value })),
  samples,
  fetchedAt: moved || !prev.fetchedAt ? now.toISOString() : prev.fetchedAt,
  lastRun: now.toISOString(),
  count: week.length,
};

if (before && before.weekValue != null && w.value != null && w.value < before.weekValue) {
  console.log(`注意：畅销度比上一采样点低（${before.weekValue} → ${w.value}），7 天滚动窗口掉出旧数据时会这样，不是取错`);
}

fs.writeFileSync(OUT, JSON.stringify(body, null, 1));
console.log(`${date} ${hm} 北京时间 · ${SHOW} 7日榜第${w.rank ?? '?'}名 ${w.value ?? '?'}万 · 年度榜第${y.rank ?? '?'}名 · 累计 ${samples.length} 个采样点`);
