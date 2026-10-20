// 七麦「优酷视频 · 下载量预估」取数。两种模式：
//
//   ① 人工快照（默认）：把浏览器 F12 里那条 /pred/download 的整条 URL 粘进来。
//      node fetch_qimai.mjs "https://api.qimai.cn/pred/download?analysis=...&appid=...&sdate=...&edate=..."
//   ② 云端自动（Actions）：QM_MODE=browser，用无头浏览器打开七麦那个页面，
//      把它自己发出的那条 /pred/download 响应截下来 —— 不需要粘链接。
//      node fetch_qimai.mjs   （环境变量 QM_MODE=browser、QM_COOKIE、QM_APPID）
//
// 为什么要浏览器：analysis 是对整条查询串**现签**出来的，签名里还掺了一个时刻
// （从七麦 JS 的拦截器里读出来的：把参数值排序拼上 url 和一个以 1661224081041 为零点的
// 时间量再做加密），所以粘来的链接挪不动窗口、也活不了太久。既然签名的算法在他们自己的
// 前端里，最稳的办法是让前端自己签，我们只负责把响应接住。
//
// 凭据：这个接口要登录态（实测不带 Cookie 回 code=10011 请登录后查看更多数据）。
// Cookie 只从本地/Secret 读，顺序是
//   --cookie=... > QM_COOKIE 环境变量 > QM_COOKIE_FILE 指向的文件 > ~/.qimai_cookie
// **绝不写进仓库、绝不写进这个文件、绝不 echo**。有用的只有 USERINFO + AUTHKEY 两枚。
//
// 失败一律不写文件：过期链接/登录态掉了不能把昨天的好档案覆盖成空的。
import fs from 'fs';
import os from 'os';
import path from 'path';

const ARGV = process.argv.slice(2);
const flag = k => { const a = ARGV.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : ''; };
const urlArg = ARGV.find(a => !a.startsWith('--'));
const OUT = flag('out') || process.env.QIMAI_OUT || 'qimai.json';
const APPID = process.env.QM_APPID || '336141475';
const MODE = (process.env.QM_MODE === 'browser' || ARGV.includes('--browser')) ? 'browser' : 'paste';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function readCookie() {
  const direct = flag('cookie') || process.env.QM_COOKIE || '';
  if (direct.trim()) return direct.trim();
  const f = flag('cookie-file') || process.env.QM_COOKIE_FILE || path.join(os.homedir(), '.qimai_cookie');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; }
}

/* 日期一律自己拼 YYYY-MM-DD：拿 Intl 按 locale 直接 format 出来的串，Node 18 的完整 ICU
   给 en-CA 是 2026-09-20、小 ICU 会退回 09/20/2026，这种格式不能赌。
   en-GB 的 hour12:false 在部分 ICU 版本把午夜给 "24"，也兜一下。 */
const p2 = n => String(n).padStart(2, '0');
const bjParts = (d, opts) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', hour12: false, ...opts,
}).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
const bjDay = ms => {
  const p = bjParts(new Date(ms), { year: 'numeric', month: 'numeric', day: 'numeric' });
  return `${p.year}-${p2(p.month)}-${p2(p.day)}`;
};

/* 把接口那份 data 归一成档案：七麦给 [毫秒时刻, 当日预估下载量] 且**倒序**，
   这里存升序 + 北京时间日期串，数值保持原始整数（「万」是展示层的事）。

   最新那一两天七麦会回成 0 —— 实测 10-20 凌晨那拍，7 日窗和 30 日窗最后一格都是
   [20/10/2026 00:00, 0]。那不是"下载量跌到零"，是那天还没算出来。当 0 存进去，曲线
   会在尾巴上假摔一根到底，合计和日均也跟着被稀释（七麦自己那份 avg 就是拿 30 天除的：
   1,048,657 / 30 = 34,955，而扣掉占位那格是 36,161）。所以从最新端把占位格剥出来，
   另存一个 pending 字段，页面上照写「10-20 尚在统计」—— 不静默丢，也不冒充是数。
   合计与日均改成用真实天数自己算，不再直接用接口那份被占位稀释过的 sum/avgValue。 */
export function normalize(data, appid, { auto }) {
  const asc = data.list.map(([ms, v]) => ({ date: bjDay(ms), v: Number(v) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const list = asc.slice();
  const pending = [];
  while (list.length && !(list[list.length - 1].v > 0)) pending.unshift(list.pop().date);
  const now = new Date();
  const np = bjParts(now, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
  const at = `${np.year}-${p2(np.month)}-${p2(np.day)} ${p2(np.hour === '24' ? 0 : np.hour)}:${p2(np.minute)}`;
  const sum = list.reduce((a, x) => a + x.v, 0);
  return {
    ok: true,
    app: '优酷视频',
    appid: Number(appid),
    sdate: list[0].date,
    edate: list[list.length - 1].date,
    days: list.length,
    span: asc.length,
    sum,
    avg: Math.round(sum / list.length),
    peak: list.reduce((a, x) => (x.v > a.v ? x : a), list[0]),
    pending,
    list,
    at,
    fetchedAt: now.toISOString(),
    auto: !!auto,   // 页面上那行「人工快照 / 云端自动重采」字样吃这个字段
  };
}

/* 接口回来的东西先统一判一次：非 10000 一律算没取到数，由调用方决定怎么报。
   整窗全是 0（占位还没出数）也按没取到算 —— 这种档案不能让采集把它写下去。 */
export function pick(j) {
  if (!j || j.code !== 10000 || !j.data || !Array.isArray(j.data.list) || !j.data.list.length) {
    return { ok: false, code: j ? j.code : '?', msg: j && j.msg ? j.msg : '非 JSON' };
  }
  if (!j.data.list.some(x => Number(x[1]) > 0)) {
    return { ok: false, code: j.code, msg: '整窗都是 0 占位，尚未出数' };
  }
  return { ok: true, data: j.data };
}

/* 把 "USERINFO=..; AUTHKEY=.." 拆成 Playwright 要的 cookie 对象；只回名字，值不外传 */
function cookiePairs(str) {
  return str.split(/;\s*/).filter(s => s.includes('=')).map(s => {
    const i = s.indexOf('=');
    return { name: s.slice(0, i).trim(), value: s.slice(i + 1).trim(), domain: '.qimai.cn', path: '/' };
  }).filter(c => c.name);
}

async function byPaste(url) {
  const COOKIE = readCookie();
  if (!COOKIE) { console.error('没找到登录 Cookie（~/.qimai_cookie 一行 USERINFO=...; AUTHKEY=...）'); process.exit(2); }
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA, Accept: 'application/json, text/plain, */*',
      Referer: 'https://www.qimai.cn/', Origin: 'https://www.qimai.cn', Cookie: COOKIE,
    },
  });
  const raw = await res.text();
  let j = null;
  try { j = JSON.parse(raw); } catch { /* 交给下面统一报错 */ }
  const p = pick(j);
  if (!p.ok) {
    console.error(`没取到数（HTTP ${res.status}·code=${p.code}·${p.msg}）`);
    console.error('多半是这条链接过期了：回浏览器把那条 /pred/download 重新复制一次。不写文件。');
    process.exit(1);
  }
  return normalize(p.data, new URL(url).searchParams.get('appid'), { auto: false });
}

async function byBrowser() {
  const COOKIE = readCookie();
  if (!COOKIE) { console.error('::error::QM_COOKIE / ~/.qimai_cookie 里没有登录 Cookie，浏览器模式起不来'); process.exit(2); }
  const pairs = cookiePairs(COOKIE);
  console.log(`浏览器模式 · Cookie ${pairs.length} 条（${pairs.map(c => c.name).join(', ')}）`);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const page = await (await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } })).newPage();
  await page.context().addCookies(pairs);
  let body = null, why = '';
  try {
    /* 先挂上监听再导航：这条请求是页面自己发的，早一步晚一步都接不到 */
    const grab = timeout => page.waitForResponse(
      r => r.url().includes('/pred/download') && r.url().includes('appid=' + APPID), { timeout });
    await page.goto(`https://www.qimai.cn/app/downloadEstimate/appid/${APPID}/country/cn`,
      { waitUntil: 'domcontentloaded', timeout: 90000 });
    const read = async r => {
      let j = null;
      try { j = await r.json(); } catch { return { bad: '响应不是 JSON（多半被拦成页面了）' }; }
      const p = pick(j);
      return p.ok ? { data: p.data } : { bad: `code=${p.code}·${p.msg}` };
    };
    const first = await read(await grab(90000));
    if (first.bad) { why = first.bad; }
    else {
      body = normalize(first.data, APPID, { auto: true });
      /* 页面默认停在「近一周」（实测：那一格带 active 类，回 7 个点）。
         要近一个月就点那枚 chip —— 等第二发的 promise 必须**在点之前**挂好，
         点完再挂就赶不上响应，白等 45 秒。 */
      if (body.span < 28) {
        const next = grab(45000);
        const chip = page.locator('a', { hasText: '近一个月' }).first();
        try {
          await chip.click({ timeout: 5000 });
          const second = await read(await next);
          if (second.bad) { why = `切「近一个月」那一发失败了：${second.bad}`; }
          else body = normalize(second.data, APPID, { auto: true });
        } catch (e) { why = `窗口只有 ${body.span} 天且没切到「近一个月」：${e.message}`; }
      }
      if (body && body.span < 28 && !why) why = `拿到的是 ${body.span} 天窗，不是近一个月`;
    }
  } catch (e) {
    why = e.message;
  } finally {
    await browser.close();
  }
  if (!body) {
    console.error(`::error::浏览器模式没拿到数：${why}`);
    console.error('两种可能：① 登录态过期（code=10011）→ 重新贴一次 Cookie；② 机房 IP 被七麦挡（code=10602/4xxxx）。');
    console.error('不写文件，页面上留的还是上一份好档案。');
    process.exit(1);
  }
  /* 短窗不写盘：chip 哪天改了名、点不动了，接住的就是页面默认那 7 天。
     让它落盘等于把仓库里 30 天的档案换成 7 天，图上凭空少 23 根条。
     报红、不写，明天那一格接着试。 */
  const min = Number(process.env.QM_MIN_DAYS || 28);
  if (body.span < min) {
    console.error(`::error::只拿到 ${body.span} 天，不足 ${min} 天：${why || '窗口不对'}`);
    console.error('不写文件 —— 短窗覆盖长窗等于丢历史。');
    process.exit(1);
  }
  if (why) console.log(`::warning::${why}`);
  return body;
}

/* 只有直接被执行时才动手；被测试 import 进来不碰网络也不写文件 */
const line = b => `${OUT} · ${b.sdate}~${b.edate} 共 ${b.days} 天 · 合计 ${b.sum.toLocaleString('zh-CN')} · 日均 ${b.avg.toLocaleString('zh-CN')}`
  + (b.pending.length ? ` · ${b.pending.join(',')} 尚在统计` : '') + ` · 拉取于 ${b.at}`;
if (!process.env.QM_LIB_ONLY) {
  if (MODE === 'browser') {
    const body = await byBrowser();
    fs.writeFileSync(OUT, JSON.stringify(body, null, 1));
    console.log(line(body) + ' · 云端自动重采');
  } else {
    if (!urlArg) { console.error('用法：node fetch_qimai.mjs "<整条 /pred/download URL>"  或  QM_MODE=browser node fetch_qimai.mjs'); process.exit(2); }
    let u;
    try { u = new URL(urlArg); } catch { console.error('这不是合法 URL'); process.exit(2); }
    if (!/(^|\.)qimai\.cn$/.test(u.hostname)) { console.error(`域名不是 qimai.cn：${u.hostname}`); process.exit(2); }
    const miss = ['analysis', 'appid', 'sdate', 'edate'].filter(k => !u.searchParams.get(k));
    if (miss.length) { console.error(`URL 里缺参数：${miss.join(', ')}`); process.exit(2); }
    const body = await byPaste(u);
    fs.writeFileSync(OUT, JSON.stringify(body, null, 1));
    console.log(line(body) + ' · 人工快照');
  }
}
