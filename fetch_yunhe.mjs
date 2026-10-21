// 云合（enlightent）长剧评级采集。
//
// 只要「评级」那一个字母：S+ / S / A+ / A / B+ / B / C …
// 接口匿名可调，没有 cookie、没有签名、没有浏览器 —— 一个 POST 十几秒跑完。
//
//   POST https://www.enlightent.cn/research/video/getLastLevel.do   nameId=8746798
//   → [{"date":"2026-10-19","minValue":12.9,"diff":1,"position":13.93,"level":"S+","maxValue":14.58}, …]
//   → 本剧还没出档时回 []（嫁金钗现在就是这个状态）
//
// 只存 date + level，那三个数一个都不存。10-21 上午拿同一部《兰香如故》连测三次
// （榜单内联字段、单剧 POST、单剧 GET），level 三次全同是 S+，
// 而 minValue/maxValue/position 三次分别是 12.9/14.58/13.93、10.58/12.25/11.61、9.95/11.63/10.98 ——
// 未登录给的本来就是被打散的同区间随机数，存下来只会制造"今天比昨天高"这种假结论。
//
// 历史得自己攒：接口只回最近 1~2 天，没有更深的历史接口。所以这个文件是
// 「读旧-追加-写新」，和 billboard.json 一样，Actions 那几拍谁也不能把别人攒的覆盖掉。
// 断供几天就会真丢几天，这个档案补不回来。
//
// 环境变量：
//   YUNHE_OUT     产出路径，默认 yunhe.json
//   YUNHE_NAMEID  剧的 nameId，默认 8746798（嫁金钗）
//   YUNHE_KEEP    档案最多留多少天，默认 400
//   YUNHE_HEARTBEAT  没新档位时也允许多久写一次「只推进检查时刻」，默认 60（分钟）
//   YUNHE_PROBE   1 = 取数、打印、不写文件（用来验 Actions 的机房 IP 能不能取到数）

import fs from 'node:fs';

const API = 'https://www.enlightent.cn/research/video/getLastLevel.do';
const OUT = process.env.YUNHE_OUT || 'yunhe.json';
const NAMEID = String(process.env.YUNHE_NAMEID || '8746798');
const NAME = process.env.YUNHE_NAME || '嫁金钗';
const KEEP = Number(process.env.YUNHE_KEEP || 400);
const HEARTBEAT = Number(process.env.YUNHE_HEARTBEAT) || 60;   /* 分钟；填个非数字也当没填，别让心跳静默失效 */
const PROBE = process.env.YUNHE_PROBE === '1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* 日期串一律自己拼 YYYY-MM-DD：拿 Intl 按 locale 直接 format，小 ICU 会退回 09/20/2026。
   这台机器和 Actions  runner 的本地时区不是一个东西，所以按北京时区取字段，不读系统时钟格式。 */
const p2 = n => String(n).padStart(2, '0');
const bjParts = d => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', hour12: false,
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
}).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
const bjStamp = d => { const p = bjParts(d);
  return `${p.year}-${p2(p.month)}-${p2(p.day)} ${p2(p.hour)}:${p2(p.minute)}`; };
const bjDay = d => bjStamp(d).slice(0, 10);

/* 接口那条数组（新的在前）归成升序、只留 date/level 两个字段。
   一条都不合法就当场判失败 —— 上游改了结构时宁可报错停更，也不能写出一个「看起来正常」的空档案。 */
export function normalize(arr) {
  if (!Array.isArray(arr)) return { ok: false, msg: '响应不是数组（接口改了结构或被拦成页面）' };
  const seen = new Map();
  for (const x of arr) {
    if (!x || !/^\d{4}-\d{2}-\d{2}$/.test(String(x.date || ''))) continue;
    const lv = String(x.level || '').trim();
    if (!/^[A-Za-z][+-]?$/.test(lv)) continue;
    seen.set(String(x.date), lv.toUpperCase());
  }
  if (arr.length && !seen.size) return { ok: false, msg: `回了 ${arr.length} 条但一条都没解析出日期+档位` };
  return { ok: true, days: [...seen].map(([date, level]) => ({ date, level })).sort((a, b) => a.date.localeCompare(b.date)) };
}

/* 往档案里并：已有同一天、档位又变了 = 上游改了口，按「标错不删数据」处理，
   改的是 level、原值进 fixes 留着，不静默覆盖。
   返回 changed 只由"档位有没有新出现/变动"决定，跟检查时刻无关 —— 半小时一拍，
   不能让一个时间戳的抖动也产生一次提交。 */
export function merge(oldDays, fresh, at) {
  const days = (Array.isArray(oldDays) ? oldDays : []).map(x => ({ ...x }));
  const fixes = [];
  const idx = new Map(days.map((x, i) => [x.date, i]));
  let changed = false;
  for (const f of fresh) {
    const i = idx.get(f.date);
    if (i == null) { days.push({ date: f.date, level: f.level, at }); changed = true; }
    else if (days[i].level !== f.level) {
      fixes.push({ date: f.date, from: days[i].level, to: f.level, at });
      days[i] = { ...days[i], level: f.level, revisedAt: at };
      changed = true;
    }
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { days: days.slice(-KEEP), fixes, changed };
}

/* 要不要落盘。三种情况写：档位变了、跨了北京日界、或者距上次写盘超过 heartbeat 分钟。
   最后那一条是心跳 —— 它只推进 at，不新增任何数据。
   为什么要有它：页面上那句「检查于」是他判断这条链路今天还通不通的唯一凭据。
   只按前两条写的话，评级没出的那些天里这句话一整天不动（10-21 上午就是：10:01 那拍跑绿了，
   卡片上还写着 09:25），「还没出档」和「早就不跑了」在他眼里长得一模一样。
   心跳设 60 分钟 = 最坏一天 24 次提交，而不是半小时一拍的 48 次。 */
export function needWrite(old, now, changed, heartbeatMin = 60) {
  const rollover = !old || old.atDay !== bjDay(now);
  const t = Date.parse(String((old && old.fetchedAt) || ''));
  const stale = !Number.isFinite(t) || (now.getTime() - t) >= heartbeatMin * 6e4;
  return { write: !!changed || rollover || stale, changed: !!changed, rollover, stale };
}

async function fetchLevel() {
  let r = null, txt = '';
  try {
    r = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded',
                 'User-Agent': UA, Referer: 'https://www.enlightent.cn/yunhe/rank-detail',
                 Accept: 'application/json' },
      body: 'nameId=' + encodeURIComponent(NAMEID),
      signal: AbortSignal.timeout(30000),
    });
    txt = await r.text();
  } catch (e) { return { ok: false, msg: `请求没成：${e.name} ${e.message}` }; }
  if (r.status !== 200) return { ok: false, msg: `HTTP ${r.status}：${txt.slice(0, 80)}` };
  let j = null;
  try { j = JSON.parse(txt); } catch { return { ok: false, msg: `响应不是 JSON：${txt.slice(0, 80)}` }; }
  return normalize(j);
}

function readOld() {
  try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { return null; }
}

/* 测试从外面 import normalize/merge，不想被这段主流程带着发请求 */
if (!process.env.YUNHE_LIB_ONLY) {
  const old = readOld();
  const res = await fetchLevel();
  if (!res.ok) {
    console.error(`::error::云合评级没取到数：${res.msg}`);
    console.error('不写文件，页面上留的还是上一份好档案。');
    process.exit(1);
  }

  const now = new Date();
  const at = bjStamp(now);
  const m = merge(old?.days, res.days, at);
  const gate = needWrite(old, now, m.changed, HEARTBEAT);
  const body = {
    name: NAME, nameId: Number(NAMEID),
    at, atDay: bjDay(now), fetchedAt: now.toISOString(),
    runs: (Number(old?.runs) || 0) + 1,
    /* 接口回 [] 是「这一天还没出档」，不是采集坏了；单独存一个字段，页面才说得出区别。 */
    empty: res.days.length === 0,
    days: m.days,
    fixes: (Array.isArray(old?.fixes) ? old.fixes : []).concat(m.fixes),
  };

  /* runs 记的是落盘次数，不是检查次数（心跳之后两者差好几倍），所以这一行把两个都说清 */
  console.log(`云合评级 · ${NAME}（nameId ${NAMEID}）${at} · 档案已落盘 ${Number(old?.runs) || 0} 次，这一拍${gate.write ? `是第 ${body.runs} 次` : '不写'}`);
  console.log(res.days.length
    ? `这一拍拿到 ${res.days.length} 天：` + res.days.map(x => `${x.date} ${x.level}`).join(' / ')
    : '这一拍接口回的是空数组 —— 本剧还没出档');
  if (body.days.length) {
    const last = body.days[body.days.length - 1];
    console.log(`档案共 ${body.days.length} 天，最新 ${last.date} = ${last.level}`);
  }
  if (m.fixes.length) console.log('上游改了口：' + m.fixes.map(f => `${f.date} ${f.from}→${f.to}`).join(' / '));

  if (PROBE) { console.log('探测模式：不写文件。'); process.exit(0); }
  if (!gate.write) {
    console.log(`既没有新档位、也没跨日，距上次写盘还不到 ${HEARTBEAT} 分钟 —— 不写盘，这一拍不产生提交。`);
    process.exit(0);
  }
  fs.writeFileSync(OUT, JSON.stringify(body, null, 2) + '\n');
  const why = m.changed ? '档位有变化' : !old ? '第一次建档' : gate.rollover ? '跨日' : '心跳';
  console.log(`已写 ${OUT}（${why}${m.changed ? '，档案已更新' : '，只推进检查时刻'}）`);
}
