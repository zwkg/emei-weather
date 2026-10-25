'use strict';
/**
 * 天气看板 轻量后端（零依赖，Node 原生 http）
 *
 * 作用：
 *  1) 托管静态文件（index.html / app.js / style.css）
 *  2) /api/obs  代理「中国天气网」实况自动站数据（d1.weather.com.cn 强制校验 Referer，
 *     浏览器无法伪造，只能由服务端代取）——这是真正的站点观测值
 *  3) /api/health 供前端探测后端是否可用
 *
 * 启动：node server.js          （默认 8080）
 *       PORT=9000 node server.js
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/* ============ 中国天气网 站点代码（真实测自动站）============ */
// 峨眉山相关站点，均已通过 toy1.weather.com.cn 搜索接口核实
const CN_STATIONS = {
  '101271409':    '峨眉山风景区',
  '10127140806A': '峨眉山万年寺入口',
  '10127140901B': '峨眉山雷洞坪冰雪娱乐场',
  '10127140801A': '峨眉山竹叶青生态茗园',
  '101271414':    '峨眉山市',
  '101271401':    '乐山',
  '101271901':    '阿坝'
};

const cache = new Map();          // code -> { at, data }   新鲜缓存
const lastGood = new Map();       // code -> data          最后一次成功值（失败时兜底）
const failUntil = new Map();      // code -> ts            失败冷却截止
const OBS_TTL = 10 * 60 * 1000;   // 实况缓存 10 分钟
const FAIL_COOLDOWN = 30 * 1000;  // 失败后 30 秒内不再打扰上游（已有多路径重试，不必等太久）
const MIN_INTERVAL = 1500;        // 上游请求最小间隔（避免触发风控）

// 最后一次成功值落盘：沙箱休眠/重启后内存为空，
// 若首个请求恰好被上游限流，金顶就会掉成"推算"。落盘后可立刻兜底。
const LASTGOOD_FILE = path.join(ROOT, '.obs-lastgood.json');
function loadLastGood() {
  try {
    const raw = JSON.parse(fs.readFileSync(LASTGOOD_FILE, 'utf8'));
    for (const [code, v] of Object.entries(raw)) {
      if (v && v.temp != null) lastGood.set(code, v);
    }
  } catch { /* 首次运行没有该文件 */ }
}
let saveTimer = null;
function persistLastGood() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(LASTGOOD_FILE, JSON.stringify(Object.fromEntries(lastGood)));
    } catch { /* 只读文件系统则跳过，不影响功能 */ }
  }, 500);
}
loadLastGood();

// 串行队列：所有上游请求排队执行，保证间隔
const queue = { last: 0, chain: Promise.resolve() };
function enqueue(fn) {
  const run = queue.chain.then(async () => {
    const wait = MIN_INTERVAL - (Date.now() - queue.last);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    queue.last = Date.now();
    return fn();
  });
  queue.chain = run.then(() => {}, () => {});
  return run;
}

function httpsGet(url, headers, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeout, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

/** 中国大陆站点响应为 GBK，Node 自带 ICU 可解码 */
function decodeBody(buf, contentType = '') {
  const m = /charset=([\w-]+)/i.exec(contentType || '');
  const enc = m ? m[1].toLowerCase() : 'utf-8';
  try {
    return new TextDecoder(enc === 'gb2312' ? 'gbk' : enc).decode(buf);
  } catch {
    return new TextDecoder('gbk').decode(buf);
  }
}

/** 取中国天气网实况（sk_2d），服务端伪造 Referer 绕开其防盗链 */
async function fetchCnObs(code) {
  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < OBS_TTL) return hit.data;

  // 冷却期内：有旧值就给旧值，不打扰上游
  if (Date.now() < (failUntil.get(code) || 0)) {
    const g = lastGood.get(code);
    if (g) return { ...g, stale: true };
    throw new Error('上游限流冷却中');
  }

  try {
    const data = await enqueue(() => doFetchCnObs(code));
    cache.set(code, { at: Date.now(), data });
    lastGood.set(code, data);
    persistLastGood();
    failUntil.delete(code);
    return data;
  } catch (e) {
    failUntil.set(code, Date.now() + FAIL_COOLDOWN);
    const g = lastGood.get(code);
    if (g) {
      const ageMin = Math.round((Date.now() - (g.fetchedAt || 0)) / 60000);
      // 超过 2 小时的老值不再当实测交出去：温度日变化可达十几度，
      // 拿凌晨的值当下午用比"按廓线推算"更离谱。超时就让它按推算处理。
      if (ageMin <= 120) return { ...g, stale: true, ageMin, note: e.message };
    }
    throw e;
  }
}

const CN_HEADERS = {
  'Referer': 'http://www.weather.com.cn/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9'
};

// 同一上游的两条路径：sk_2d 是纯实况文件；weather_index 是整站初始化脚本，
// 里面同样带 dataSK，且实测更新时间常常更新（sk_2d 走 CDN 缓存会略旧）。
// 一条被限流/缓存异常时另一条还能拿到 —— 金顶这种只有单一站点的位置全靠这层冗余。
const CN_OBS_URLS = [
  (code) => `https://d1.weather.com.cn/sk_2d/${encodeURIComponent(code)}.html?_=${Date.now()}`,
  (code) => `https://d1.weather.com.cn/weather_index/${encodeURIComponent(code)}.html?_=${Date.now()}`
];

function parseDataSK(text) {
  // dataSK 是扁平对象，非贪婪匹配到第一个右花括号即可（weather_index 里后面还跟着别的脚本）
  const m = /var\s+dataSK\s*=\s*(\{[\s\S]*?\})\s*;/.exec(text);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function buildObs(code, raw) {
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : null; };
  return {
    ok: true,
    provider: '中国天气网自动站',
    code,
    stationName: raw.cityname || CN_STATIONS[code] || code,
    temp: num(raw.temp),
    humidity: num(raw.SD),
    windDir: raw.WD || '',
    windPower: raw.WS || '',
    pressure: num(raw.qy),
    rain: num(raw.rain),
    visibility: raw.njd || '',
    aqi: num(raw.aqi),
    observedAt: raw.time || '',
    rawTime: raw.time || '',
    fetchedAt: Date.now()
  };
}

async function doFetchCnObs(code) {
  let lastErr = null;
  // 两轮：先试 sk_2d，不行立刻换 weather_index；整轮失败再各试一次
  for (let round = 0; round < 2; round++) {
    for (const makeUrl of CN_OBS_URLS) {
      try {
        const { status, headers, body } = await httpsGet(makeUrl(code), CN_HEADERS);
        if (status !== 200) throw new Error('上游返回 HTTP ' + status);
        const raw = parseDataSK(decodeBody(body, headers['content-type']));
        if (!raw) throw new Error('响应格式异常');
        const data = buildObs(code, raw);
        if (data.temp == null) throw new Error('无温度字段');
        return data;
      } catch (e) {
        lastErr = e;
      }
      await new Promise(r => setTimeout(r, 700));
    }
  }
  throw lastErr || new Error('实况获取失败');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS'
    });
    res.end();
    return;
  }

  if (p === '/api/health') {
    sendJson(res, 200, { ok: true, service: 'weather-dashboard', t: Date.now() });
    return;
  }

  // 实况：/api/obs?code=101271409
  if (p === '/api/obs') {
    const code = (u.searchParams.get('code') || '').trim();
    if (!code) { sendJson(res, 400, { ok: false, error: '缺少 code' }); return; }
    try {
      const data = await fetchCnObs(code);
      sendJson(res, 200, data);
    } catch (e) {
      sendJson(res, 200, { ok: false, provider: '中国天气网自动站', code, error: e.message });
    }
    return;
  }

  // 批量实况：/api/obs-batch?codes=a,b,c
  if (p === '/api/obs-batch') {
    const codes = (u.searchParams.get('codes') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!codes.length) { sendJson(res, 400, { ok: false, error: '缺少 codes' }); return; }
    const out = {};
    // 串行请求，降低被风控概率（有 8 分钟缓存兜底，不会慢太多）
    for (const code of codes) {
      try { out[code] = await fetchCnObs(code); }
      catch (e) { out[code] = { ok: false, code, error: e.message }; }
    }
    sendJson(res, 200, { ok: true, data: out });
    return;
  }

  serveStatic(req, res, p);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`天气看板已启动: http://localhost:${PORT}`);
});
