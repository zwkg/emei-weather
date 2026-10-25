/* ===================== 配置 ===================== */
const STORAGE_KEY = 'weather-dashboard-v1';

const DEFAULT_SETTINGS = {
  title: '弄月峨眉山居民宿',
  subtitle: '峨眉山山景实况 · 逐小时 · 未来7天',
  background: '', // 图片 URL 或 dataURL，空则用默认渐变
  tempOffset: 0,  // 温度校准偏移(°C)，把模型值整体对齐到信任的实测源
  useObservation: true, // 接入实况自动校正当前温度
  qweatherKey: '',      // 和风天气 API Key（可选，填了优先用和风实况）
  // 底部两个醒目入口：徒步 / 美食攻略。内容留空即"预留位"，管理员在设置里填
  guides: {
    hiking: { title: '峨眉山徒步攻略', sub: '上山路线 · 徒步时长 · 装备清单', body: '', url: '' },
    food:   { title: '峨眉山美食攻略', sub: '山脚小吃 · 寺院素斋 · 推荐店铺', body: '', url: '' }
  },
  // 默认按海拔从低到高排列（山脚 → 山顶），一眼看出温差走向
  regions: [
    { name: '峨眉山报国寺', caption: '山脚·海拔约500m' },
    { name: '峨眉山万年寺', caption: '半山·海拔1000m' },
    { name: '峨眉山雷洞坪', caption: '高山区·海拔约2430m' },
    { name: '峨眉山金顶', caption: '高山区·海拔3077m' }
  ]
};

// 内置常用景点精确坐标（地理编码库搜不到景区点位，按坐标才能拿到正确海拔的天气）
// realElevation = 真实海拔（米），用于把模型温度归算到真实高度
const KNOWN_PLACES = {
  '金顶':   { lat: 29.5120, lon: 103.3330, display: '峨眉山金顶', realElevation: 3077 },
  '雷洞坪': { lat: 29.5280, lon: 103.3220, display: '峨眉山雷洞坪', realElevation: 2430 },
  '万年寺': { lat: 29.5905, lon: 103.4055, display: '峨眉山万年寺', realElevation: 1000 },
  '清音阁': { lat: 29.5650, lon: 103.4350, display: '峨眉山清音阁', realElevation: 710 },
  '报国寺': { lat: 29.6000, lon: 103.4800, display: '峨眉山报国寺', realElevation: 500 },
  '峨眉山': { lat: 29.52287, lon: 103.33626, display: '峨眉山（四川·乐山）', realElevation: 500 }
};
// ===== 每个景点各自绑定实测站（中国气象局自动站 + 可插拔数据源）=====
// cnCode: 中国天气网城市/景区站点代码；null 表示该景点无独立站点
// 站点海拔由接口返回的气压反推校验，不写死，避免站点搬家/改动导致误判
const OBS_STATIONS = [
  { key: '报国寺', display: '峨眉山报国寺', lat: 29.6000, lon: 103.4800, elev: 500,  cnCode: '101271414', cnName: '峨眉山市站' },
  { key: '清音阁', display: '峨眉山清音阁', lat: 29.5650, lon: 103.4350, elev: 710,  cnCode: null,        cnName: '' },
  { key: '万年寺', display: '峨眉山万年寺', lat: 29.5905, lon: 103.4055, elev: 1000, cnCode: null,        cnName: '' },
  { key: '雷洞坪', display: '峨眉山雷洞坪', lat: 29.5280, lon: 103.3220, elev: 2430, cnCode: null,        cnName: '' },
  { key: '金顶',   display: '峨眉山金顶',   lat: 29.5120, lon: 103.3330, elev: 3077, cnCode: '101271409', cnName: '峨眉山站' }
];

// 后端代理是否可用（中国天气网强制校验 Referer，浏览器无法直连，必须经 server.js）
let backendOk = false;
async function probeBackend() {
  // 容错重试：沙箱冷启动、网络抖动时第一次探测常常失败，
  // 若一次失败就判定"无后端"，整页会退化成只用第三方山脚值（表现为所有点同温）
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        if (j && j.ok) { backendOk = true; return true; }
      }
    } catch { /* 继续重试 */ }
    if (i < 2) await new Promise(res => setTimeout(res, 800));
  }
  backendOk = false;
  return false;
}

/** 由本站气压反推观测站海拔（国际标准大气 ISA） */
function pressureToElevation(hPa) {
  if (!hPa || hPa <= 0) return null;
  return Math.round(44330 * (1 - Math.pow(hPa / 1013.25, 0.1903)));
}
const LAPSE_RATE = 0.0065; // °C/m 标准(干)大气递减率（仅用于模型温度的海拔归算）

// 实况汇总状态
let obsStations = [];      // [{key,display,elev,obs:{ok,temp,provider,...},local,baseTemp,source}]
const baseTempMap = {};    // display -> 该点实况/推算基准温度
let obsSummary = null;     // {ok, updatedAt, providers}

function knownPlace(name) {
  const n = String(name).trim();
  if (KNOWN_PLACES[n]) return KNOWN_PLACES[n];
  const short = n.replace(/^峨眉山/, '').replace(/市$/, '');
  if (KNOWN_PLACES[short]) return KNOWN_PLACES[short];
  return null;
}

// WMO 天气代码 -> 中文 + emoji
const WMO = {
  0:  { text: '晴',        icon: '☀️' },
  1:  { text: '晴间多云',  icon: '🌤️' },
  2:  { text: '多云',      icon: '⛅' },
  3:  { text: '阴',        icon: '☁️' },
  45: { text: '雾',        icon: '🌫️' },
  48: { text: '雾凇',      icon: '🌫️' },
  51: { text: '小毛毛雨',  icon: '🌦️' },
  53: { text: '毛毛雨',    icon: '🌦️' },
  55: { text: '大毛毛雨',  icon: '🌦️' },
  56: { text: '冻毛毛雨',  icon: '🌧️' },
  57: { text: '冻毛毛雨',  icon: '🌧️' },
  61: { text: '小雨',      icon: '🌧️' },
  63: { text: '中雨',      icon: '🌧️' },
  65: { text: '大雨',      icon: '🌧️' },
  66: { text: '冻雨',      icon: '🌧️' },
  67: { text: '冻雨',      icon: '🌧️' },
  71: { text: '小雪',      icon: '🌨️' },
  73: { text: '中雪',      icon: '🌨️' },
  75: { text: '大雪',      icon: '❄️' },
  77: { text: '雪粒',      icon: '🌨️' },
  80: { text: '阵雨',      icon: '🌦️' },
  81: { text: '强阵雨',    icon: '🌧️' },
  82: { text: '暴雨',      icon: '⛈️' },
  85: { text: '阵雪',      icon: '🌨️' },
  86: { text: '强阵雪',    icon: '❄️' },
  95: { text: '雷阵雨',    icon: '⛈️' },
  96: { text: '雷阵雨伴冰雹', icon: '⛈️' },
  99: { text: '强雷阵雨伴冰雹', icon: '⛈️' }
};
function wmo(code, isDay) {
  const base = WMO[code] || { text: '未知', icon: '🌡️' };
  // 夜间要把带太阳的 emoji 换成夜间版，否则 23:00 会显示成白天多云
  if (isDay === 0) {
    if (code === 0) return { text: '晴（夜）', icon: '🌙' };
    if (code === 1) return { text: base.text, icon: '🌙' };
    if (code === 2) return { text: base.text, icon: '☁️' };
    if (code === 51 || code === 53 || code === 55 || code === 80) return { text: base.text, icon: '🌧️' };
  }
  return base;
}

// 穿衣指数：基于体感温度（已含风寒/湿热）+ 天气状况分级
function clothingIndex(feels, code) {
  let level, icon, advice;
  if (feels >= 28)      { level = '炎热'; icon = '🥵'; advice = '短袖短裤，注意防晒补水'; }
  else if (feels >= 23) { level = '温暖'; icon = '👕'; advice = '薄长袖或短袖，体感舒适'; }
  else if (feels >= 18) { level = '舒适'; icon = '🍃'; advice = '长袖衬衫或薄外套'; }
  else if (feels >= 12) { level = '凉爽'; icon = '🧥'; advice = '外套或针织衫'; }
  else if (feels >= 5)  { level = '较冷'; icon = '🧣'; advice = '厚外套/毛衣，注意保暖'; }
  else if (feels >= -5) { level = '寒冷'; icon = '🧥'; advice = '羽绒服/厚棉衣，戴帽手套'; }
  else                  { level = '严寒'; icon = '🥶'; advice = '极寒天气，减少户外暴露'; }

  const rain = [51, 53, 55, 61, 63, 65, 66, 67, 80, 81, 82];
  const snow = [71, 73, 75, 77, 85, 86];
  const storm = [95, 96, 99];
  if (rain.includes(code)) advice += '；有降雨记得带伞';
  else if (snow.includes(code)) advice += '；有降雪，注意保暖防滑';
  if (storm.includes(code)) advice += '；雷暴天气减少外出';
  return { level, icon, advice };
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/* ===================== 状态 ===================== */
let settings = loadSettings();
// 一次性迁移：老版本存的顺序是"山顶优先"，这里统一改成按海拔从低到高。
// 用标记只跑一次，之后管理员在设置里自己拖换顺序不会被强行重排。
try {
  if (localStorage.getItem('weather-elev-asc-v1') !== '1') {
    settings.regions = sortRegionsByElevation(settings.regions);
    saveSettings();
    localStorage.setItem('weather-elev-asc-v1', '1');
  }
} catch { /* 隐私模式下 localStorage 不可写，忽略即可 */ }
const geoCache = new Map();   // name -> {lat, lon, display}
const dataCache = new Map();  // name -> forecast data
// 实况基础数据版本号：每次 loadObservations 成功 +1。
// 用途：首页会先按"纯模型"渲染一次，那批请求在实况到位后才返回，
// 若直接写进缓存就会把未校正的值留在缓存里，导致卡片/剖面图显示模型值
// （实测 17° 的点显示成 18.7°）。带版本号写入，过期请求的返回值不进缓存。
let obsVersion = 0;

/* ===================== 工具函数 ===================== */
// structuredClone 在 iOS 15.4 以下 / 旧版微信内核里不存在，
// 而 loadSettings() 第一行就用它 —— 一旦缺失会直接抛错导致整页白屏，
// 所以统一走这里，缺失时退回 JSON 深拷贝（配置对象只有纯数据，够用）。
function deepClone(obj) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(obj); } catch { /* 含不可克隆值时退回 JSON */ }
  }
  return JSON.parse(JSON.stringify(obj));
}

// 取景点海拔：① 精确显示名 ② 景点短名（长键优先） ③ 说明文字里的"海拔xxxxm"
function regionElevation(region) {
  const name = String(region?.name || '').trim();
  if (name) {
    const exact = Object.values(KNOWN_PLACES).find(p => p.display === name);
    if (exact) return exact.realElevation;
    const keys = Object.keys(KNOWN_PLACES).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      if (name.includes(k)) return KNOWN_PLACES[k].realElevation;
    }
  }
  const m = /海拔\s*约?\s*(\d+)\s*m/i.exec(region?.caption || '');
  return m ? Number(m[1]) : null;
}

// 按海拔从低到高排序；认不出海拔的保持原位排在最后
function sortRegionsByElevation(list) {
  return (list || []).slice().sort((a, b) => {
    const ea = regionElevation(a), eb = regionElevation(b);
    if (ea == null && eb == null) return 0;
    if (ea == null) return 1;
    if (eb == null) return -1;
    return ea - eb;
  });
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return deepClone(DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw);
    // 旧版默认标题换成民宿名（自己改过的不动，用标记保证只跑一次）
    let savedTitle = parsed.title ?? DEFAULT_SETTINGS.title;
    try {
      if (!localStorage.getItem('weather-brand-v1')) {
        if (!savedTitle || savedTitle === '我的天气看板') savedTitle = DEFAULT_SETTINGS.title;
        localStorage.setItem('weather-brand-v1', '1');
      }
    } catch { /* 隐私模式忽略 */ }
    // 合并，防止缺字段
    return {
      title: savedTitle,
      subtitle: parsed.subtitle ?? DEFAULT_SETTINGS.subtitle,
      background: parsed.background ?? '',
      tempOffset: Number(parsed.tempOffset) || 0,
      useObservation: parsed.useObservation !== false,
      qweatherKey: parsed.qweatherKey || '',
      guides: {
        hiking: { ...DEFAULT_SETTINGS.guides.hiking, ...(parsed.guides?.hiking || {}) },
        food:   { ...DEFAULT_SETTINGS.guides.food,   ...(parsed.guides?.food   || {}) }
      },
      regions: Array.isArray(parsed.regions) && parsed.regions.length
        ? parsed.regions : deepClone(DEFAULT_SETTINGS.regions)
    };
  } catch {
    return deepClone(DEFAULT_SETTINGS);
  }
}
function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function hhmm(t) {
  if (!t) return '';
  return t.split('T')[1] ? t.split('T')[1].slice(0, 5) : t;
}
function fmtDay(dateStr, idx) {
  // dateStr: YYYY-MM-DD
  const d = new Date(dateStr + 'T00:00');
  const wd = WEEKDAYS[d.getDay()];
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  const label = idx === 0 ? '今天' : (idx === 1 ? '明天' : wd);
  return { label, md };
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2200);
}

/* ===================== 数据获取 ===================== */
async function geocode(name) {
  if (geoCache.has(name)) return geoCache.get(name);
  const known = knownPlace(name);
  if (known) {
    geoCache.set(name, known);
    return known;
  }
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=zh&format=json`;
  const res = await fetchWithRetry(url, { tries: 2, timeout: 8000 });
  const json = await res.json();
  if (!json.results || !json.results.length) throw new Error('找不到该地区');
  const r = json.results[0];
  const loc = {
    lat: r.latitude,
    lon: r.longitude,
    display: r.name + (r.admin1 && r.admin1 !== r.name ? `·${r.admin1}` : '') + (r.country && r.country !== '中国' ? ` (${r.country})` : '')
  };
  geoCache.set(name, loc);
  return loc;
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(t) };
}

// ===== 数据源（可插拔）：请求单个基准站，返回 {ok, temp, ...} =====
// ① 中国天气网自动站（经后端代理，真实测；站点级独立数据）
async function fetchCnObs(station) {
  if (!station.cnCode) return { ok: false, provider: '中国天气网', error: '该点无独立站点' };
  if (!backendOk) return { ok: false, provider: '中国天气网', error: '后端未启动' };
  const t = withTimeout(12000);
  try {
    const res = await fetch(`/api/obs?code=${encodeURIComponent(station.cnCode)}`, { signal: t.signal, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || '无数据');
    if (!isFinite(parseFloat(j.temp))) throw new Error('无温度');
    return {
      ok: true,
      provider: '中国天气网',
      temp: parseFloat(j.temp),
      humidity: j.humidity != null ? parseFloat(j.humidity) : null,
      pressure: j.pressure != null ? parseFloat(j.pressure) : null,
      stationElev: pressureToElevation(j.pressure),
      stationName: j.stationName || station.cnName || '',
      observedAt: j.observedAt || '',
      stale: !!j.stale,
      ageMin: j.ageMin != null ? j.ageMin : (j.fetchedAt ? Math.round((Date.now() - j.fetchedAt) / 60000) : null),
      windDir: j.windDir || '',
      windPower: j.windPower || '',
      isStation: true   // 标记：真实测站（非模型）
    };
  } catch (e) {
    return { ok: false, provider: '中国天气网', error: e.message };
  } finally { t.clear(); }
}

async function fetchWttrObs(station) {
  const t = withTimeout(12000);
  try {
    const res = await fetch(`https://wttr.in/${station.lat},${station.lon}?format=j1`, { signal: t.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const c = j.current_condition?.[0];
    const temp = parseFloat(c?.temp_C);
    if (!isFinite(temp)) throw new Error('无温度');
    return {
      ok: true, provider: 'wttr.in', temp,
      feels: parseFloat(c?.FeelsLikeC),
      humidity: c?.humidity,
      desc: c?.weatherDesc?.[0]?.value || '',
      stationName: j.nearest_area?.[0]?.areaName?.[0]?.value || '',
      observedAt: c?.localObsDateTime || c?.observation_time || ''
    };
  } catch (e) {
    return { ok: false, provider: 'wttr.in', error: e.message };
  } finally { t.clear(); }
}

async function fetchQWeatherObs(station) {
  const key = settings.qweatherKey;
  if (!key) return { ok: false, provider: '和风天气', error: '未配置 Key' };
  const t = withTimeout(8000);
  try {
    const url = `https://devapi.qweather.com/v7/weather/now?location=${station.lon},${station.lat}&key=${encodeURIComponent(key)}&lang=zh`;
    const res = await fetch(url, { signal: t.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (j.code !== '200' || !j.now) throw new Error('错误码 ' + (j.code || '?'));
    const temp = parseFloat(j.now.temp);
    if (!isFinite(temp)) throw new Error('无温度');
    return {
      ok: true, provider: '和风天气', temp,
      feels: parseFloat(j.now.feelsLike),
      humidity: j.now.humidity,
      desc: j.now.text || '',
      stationName: '',
      observedAt: j.updateTime || ''
    };
  } catch (e) {
    return { ok: false, provider: '和风天气', error: e.message };
  } finally { t.clear(); }
}

// 数据源优先级：中国天气网自动站（真实测，站点级）> 和风（配了 Key）> wttr.in（最近站兜底）
function activeProviders(station) {
  const list = [fetchCnObs];
  if (settings.qweatherKey) list.push(fetchQWeatherObs);
  // wttr.in 只给"离坐标最近的一个站"（通常是山脚），高海拔点必然被海拔校验拒掉，
  // 问了也是白问，还会拖慢整体加载 —— 只对无独立站点、海拔接近山脚的点启用
  if (!station || (!station.cnCode && station.elev <= 900)) list.push(fetchWttrObs);
  return list;
}

// 多站 + 多源：每个景点各自取实测；无实测的点用「实测温度廓线」插值
// 最近一次成功实测锚点缓存：某个站被上游限流时，用它补第二个锚点，
// 避免整页退化成"一个温度往外推"（逆温天会严重偏冷）
const ANCHOR_CACHE_KEY = 'weather-anchors-v1';
const ANCHOR_TTL = 25 * 60 * 1000;   // 25 分钟内有效

function saveAnchorCache(anchors) {
  try {
    localStorage.setItem(ANCHOR_CACHE_KEY, JSON.stringify({
      at: Date.now(),
      anchors: anchors.map(a => ({ key: a.key, elev: a.elev, temp: a.temp }))
    }));
  } catch { /* 隐私模式写不进去，忽略 */ }
}

function loadAnchorCache() {
  try {
    const j = JSON.parse(localStorage.getItem(ANCHOR_CACHE_KEY) || 'null');
    if (!j || !Array.isArray(j.anchors) || !j.anchors.length) return null;
    if (Date.now() - j.at > ANCHOR_TTL) return null;
    return j;
  } catch {
    return null;
  }
}

// 关键：不套固定递减率，而是用真实观测点连线插值 —— 能自动反映逆温/热浪等真实层结
async function loadObservations(isRetry = false) {
  const results = await Promise.all(OBS_STATIONS.map(async st => {
    const providers = activeProviders(st);
    let obs = { ok: false, provider: '', error: '无数据源' };
    for (const fn of providers) {
      const r = await fn(st);
      if (r.ok) { obs = r; break; }
      obs = r;
    }
    return { ...st, obs };
  }));

  const withObs = results.filter(r => r.obs.ok).sort((a, b) => a.elev - b.elev);
  if (!withObs.length) {
    // 后端在却全部失败，多半是瞬时限流/网络抖动：等一会儿再试一次
    if (backendOk && !isRetry) {
      await new Promise(res => setTimeout(res, 1500));
      return loadObservations(true);
    }
    obsStations = results;
    obsSummary = { ok: false, updatedAt: Date.now(), backend: backendOk };
    Object.keys(baseTempMap).forEach(k => delete baseTempMap[k]);
    return;
  }

  // ① 校验：这个观测值到底是不是「这个地点」的
  //    有气压 → 用气压反推站点海拔，位置吻合(±400m)才算该点实测（温度不做否决，逆温天山顶也可能不冷）
  //    无气压（wttr.in 只给最近站）→ 只有与最低海拔实测点几乎同高才采信
  const lowestPoint = withObs.find(x => x.obs.stationElev != null) || withObs[0];

  results.forEach(r => {
    r.local = false;
    if (!r.obs.ok) { r.verdict = 'no-data'; return; }
    const o = r.obs;
    const elevGap = o.stationElev != null ? Math.abs(o.stationElev - r.elev) : null;
    r.elevGap = elevGap;
    r.obsElev = o.stationElev != null ? o.stationElev : r.elev;

    if (o.stationElev != null) {
      // 站点海拔可验证：位置对上即采信为实测
      r.local = elevGap <= 400;
      r.verdict = r.local ? 'verified-station' : 'suspect-mismatch';
    } else {
      // 无气压：只能靠"与最低实测点几乎同海拔"间接采信
      const sameLevel = Math.abs(r.elev - lowestPoint.elev) <= 120;
      r.local = sameLevel;
      r.verdict = sameLevel ? 'verified-adjacent' : 'suspect-mismatch';
    }
  });

  // ② 实测廓线锚点（海拔优先用气压反推值，比标称海拔更准）
  const anchors = results
    .filter(r => r.local && r.obs.ok)
    .map(r => ({ key: r.key, elev: r.obsElev, temp: r.obs.temp }))
    .sort((a, b) => a.elev - b.elev);

  // ②.5 单锚点兜底：拿最近一次成功的实测补一个不同海拔的锚点
  //     （并按当前最低站的变化量平移，跟随整体升温/降温）
  let staleAt = null;
  if (anchors.length >= 2) {
    saveAnchorCache(anchors);
  } else if (anchors.length === 1) {
    const cached = loadAnchorCache();
    if (cached) {
      const cur = anchors[0];
      const cands = cached.anchors.filter(a => Math.abs(a.elev - cur.elev) > 500);
      if (cands.length) {
        const pick = cands.sort((x, y) =>
          Math.abs(x.elev - cur.elev) - Math.abs(y.elev - cur.elev))[0];
        // 用缓存里最低海拔锚点与当前锚点的差值做平移，避免直接套用旧温度
        const cLow = cached.anchors.reduce((m, a) => (a.elev < m.elev ? a : m), cached.anchors[0]);
        let delta = cur.temp - cLow.temp;
        delta = Math.max(-6, Math.min(6, delta));
        anchors.push({ key: pick.key, elev: pick.elev, temp: pick.temp + delta, stale: true });
        anchors.sort((a, b) => a.elev - b.elev);
        staleAt = cached.at;
      }
    }
  }

  // ③ 高度-温度线性插值；斜率限幅在 [-9.8, +3] °C/km（允许逆温）
  const slopeOf = (a, b) => {
    const s = (b.temp - a.temp) / Math.max(1, b.elev - a.elev);
    return Math.min(0.003, Math.max(-0.0098, s));
  };
  // 单锚点外推用的递减率：湿润山区 5.5°C/km
  // ⚠️ 绝不能"所有点都用锚点温度"——那样只要有一个站取失败，整页就会全变成山脚温度
  const SINGLE_ANCHOR_LAPSE = 0.0055;
  function interpTemp(elev) {
    if (!anchors.length) return null;
    if (anchors.length === 1) {
      const a = anchors[0];
      const dh = elev - a.elev;
      const t = a.temp - dh * SINGLE_ANCHOR_LAPSE;
      // 限幅放宽到 -20°C（3000m 高差约 -14°C），只防异常值
      return Math.max(a.temp - 20, Math.min(a.temp + 3, t));
    }
    const first = anchors[0], last = anchors[anchors.length - 1];
    let lo = first, hi = anchors[1];
    if (elev >= last.elev) {
      lo = anchors[anchors.length - 2]; hi = last;
    } else if (elev > first.elev) {
      for (let i = 0; i < anchors.length - 1; i++) {
        if (elev >= anchors[i].elev && elev <= anchors[i + 1].elev) { lo = anchors[i]; hi = anchors[i + 1]; break; }
      }
    }
    const raw = lo.temp + (elev - lo.elev) * slopeOf(lo, hi);
    // 落在最低~最高锚点之间的点：线性连接本身就是最合理的估算，直接返回。
    // ⚠️ 这里曾经无条件把结果压进 [first±3°C]，导致山腰点被硬拽到山脚温度附近：
    //    报国寺 16.7°(500m) / 金顶 7.3°(3077m) 时，雷洞坪(2430m) 正确内插是 9.7°，
    //    却被 clamp 到 16.7-3=13.7°，比金顶高 6.4°C，与"距金顶仅 647m"的事实明显矛盾。
    if (elev >= first.elev && elev <= last.elev) return raw;
    // 只有外推到锚点区间之外（山顶之上 / 山脚之下）才限幅，避免跑飞
    const nearest = elev > last.elev ? last : first;
    return Math.max(nearest.temp - 3, Math.min(nearest.temp + 3, raw));
  }

  // ④ 落值
  const staleNote = staleAt
    ? `（含${Math.max(1, Math.round((Date.now() - staleAt) / 60000))}分钟前实测）`
    : '';
  results.forEach(r => {
    if (r.local && r.obs.ok) {
      r.baseTemp = r.obs.temp;
      r.sourceShort = '实测';
      r.source = `${r.obs.provider}实测 · ${r.obs.stationName || r.cnName || ''}`;
    } else {
      const t = interpTemp(r.elev);
      if (t == null) {           // 完全没有锚点时不做校正，回落到模型值
        r.baseTemp = null;
        r.sourceShort = '模型';
        r.source = '无实测数据，用模型预报值';
        return;
      }
      r.baseTemp = t;
      r.sourceShort = anchors.length > 1 ? '插值' : '推算';
      r.source = anchors.length > 1
        ? `据实测廓线（${anchors.map(a => `${a.key}${a.temp.toFixed(0)}°`).join(' → ')}）${staleNote}`
        : `据${anchors[0].key}实测 ${anchors[0].temp.toFixed(1)}° + 海拔递减推算`;
    }
    baseTempMap[r.display] = r.baseTemp;
  });

  obsStations = results;
  obsVersion++;   // 基准温度已更新：让此前发起、尚未返回的请求不要污染缓存
  // measured 只算"本次真正取到的实测站"，缓存补的锚点不计入，避免页脚误报一切正常
  const realMeasured = results.filter(r => r.local && r.obs.ok).length;
  obsSummary = {
    ok: true, updatedAt: Date.now(), backend: backendOk,
    measured: realMeasured, anchorsUsed: anchors.length, total: results.length,
    staleAt, anchors
  };
}


// 当前小时在 hourly 数组中的下标（current.time 是 15 分钟粒度，不能直接 indexOf）
function currentHourIndex(data) {
  const nowIso = data?.current?.time || '';
  const arr = data?.hourly?.time || [];
  if (!arr.length) return 0;
  const i = arr.findIndex(t => t >= nowIso);
  return i < 0 ? 0 : i;
}

// 带超时 + 重试的 fetch：Open-Meteo 偶尔 503（短时并发限流），
// 原来裸 fetch 一旦失败/挂起，卡片就永远停在「加载中…」，用户只能干等。
async function fetchWithRetry(url, { tries = 3, timeout = 12000 } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch {} }, timeout) : null;
    try {
      const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
      if (timer) clearTimeout(timer);
      if (res.ok) return res;
      lastErr = new Error(`请求失败（${res.status}）`);
      // 4xx 是请求本身的问题，重试没意义；429 限流除外
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
    } catch (e) {
      if (timer) clearTimeout(timer);
      lastErr = e;
    }
    if (i < tries - 1) await new Promise(r => setTimeout(r, 600 * (i + 1)));
  }
  throw lastErr || new Error('请求失败');
}

async function fetchForecast(name) {
  const hit = dataCache.get(name);
  if (hit && hit._obsV === obsVersion) return hit;
  if (hit) dataCache.delete(name);   // 实况已更新，这份是按旧校正算的，作废重取
  const vAtStart = obsVersion;       // 记下发起时的版本，用于判断返回时是否已过期
  const loc = await geocode(name);
  const params = [
    `latitude=${loc.lat}`,
    `longitude=${loc.lon}`,
    `current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m,surface_pressure,pressure_msl,cloud_cover`,
    `hourly=temperature_2m,weather_code,precipitation_probability,wind_speed_10m,visibility,is_day`,
    `daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant`,
    `timezone=auto`,
    `forecast_days=7`
  ].join('&');
  const url = `https://api.open-meteo.com/v1/forecast?${params}`;
  const res = await fetchWithRetry(url);
  const json = await res.json();
  json._display = loc.display;
  json._lat = loc.lat;   // 详情页拉空气质量要用
  json._lon = loc.lon;

  // 按真实海拔做温度归算：模型按地形高程(DEM)修正过一次，这里补全 真实海拔 与 DEM 的差值
  if (loc.realElevation != null && json.elevation != null) {
    const adj = (loc.realElevation - json.elevation) * 0.0065; // °C，真高->更冷
    json._elevationAdj = adj;
    json._realElevation = loc.realElevation;
    if (json.current) {
      ['temperature_2m', 'apparent_temperature'].forEach(k => {
        if (json.current[k] != null) json.current[k] += adj;
      });
    }
    if (json.hourly?.temperature_2m) json.hourly.temperature_2m = json.hourly.temperature_2m.map(v => v + adj);
    if (json.daily) {
      if (json.daily.temperature_2m_max) json.daily.temperature_2m_max = json.daily.temperature_2m_max.map(v => v + adj);
      if (json.daily.temperature_2m_min) json.daily.temperature_2m_min = json.daily.temperature_2m_min.map(v => v + adj);
    }
  } else {
    json._realElevation = json.elevation != null ? Math.round(json.elevation) : null;
  }

  // 全局温度校准偏移（管理员在设置里可调，用于把模型值对齐到信任的实测源）
  const off = Number(settings?.tempOffset) || 0;
  if (off) {
    if (json.current) {
      ['temperature_2m', 'apparent_temperature'].forEach(k => {
        if (json.current[k] != null) json.current[k] += off;
      });
    }
    if (json.hourly?.temperature_2m) json.hourly.temperature_2m = json.hourly.temperature_2m.map(v => v == null ? v : v + off);
    if (json.daily) {
      if (json.daily.temperature_2m_max) json.daily.temperature_2m_max = json.daily.temperature_2m_max.map(v => v == null ? v : v + off);
      if (json.daily.temperature_2m_min) json.daily.temperature_2m_min = json.daily.temperature_2m_min.map(v => v == null ? v : v + off);
    }
  }

  // 实况校正：该点若有实测/推算的基准温度，把偏差平移到模型（保留地形细节）
  // 逐小时按"距当前时刻"线性衰减：0-24h 内偏差由全量平滑衰减到 0，
  // 显式优于原先"只改今天"——那样逐小时时间轴一跨到次日就会退回模型原始值，
  // 高海拔点会瞬间跳变（金顶模型 3°C / 实测 11°C，跨零点即出现 8°C 断崖）。
  // 未来 2 天以外仍完全是模型预报，不把某次逆温的偶然偏差带进远期。
  if (settings.useObservation !== false) {
    const base = baseTempMap[json._display];
    if (base != null && json.current?.temperature_2m != null) {
      const d = base - json.current.temperature_2m;
      json.current.temperature_2m += d;
      if (json.current.apparent_temperature != null) json.current.apparent_temperature += d;
      if (json.hourly?.time && json.hourly.temperature_2m) {
        const curMs = json.current.time ? new Date(json.current.time).getTime() : NaN;
        json.hourly.time.forEach((t, i) => {
          const v = json.hourly.temperature_2m[i];
          if (v == null) return;
          let w = 1;
          if (isFinite(curMs)) {
            const dt = (new Date(t).getTime() - curMs) / 3600000; // 距当前的小时数
            if (isFinite(dt) && dt > 0) w = Math.max(0, 1 - dt / 24);
          }
          json.hourly.temperature_2m[i] = v + d * w;
        });
      }
      if (json.daily) {
        if (json.daily.temperature_2m_max?.[0] != null) json.daily.temperature_2m_max[0] += d;
        if (json.daily.temperature_2m_min?.[0] != null) json.daily.temperature_2m_min[0] += d;
      }
      json._obsApplied = d;
      json._obsBase = base;
    }

    // 该点若是真·实测站，用实测的湿度/风/能见度覆盖模型当前值，避免"温度实测、湿度却是模型"的自相矛盾
    const st = obsStations.find(s => s.display === json._display);
    if (st && st.local && st.obs?.ok) {
      json._observed = {
        station: st.obs.stationName || st.cnName || '',
        at: st.obs.observedAt || '',
        elev: st.obsElev || null,
        humidity: st.obs.humidity ?? null,
        pressure: st.obs.pressure ?? null,
        visibility: st.obs.visibility || '',
        windDir: st.obs.windDir || '',
        windPower: st.obs.windPower || ''
      };
      if (st.obs.humidity != null && json.current) {
        json.current.relative_humidity_2m = st.obs.humidity;
      }
    }
  }

  // 只缓存"发起时版本 == 当前版本"的结果；过期请求的返回值仍返回给调用方，
  // 但不落缓存，避免它覆盖掉后续请求已经写好的正确值。
  json._obsV = vAtStart;
  if (vAtStart === obsVersion) dataCache.set(name, json);
  return json;
}

/* ===================== 渲染：首页卡片 ===================== */
// 页脚数据来源：把"实测是否生效"明确写出来，避免用户看到一串相同温度却不知道原因
function updateFooterSource() {
  const el = document.getElementById('footer-source');
  if (!el) return;
  if (!backendOk) {
    el.textContent = '⚠️ 未连接实测后端（需通过 localhost:8080 或线上链接打开）：当前温度来自第三方数据源与模型推算，可能不够准确';
    return;
  }
  if (obsSummary && obsSummary.ok && obsSummary.measured < 2) {
    el.textContent = obsSummary.measured === 0
      ? '⚠️ 实测接口暂未返回数据（可能被限流）：当前显示模型预报值，稍后点刷新重试'
      : '⚠️ 当前只有 1 个实测站可用（山顶站可能被限流），其余点按海拔推算，稍后点刷新可恢复';
    return;
  }
  el.textContent = '数据来源：中国气象局自动站实况（金顶站／峨眉山市站）+ Open-Meteo 数值预报；无实测站的点按实测温度廓线插值';
}

/* ===================== 节气 / 法定节假日 ===================== */
function renderDayInfo() {
  const el = document.getElementById('day-info');
  if (!el || !window.WeatherCalendar) return;
  try {
    const info = WeatherCalendar.getDayInfo();
    const parts = [];
    if (info.holiday) {
      parts.push('<span class="di-holiday is-in">' + info.holiday.name +
        ' 假期第 <b>' + info.holiday.day + '/' + info.holiday.total + '</b> 天</span>');
    }
    if (info.term) {
      const isToday = info.termIn === 0;
      parts.push('<span class="di-term' + (isToday ? ' is-today' : '') + '">' +
        info.term + (isToday ? ' · 今天' : '') + '</span>');
    }
    if (!info.holiday && info.nextHoliday) {
      parts.push('<span class="di-holiday">距' + info.nextHoliday.name +
        ' <b>' + info.nextHoliday.days + '</b> 天</span>');
    }
    el.innerHTML = parts.join('<span class="di-sep">·</span>');
  } catch (e) {
    el.textContent = '';
  }
}

/* ===================== 底部攻略入口（预留位） ===================== */
function guideCfg(key) {
  return (settings.guides && settings.guides[key]) || DEFAULT_SETTINGS.guides[key] || {};
}

function renderGuides() {
  document.querySelectorAll('.guide-card').forEach(btn => {
    const cfg = guideCfg(btn.dataset.guide);
    const nameEl = btn.querySelector('.guide-name');
    const subEl = btn.querySelector('.guide-sub');
    if (cfg.title) nameEl.textContent = cfg.title;
    if (cfg.sub) {
      subEl.textContent = cfg.sub;
      subEl.classList.remove('hidden');
    } else {
      subEl.textContent = '';
      subEl.classList.add('hidden');
    }
  });
}

function openGuide(key) {
  const cfg = guideCfg(key);
  const fallback = key === 'hiking' ? '峨眉山徒步攻略' : '峨眉山美食攻略';
  document.getElementById('guide-modal-title').textContent = cfg.title || fallback;
  const body = document.getElementById('guide-modal-body');
  const parts = [];
  if (cfg.body) parts.push(`<p class="guide-body-text">${escapeHtml(cfg.body)}</p>`);
  if (cfg.url) {
    parts.push(`<a class="guide-open-link" href="${escapeAttr(cfg.url)}" target="_blank" rel="noopener">打开完整攻略 →</a>`);
  }
  if (!parts.length) parts.push('<div class="guide-empty">攻略内容准备中，稍后补充。</div>');
  body.innerHTML = parts.join('');
  document.getElementById('guide-modal').classList.remove('hidden');
}

function closeGuide() {
  document.getElementById('guide-modal').classList.add('hidden');
}

function renderHome() {
  document.getElementById('app-title').textContent = settings.title;
  document.getElementById('app-subtitle').textContent = settings.subtitle;
  document.title = `${settings.title} · 天气预报`;
  applyBackground();
  updateFooterSource();
  renderDayInfo();
  renderGuides();

  const container = document.getElementById('cards');
  container.innerHTML = '';
  settings.regions.forEach((region, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="card-loading">加载中…</div>`;
    card.addEventListener('click', () => openDetail(region));
    container.appendChild(card);
    loadCard(card, region);
  });
  renderElevationChart();
}

/* ===================== 海拔气温剖面图 ===================== */
async function renderElevationChart() {
  const el = document.getElementById('elev-chart');
  el.innerHTML = '<div class="card-loading">加载海拔气温…</div>';
  // 与首页卡片方向一致：山脚 → 山顶（低海拔到高海拔）
  const spots = ['报国寺', '清音阁', '万年寺', '雷洞坪', '金顶']
    .map(k => KNOWN_PLACES[k])
    .filter(Boolean);
  try {
    const results = await Promise.all(spots.map(s =>
      fetchForecast(s.display).then(d => ({
        name: s.display.replace(/^峨眉山/, ''),
        elev: s.realElevation,
        // 有基准温度（实测 / 按实测廓线插值）就直接用，保证与首页卡片数字完全一致；
        // 否则退回模型值（fetchForecast 内部已按真实海拔归算过）
        temp: (settings.useObservation !== false && baseTempMap[s.display] != null)
          ? baseTempMap[s.display]
          : d.current.temperature_2m
      }))
    ));
    drawElevChart(el, results);
  } catch (e) {
    el.innerHTML = `<div class="card-error">⚠️ 海拔图加载失败：${escapeHtml(e.message)}</div>`;
  }
}

function drawElevChart(el, data) {
  // data: [{name, elev, temp}]
  const W = 680, H = 340;
  const padL = 48, padR = 20, padT = 20, padB = 44;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const temps = data.map(d => d.temp);
  let tMin = Math.min(...temps), tMax = Math.max(...temps);
  const tPad = Math.max(2, (tMax - tMin) * 0.15);
  tMin -= tPad; tMax += tPad;

  const eMin = 0, eMax = 3200;
  const x = e => padL + (e - eMin) / (eMax - eMin) * plotW;
  const y = t => padT + (tMax - t) / (tMax - tMin) * plotH;

  // 网格 + Y 轴刻度（温度）
  let grid = '';
  const ySteps = 5;
  for (let i = 0; i <= ySteps; i++) {
    const tv = tMin + (tMax - tMin) * i / ySteps;
    const yy = y(tv);
    grid += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>`;
    grid += `<text x="${padL - 8}" y="${yy + 4}" fill="rgba(255,255,255,0.75)" font-size="11" text-anchor="end">${tv.toFixed(0)}°</text>`;
  }
  // X 轴刻度（海拔）
  const xSteps = 4;
  for (let i = 0; i <= xSteps; i++) {
    const ev = eMin + (eMax - eMin) * i / xSteps;
    const xx = x(ev);
    grid += `<text x="${xx}" y="${H - padB + 18}" fill="rgba(255,255,255,0.75)" font-size="11" text-anchor="middle">${ev}m</text>`;
  }

  // 折线
  const linePts = data.map(d => `${x(d.elev)},${y(d.temp)}`).join(' ');
  const areaPts = `${x(data[0].elev)},${y(tMin)} ` + linePts + ` ${x(data[data.length-1].elev)},${y(tMin)}`;

  // 趋势线（最小二乘拟合，展示平均递减率），范围限定在数据海拔区间内
  const n = data.length;
  const sx = data.reduce((s, d) => s + d.elev, 0);
  const sy = data.reduce((s, d) => s + d.temp, 0);
  const sxx = data.reduce((s, d) => s + d.elev * d.elev, 0);
  const sxy = data.reduce((s, d) => s + d.elev * d.temp, 0);
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const intercept = (sy - slope * sx) / n;
  const tx1 = Math.min(...data.map(d => d.elev));
  const tx2 = Math.max(...data.map(d => d.elev));
  const trendPts = `${x(tx1)},${y(intercept + slope * tx1)} ${x(tx2)},${y(intercept + slope * tx2)}`;
  const lapse = (slope * 1000).toFixed(1); // °C / 1000m

  // 数据点 + 标签
  let dots = '';
  data.forEach(d => {
    dots += `<circle cx="${x(d.elev)}" cy="${y(d.temp)}" r="5" fill="#ffd166" stroke="#fff" stroke-width="1.5"/>`;
    dots += `<text x="${x(d.elev)}" y="${y(d.temp) - 12}" fill="#fff" font-size="12" font-weight="600" text-anchor="middle">${d.temp.toFixed(1)}°</text>`;
    dots += `<text x="${x(d.elev)}" y="${H - padB + 34}" fill="rgba(255,255,255,0.9)" font-size="11" text-anchor="middle">${d.name}</text>`;
  });

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="峨眉山海拔气温剖面图">
      ${grid}
      <polygon points="${areaPts}" fill="rgba(110,198,255,0.18)"/>
      <polyline points="${trendPts}" fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="2" stroke-dasharray="6 4"/>
      <polyline points="${linePts}" fill="none" stroke="#6ec6ff" stroke-width="2.5"/>
      ${dots}
      <text x="${padL}" y="${padT - 6}" fill="rgba(255,255,255,0.6)" font-size="11">温度(°C)</text>
      <text x="${W - padR}" y="${padT - 6}" fill="rgba(255,255,255,0.75)" font-size="11" text-anchor="end">平均递减率 ≈ ${lapse}°C/1000m</text>
    </svg>`;
}

async function loadCard(card, region) {
  try {
    const data = await fetchForecast(region.name);
    const cur = data.current;
    const info = wmo(cur.weather_code, cur.is_day);
    const ci = clothingIndex(cur.apparent_temperature, cur.weather_code);
    const start = currentHourIndex(data);
    // 该点是实测还是推算
    const st = obsStations.find(s => s.display === data._display);
    let srcTag = '模型预报';
    if (settings.useObservation !== false && st && st.baseTemp != null) {
      if (st.local && st.obs?.ok) {
        if (st.obs.provider === '中国天气网') {
          const t = st.obs.observedAt ? ` ${st.obs.observedAt}` : '';
          // 上游限流时服务端会回退到上次成功值，明确标出"几分钟前抓取"，别当实时
          const old = st.obs.stale && st.obs.ageMin != null ? ` · ${st.obs.ageMin}分钟前抓取` : '';
          srcTag = `实测 · ${st.obs.stationName || st.cnName || ''}${t}${old}`;
        } else {
          // 第三方源（wttr.in 等）通常只是"最近站"，不等于本地实测，不能标成实测
          srcTag = `第三方站 · ${st.obs.stationName || '最近站'}`;
        }
      } else if (st.sourceShort === '推算') {
        srcTag = `推算 · 由山脚实测递减`;
      } else {
        srcTag = `插值 · 据实测廓线`;
      }
    }
    const hours = [];
    for (let k = start; k < Math.min(start + 8, data.hourly.time.length); k++) {
      const hi = wmo(data.hourly.weather_code[k], data.hourly.is_day?.[k] ?? 1);
      hours.push(`
        <div class="hour-cell">
          <div class="h-time">${hhmm(data.hourly.time[k])}</div>
          <div class="h-icon">${hi.icon}</div>
          <div class="h-temp">${Math.round(data.hourly.temperature_2m[k])}°</div>
        </div>`);
    }
    card.innerHTML = `
      <div class="card-head">
        <div>
          <div class="card-name">${escapeHtml(region.name)}</div>
          ${region.caption ? `<div class="card-caption">${escapeHtml(region.caption)}</div>` : ''}
        </div>
        <div class="card-now">
          <div class="card-temp">${Math.round(cur.temperature_2m)}°</div>
          <div class="card-desc">${info.text}</div>
        </div>
      </div>
      <div class="card-icon">${info.icon}</div>
      <div class="card-hours">${hours.join('')}</div>
      <div class="card-cloth">${ci.icon} 穿衣：${ci.level}</div>
      <div class="card-src">${escapeHtml(srcTag)}</div>
    `;
  } catch (e) {
    card.innerHTML = `<div class="card-error">⚠️ ${escapeHtml(region.name)}<br>
      <span style="font-size:12px;opacity:.75">${escapeHtml(e.message || '加载失败')} · 点右上角 ↻ 重试</span></div>`;
  }
}

/* ===================== 渲染：全屏详情 ===================== */
/* ---------- 详情页小工具 ---------- */
// 空气质量走 Open-Meteo 独立的 air-quality 接口（同样免 key）。
// 拿不到就返回 null，页面显示"暂无"，不阻塞其他内容。
async function fetchAirQuality(lat, lon) {
  if (lat == null || lon == null) return null;
  try {
    const u = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}` +
      `&current=european_aqi,pm2_5,pm10,ozone&timezone=auto`;
    const res = await fetchWithRetry(u, { tries: 2, timeout: 8000 });
    if (!res.ok) return null;
    const j = await res.json();
    return j.current || null;
  } catch { return null; }
}
// 欧洲 AQI 分级（Open-Meteo 的 european_aqi）
function aqiWord(v) {
  if (v == null) return { word: '暂无', tone: 'cool' };
  if (v <= 20) return { word: '优', tone: 'good' };
  if (v <= 40) return { word: '良', tone: 'good' };
  if (v <= 60) return { word: '中等', tone: 'warm' };
  if (v <= 80) return { word: '较差', tone: 'warn' };
  if (v <= 100) return { word: '很差', tone: 'warn' };
  return { word: '极差', tone: 'warn' };
}
function windDirName(deg) {
  if (deg == null || !isFinite(deg)) return '—';
  const names = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  return names[Math.round(((deg % 360) + 360) % 360 / 45) % 8] + '风';
}
function humidityWord(h) {
  if (h == null) return '';
  if (h < 30) return '干燥';
  if (h < 50) return '较干爽';
  if (h < 70) return '较舒适';
  if (h < 85) return '潮湿';
  return '很潮湿';
}
function uvWord(uv) {
  if (uv == null) return '';
  // 按 WHO 紫外线指数分级
  if (uv < 3) return '最弱';
  if (uv < 6) return '中等';
  if (uv < 8) return '强';
  if (uv < 11) return '很强';
  return '极强';
}
function feelsWord(f) {
  if (f == null) return '';
  if (f >= 32) return '炎热';
  if (f >= 26) return '偏热';
  if (f >= 18) return '舒适';
  if (f >= 10) return '凉爽';
  if (f >= 0) return '较冷';
  return '寒冷';
}
// 生活指数：纯启发式规则，给游客一个"带不带伞/防不防晒/穿多少"的快速判断，
// 不作为专业气象建议。所有输入都来自当前点位的实时/预报数据。
function lifeIndices(cur, data) {
  const feels = cur.apparent_temperature ?? cur.temperature_2m ?? 15;
  const code = cur.weather_code ?? 0;
  const hum = cur.relative_humidity_2m ?? 60;
  const wind = cur.wind_speed_10m ?? 0;
  const pop = data.daily?.precipitation_probability_max?.[0] ?? 0;
  const uv = data.daily?.uv_index_max?.[0] ?? 0;
  const tmin = data.daily?.temperature_2m_min?.[0];
  const tmax = data.daily?.temperature_2m_max?.[0];
  const swing = (tmax != null && tmin != null) ? tmax - tmin : 0;
  const rainy = /雨|雪|雷/.test(wmo(code, cur.is_day).text);
  const ci = clothingIndex(feels, code);
  const out = [];

  out.push({ icon: ci.icon, name: '穿衣', level: ci.level, tip: ci.advice, tone: 'cool' });

  if (uv >= 7) out.push({ icon: '🕶️', name: '防晒', level: '强', tip: '紫外线强，帽子防晒霜都要', tone: 'warn' });
  else if (uv >= 3) out.push({ icon: '🧴', name: '防晒', level: '中等', tip: '正午前后注意遮挡', tone: 'warm' });
  else out.push({ icon: '🧴', name: '防晒', level: '较弱', tip: '紫外线弱，可不做防护', tone: 'good' });

  if (rainy || pop >= 60) out.push({ icon: '☔', name: '出游', level: '较不宜', tip: '有降水，备好雨具再上山', tone: 'warn' });
  else if (feels <= 0 || code === 45 || code === 48) out.push({ icon: '🚶', name: '出游', level: '一般', tip: '较冷或有雾，注意保暖防滑', tone: 'warm' });
  else out.push({ icon: '🥾', name: '出游', level: '适宜', tip: '天气不错，适合徒步游览', tone: 'good' });

  if (pop >= 50 || rainy) out.push({ icon: '🧺', name: '晾晒', level: '不宜', tip: '有降水，衣物不易干', tone: 'warn' });
  else if (hum >= 85) out.push({ icon: '🧺', name: '晾晒', level: '较不宜', tip: '湿度大，晾干较慢', tone: 'warm' });
  else out.push({ icon: '🧺', name: '晾晒', level: '适宜', tip: '空气干爽，适合晾晒', tone: 'good' });

  if (wind >= 28 || feels <= 2) out.push({ icon: '🎣', name: '钓鱼', level: '不宜', tip: '风大或水温低，鱼口差', tone: 'warn' });
  else if (wind >= 18) out.push({ icon: '🎣', name: '钓鱼', level: '较不宜', tip: '风力偏大，注意安全', tone: 'warm' });
  else out.push({ icon: '🎣', name: '钓鱼', level: '适宜', tip: '风力温和，适合垂钓', tone: 'good' });

  if (pop >= 40 || rainy) out.push({ icon: '🚗', name: '洗车', level: '不宜', tip: '未来有降水，洗了也白洗', tone: 'warn' });
  else out.push({ icon: '🚗', name: '洗车', level: '适宜', tip: '近期无明显降水', tone: 'good' });

  if (hum >= 80 && wind >= 12) out.push({ icon: '🤧', name: '过敏', level: '易发', tip: '潮风利于霉菌孢子扩散', tone: 'warn' });
  else out.push({ icon: '🤧', name: '过敏', level: '少发', tip: '过敏原浓度较低', tone: 'good' });

  if (swing >= 10) out.push({ icon: '💊', name: '感冒', level: '易发', tip: '昼夜温差大，勤增减衣物', tone: 'warn' });
  else if (feels <= 3) out.push({ icon: '💊', name: '感冒', level: '较易发', tip: '气温偏低，注意保暖', tone: 'warm' });
  else out.push({ icon: '💊', name: '感冒', level: '少发', tip: '气温平稳，注意通风', tone: 'good' });

  return out;
}

async function openDetail(region) {
  const modal = document.getElementById('detail');
  const content = document.getElementById('detail-content');
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  content.innerHTML = `<div class="card-loading">加载详细预报…</div>`;
  try {
    const data = await fetchForecast(region.name);
    const aq = await fetchAirQuality(data._lat, data._lon);
    const ai = aqiWord(aq?.european_aqi);
    const cur = data.current;
    const info = wmo(cur.weather_code, cur.is_day);
    const todayMin = Math.round(data.daily.temperature_2m_min[0]);
    const todayMax = Math.round(data.daily.temperature_2m_max[0]);

    /* ---------- 逐小时（24 小时） ---------- */
    const start = currentHourIndex(data);
    const hoursHtml = [];
    for (let k = start; k < Math.min(start + 24, data.hourly.time.length); k++) {
      const hh = Number(data.hourly.time[k].slice(11, 13));
      const hi = wmo(data.hourly.weather_code[k], data.hourly.is_day?.[k] ?? (hh >= 7 && hh < 19 ? 1 : 0));
      const pop = data.hourly.precipitation_probability?.[k];
      hoursHtml.push(`
        <div class="dt-hour${k === start ? ' now' : ''}">
          <div class="h-time">${k === start ? '现在' : hhmm(data.hourly.time[k])}</div>
          <div class="h-icon">${hi.icon}</div>
          <div class="h-temp">${Math.round(data.hourly.temperature_2m[k])}°</div>
          <div class="h-pop">${pop != null && pop > 0 ? pop + '%' : ''}</div>
        </div>`);
    }

    /* ---------- 7 天（温度条按全周期归一化，便于横向比较） ---------- */
    const lows = data.daily.temperature_2m_min;
    const highs = data.daily.temperature_2m_max;
    const gMin = Math.min(...lows), gMax = Math.max(...highs);
    const span = Math.max(1, gMax - gMin);
    const daysHtml = data.daily.time.map((d, i) => {
      const di = wmo(data.daily.weather_code[i], 1);
      const { label, md } = fmtDay(d, i);
      const lo = Math.round(lows[i]), hi = Math.round(highs[i]);
      const left = ((lows[i] - gMin) / span) * 100;
      const width = Math.max(7, ((highs[i] - lows[i]) / span) * 100);
      const popD = data.daily.precipitation_probability_max?.[i];
      return `
        <div class="dt-day">
          <div class="dd-when"><b>${label}</b><small>${md}</small></div>
          <div class="dd-ico">${di.icon}</div>
          <div class="dd-txt">${di.text}${popD >= 30 ? `<small>${popD}%</small>` : ''}</div>
          <div class="dd-track"><span style="left:${left}%;width:${width}%"></span></div>
          <div class="dd-tp"><b>${hi}°</b><span>${lo}°</span></div>
        </div>`;
    }).join('');

    /* ---------- 指标 ---------- */
    const feels = Math.round(cur.apparent_temperature);
    const hum = cur.relative_humidity_2m;
    const windDeg = cur.wind_direction_10m;
    const windSpd = Math.round(cur.wind_speed_10m);
    const windLv = windSpd < 6 ? 1 : windSpd < 12 ? 2 : windSpd < 20 ? 3 : windSpd < 29 ? 4 : windSpd < 39 ? 5 : 6;
    // 高海拔用本地气压(surface_pressure)更直观：金顶约 700hPa
    const pressLocal = cur.surface_pressure != null ? Math.round(cur.surface_pressure) : null;
    const pressSea = cur.pressure_msl != null ? Math.round(cur.pressure_msl) : null;
    const vis = data.hourly.visibility?.[start];
    const uv = data.daily.uv_index_max?.[0];
    const sunrise = data.daily.sunrise?.[0] ? hhmm(data.daily.sunrise[0]) : '—';
    const sunset = data.daily.sunset?.[0] ? hhmm(data.daily.sunset[0]) : '—';
    const rainToday = data.daily.precipitation_sum?.[0];
    const popMax = data.daily.precipitation_probability_max?.[0];

    // 当前时刻在日出→日落之间的进度（用于弧形条）
    const toMin = (iso, part) => {
      if (!iso) return null;
      const t = part === 'time' ? iso : iso;
      return Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16));
    };
    const nowMin = toMin(cur.time);
    const srMin = toMin(data.daily.sunrise?.[0]);
    const ssMin = toMin(data.daily.sunset?.[0]);
    const dayPct = (srMin != null && ssMin != null && ssMin > srMin && nowMin != null)
      ? Math.max(0, Math.min(100, (nowMin - srMin) / (ssMin - srMin) * 100)) : 0;
    const sunState = (nowMin == null || ssMin == null) ? ''
      : nowMin >= ssMin ? '已日落'
        : (srMin != null && nowMin < srMin) ? '未日出' : '白天';

    const feelsPct = Math.max(4, Math.min(100, (feels + 15) / 50 * 100));
    const humPct = Math.max(4, Math.min(100, hum ?? 0));
    const uvPct = Math.max(4, Math.min(100, (uv ?? 0) / 11 * 100));
    const visKm = vis != null ? (vis / 1000) : null;
    const visPct = visKm != null ? Math.max(4, Math.min(100, visKm / 20 * 100)) : 4;

    const gridHtml = `
      <div class="dt-grid">
        <div class="dt-card">
          <div class="dt-ch"><span class="dt-ci">🌡️</span><span class="dt-cl">体感温度</span></div>
          <div class="dt-cv">${feels}<small>°C</small></div>
          <div class="dt-cs">${feelsWord(feels)}</div>
          <div class="dt-bar"><i style="width:${feelsPct}%;background:linear-gradient(90deg,#7fd3ff,#ffd166)"></i></div>
        </div>

        <div class="dt-card">
          <div class="dt-ch"><span class="dt-ci">💧</span><span class="dt-cl">湿度</span></div>
          <div class="dt-cv">${hum != null ? hum : '—'}<small>%</small></div>
          <div class="dt-cs">${humidityWord(hum)}</div>
          <div class="dt-bar"><i style="width:${humPct}%;background:linear-gradient(90deg,#9be7ff,#4aa8e0)"></i></div>
        </div>

        <div class="dt-card">
          <div class="dt-ch"><span class="dt-ci">🧭</span><span class="dt-cl">风向风力</span></div>
          <div class="dt-cv dt-cv-row">
            <span class="dt-arrow" style="transform:rotate(${(windDeg ?? 0) + 180}deg)">↑</span>
            <span>${windLv}<small>级</small></span>
          </div>
          <div class="dt-cs">${windDirName(windDeg)} · ${windSpd} km/h</div>
        </div>

        <div class="dt-card">
          <div class="dt-ch"><span class="dt-ci">☀️</span><span class="dt-cl">紫外线（今日峰值）</span></div>
          <div class="dt-cv">${uv != null ? Math.round(uv) : '—'}<small>指数</small></div>
          <div class="dt-cs">${uvWord(uv == null ? null : Math.round(uv))}</div>
          <div class="dt-bar"><i style="width:${uvPct}%;background:linear-gradient(90deg,#ffe082,#ff8a65,#e53935)"></i></div>
        </div>

        <div class="dt-card">
          <div class="dt-ch"><span class="dt-ci">👁️</span><span class="dt-cl">能见度</span></div>
          <div class="dt-cv">${visKm != null ? visKm.toFixed(1) : '—'}<small>km</small></div>
          <div class="dt-cs">${visKm == null ? '暂无' : visKm >= 10 ? '通透' : visKm >= 5 ? '一般' : visKm >= 1 ? '较差' : '很差'}</div>
          <div class="dt-bar"><i style="width:${visPct}%;background:linear-gradient(90deg,#c7f0ff,#7fb8d9)"></i></div>
        </div>

        <div class="dt-card">
          <div class="dt-ch"><span class="dt-ci">🎚️</span><span class="dt-cl">气压</span></div>
          <div class="dt-cv">${pressLocal != null ? pressLocal : '—'}<small>hPa</small></div>
          <div class="dt-cs">${pressSea != null ? `海平面 ${pressSea} hPa` : '本地气压'}</div>
          ${pressLocal != null && pressLocal < 800 ? '<div class="dt-note">高海拔低气压，注意保暖</div>' : ''}
        </div>

        <div class="dt-card dt-card-wide">
          <div class="dt-ch"><span class="dt-ci">🍃</span><span class="dt-cl">空气质量</span></div>
          <div class="dt-aq">
            <div class="aq-main">
              <b>${aq && aq.european_aqi != null ? Math.round(aq.european_aqi) : '—'}</b>
              <small>AQI</small>
              <em class="aq-tone-${ai.tone}">${ai.word}</em>
            </div>
            <div class="aq-parts">
              <span>PM2.5<b>${aq && aq.pm2_5 != null ? Math.round(aq.pm2_5) : '—'}</b></span>
              <span>PM10<b>${aq && aq.pm10 != null ? Math.round(aq.pm10) : '—'}</b></span>
              <span>臭氧<b>${aq && aq.ozone != null ? Math.round(aq.ozone) : '—'}</b></span>
            </div>
          </div>
        </div>

        <div class="dt-card dt-card-wide">
          <div class="dt-ch"><span class="dt-ci">🌅</span><span class="dt-cl">日出日落${sunState ? ' · ' + sunState : ''}</span></div>
          <div class="dt-sun">
            <span class="dt-sun-time"><b>${sunrise}</b><small>日出</small></span>
            <span class="dt-sun-track"><i style="left:${dayPct}%"></i></span>
            <span class="dt-sun-time"><b>${sunset}</b><small>日落</small></span>
          </div>
        </div>

        <div class="dt-card dt-card-wide">
          <div class="dt-ch"><span class="dt-ci">🌧️</span><span class="dt-cl">今日降水</span></div>
          <div class="dt-rain">
            <span><b>${rainToday != null ? rainToday.toFixed(1) : '—'}</b><small>mm 累计</small></span>
            <span><b>${popMax != null ? popMax : '—'}</b><small>% 概率</small></span>
            <span><b>${Math.round(cur.cloud_cover ?? 0)}</b><small>% 云量</small></span>
          </div>
        </div>
      </div>`;

    /* ---------- 生活指数 ---------- */
    const life = lifeIndices(cur, data);
    const lifeHtml = life.map(it => `
      <div class="dt-life-item tone-${it.tone}">
        <span class="li-ico">${it.icon}</span>
        <span class="li-name">${it.name}</span>
        <span class="li-level">${it.level}</span>
        <span class="li-tip">${it.tip}</span>
      </div>`).join('');

    /* ---------- 数据来源 ---------- */
    const st = obsStations.find(s => s.display === data._display);
    const elevTxt = data._realElevation != null ? data._realElevation + ' m' : '—';
    let srcBadge, srcDetail;
    if (settings.useObservation !== false && st && st.baseTemp != null && st.local && st.obs?.ok) {
      const t = st.obs.observedAt ? ` ${st.obs.observedAt}` : '';
      const sName = st.obs.stationName || st.cnName || '';
      srcBadge = `<span class="dt-live">● 实测</span> ${escapeHtml(sName)}${t}`;
      srcDetail = `实测 ${st.baseTemp.toFixed(1)}°C，取自中国气象局自动站${st.obsElev ? `（站点海拔 ${Math.round(st.obsElev)} m）` : ''}；其余指标为 Open-Meteo 数值预报${data._elevationAdj != null ? '，已按真实海拔 ' + elevTxt + ' 归算' : ''}。`;
    } else if (settings.useObservation !== false && st && st.baseTemp != null) {
      srcBadge = `<span class="dt-interp">● 插值</span> 据实测温度廓线`;
      srcDetail = `该点位无公开自动站，温度按实测点连成的海拔廓线插值得出（${st.sourceShort === '推算' ? '单点推算' : '多点插值'}），其余指标为 Open-Meteo 数值预报${data._elevationAdj != null ? '，已按真实海拔 ' + elevTxt + ' 归算' : ''}。`;
    } else {
      srcBadge = `<span class="dt-model">● 模型</span> 数值预报`;
      srcDetail = `实况暂不可用，当前显示 Open-Meteo 数值预报值${data._elevationAdj != null ? '（已按真实海拔 ' + elevTxt + ' 归算）' : ''}。`;
    }
    const offNote = settings.tempOffset ? ` 全局温度校准 ${settings.tempOffset > 0 ? '+' : ''}${settings.tempOffset}°C。` : '';

    content.innerHTML = `
      <div class="dt-hero">
        <div class="dt-loc">
          <span class="dt-pin">📍</span>
          <span class="dt-locname">${escapeHtml(region.name)}</span>
          <span class="dt-elev">${escapeHtml(region.caption || elevTxt)}</span>
        </div>
        <div class="dt-hero-main">
          <div class="dt-tempbox">
            <span class="dt-temp">${Math.round(cur.temperature_2m)}</span><span class="dt-c">°C</span>
          </div>
          <div class="dt-hero-right">
            <div class="dt-bigicon">${info.icon}</div>
            <div class="dt-desc">${info.text}</div>
            <div class="dt-range">${todayMin}° ~ ${todayMax}°C</div>
          </div>
        </div>
        <div class="dt-metabar">
          <span>体感 ${feels}°</span><span>湿度 ${hum != null ? hum + '%' : '—'}</span><span>${windDirName(windDeg)} ${windLv}级</span>
        </div>
        <div class="dt-src">${srcBadge}</div>
      </div>

      <div class="dt-block">
        <div class="dt-hours">${hoursHtml.join('')}</div>
      </div>

      <div class="dt-block">
        <div class="dt-block-title">未来 7 天预报</div>
        <div class="dt-days">${daysHtml}</div>
      </div>

      <div class="dt-block">
        <div class="dt-block-title">当前指标</div>
        ${gridHtml}
      </div>

      <div class="dt-block">
        <div class="dt-block-title">生活指数 <small>参考</small></div>
        <div class="dt-life">${lifeHtml}</div>
      </div>

      <div class="dt-foot">${srcDetail}${offNote}<br>生活指数由当地实时数据推算，仅供出行参考。</div>
    `;
  } catch (e) {
    content.innerHTML = `<div class="card-error">⚠️ 加载失败：${escapeHtml(e.message)}</div>`;
  }
}

function closeDetail() {
  document.getElementById('detail').classList.add('hidden');
  document.body.style.overflow = '';
}

/* ===================== 背景 ===================== */
function applyBackground() {
  if (settings.background) {
    document.body.style.backgroundImage = `url("${settings.background}")`;
  } else {
    document.body.style.backgroundImage = '';
  }
}

/* ===================== 管理员权限 ===================== */
const ADMIN_CREDS_KEY = 'weather-admin-creds';
const ADMIN_SESSION_KEY = 'weather-admin-session';

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}
function loadAdminCreds() {
  try { return JSON.parse(localStorage.getItem(ADMIN_CREDS_KEY)); } catch { return null; }
}
function saveAdminCreds(username, pass) {
  localStorage.setItem(ADMIN_CREDS_KEY, JSON.stringify({ username, passHash: hashStr(pass) }));
}
function isAdmin() { return !!sessionStorage.getItem(ADMIN_SESSION_KEY); }
function currentAdmin() { return sessionStorage.getItem(ADMIN_SESSION_KEY) || ''; }

function updateAdminUI() {
  const admin = isAdmin();
  document.getElementById('settings-btn').classList.toggle('hidden', !admin);
  document.getElementById('admin-btn').classList.toggle('hidden', admin);
  const lo = document.getElementById('admin-logout');
  lo.classList.toggle('hidden', !admin);
  lo.textContent = admin ? ('退出(' + currentAdmin() + ')') : '';
}

function openAdmin() {
  const creds = loadAdminCreds();
  const hasCreds = !!creds;
  document.getElementById('admin-title').textContent = hasCreds ? '管理员登录' : '设置管理员';
  document.getElementById('admin-setup').classList.toggle('hidden', hasCreds);
  document.getElementById('admin-login').classList.toggle('hidden', !hasCreds);
  document.getElementById('admin-msg').textContent = '';
  document.getElementById('admin-user').value = '';
  document.getElementById('admin-pass').value = '';
  document.getElementById('admin-new-user').value = '';
  document.getElementById('admin-new-pass').value = '';
  document.getElementById('admin-new-pass2').value = '';
  document.getElementById('admin').classList.remove('hidden');
}
function closeAdmin() { document.getElementById('admin').classList.add('hidden'); }

function submitAdmin() {
  const creds = loadAdminCreds();
  if (!creds) {
    const u = document.getElementById('admin-new-user').value.trim();
    const p = document.getElementById('admin-new-pass').value;
    const p2 = document.getElementById('admin-new-pass2').value;
    if (!u) { toast('请输入用户名'); return; }
    if (p.length < 4) { toast('密码至少 4 位'); return; }
    if (p !== p2) { toast('两次密码不一致'); return; }
    saveAdminCreds(u, p);
    sessionStorage.setItem(ADMIN_SESSION_KEY, u);
    closeAdmin(); updateAdminUI(); toast('管理员已设置并登录');
  } else {
    const u = document.getElementById('admin-user').value.trim();
    const p = document.getElementById('admin-pass').value;
    if (u === creds.username && hashStr(p) === creds.passHash) {
      sessionStorage.setItem(ADMIN_SESSION_KEY, u);
      closeAdmin(); updateAdminUI(); toast('登录成功');
    } else {
      document.getElementById('admin-msg').textContent = '用户名或密码错误';
    }
  }
}
function logoutAdmin() {
  sessionStorage.removeItem(ADMIN_SESSION_KEY);
  updateAdminUI(); toast('已退出管理');
}

/* ===================== 设置弹窗 ===================== */
function openSettings() {
  if (!isAdmin()) { toast('请先以管理员身份登录'); openAdmin(); return; }
  document.getElementById('set-title').value = settings.title;
  document.getElementById('set-subtitle').value = settings.subtitle;
  document.getElementById('set-tempoffset').value = settings.tempOffset ?? 0;
  document.getElementById('set-use-obs').checked = settings.useObservation !== false;
  document.getElementById('set-qweather-key').value = settings.qweatherKey || '';
  document.getElementById('set-bg-url').value = '';
  ['hiking', 'food'].forEach(key => {
    const p = key === 'hiking' ? 'set-guide-hike' : 'set-guide-food';
    const c = (settings.guides && settings.guides[key]) || {};
    document.getElementById(p + '-title').value = c.title || '';
    document.getElementById(p + '-sub').value = c.sub || '';
    document.getElementById(p + '-body').value = c.body || '';
    document.getElementById(p + '-url').value = c.url || '';
  });
  renderRegionList();
  document.getElementById('settings').classList.remove('hidden');
}
function closeSettings() {
  document.getElementById('settings').classList.add('hidden');
}

function renderRegionList() {
  const list = document.getElementById('region-list');
  list.innerHTML = '';
  settings.regions.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'region-row';
    row.innerHTML = `
      <input class="rr-name" type="text" value="${escapeAttr(r.name)}" placeholder="地区名">
      <input class="rr-caption" type="text" value="${escapeAttr(r.caption || '')}" placeholder="备注文字">
      <button class="icon-btn rr-del" title="删除">🗑</button>
    `;
    row.querySelector('.rr-del').addEventListener('click', () => {
      settings.regions.splice(i, 1);
      renderRegionList();
    });
    list.appendChild(row);
  });
}

function saveSettingsFromUI() {
  settings.title = document.getElementById('set-title').value.trim() || DEFAULT_SETTINGS.title;
  settings.subtitle = document.getElementById('set-subtitle').value.trim() || DEFAULT_SETTINGS.subtitle;
  const offVal = parseFloat(document.getElementById('set-tempoffset').value);
  settings.tempOffset = isNaN(offVal) ? 0 : offVal;
  settings.useObservation = document.getElementById('set-use-obs').checked;
  settings.qweatherKey = document.getElementById('set-qweather-key').value.trim();
  const rows = document.querySelectorAll('#region-list .region-row');
  const regions = [];
  rows.forEach(row => {
    const name = row.querySelector('.rr-name').value.trim();
    const caption = row.querySelector('.rr-caption').value.trim();
    if (name) regions.push({ name, caption });
  });
  if (regions.length < 3) {
    toast('至少需要保留 3 个地区');
    return;
  }
  settings.regions = regions;
  // 底部攻略入口：标题留空则回落默认标题，正文/链接留空即"准备中"
  const readGuide = (key, prefix) => ({
    title: document.getElementById(prefix + '-title').value.trim() || DEFAULT_SETTINGS.guides[key].title,
    sub: document.getElementById(prefix + '-sub').value.trim(),
    body: document.getElementById(prefix + '-body').value.trim(),
    url: document.getElementById(prefix + '-url').value.trim()
  });
  settings.guides = {
    hiking: readGuide('hiking', 'set-guide-hike'),
    food: readGuide('food', 'set-guide-food')
  };
  saveSettings();
  closeSettings();
  dataCache.clear();
  renderHome();
  loadObservations().then(() => { dataCache.clear(); renderHome(); });
  toast('已保存');
}

function resetSettings() {
  settings = deepClone(DEFAULT_SETTINGS);
  geoCache.clear();
  dataCache.clear();
  saveSettings();
  closeSettings();
  renderHome();
  toast('已恢复默认');
}

/* ===================== 转义 ===================== */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

/* ===================== 事件绑定 ===================== */
document.getElementById('settings-btn').addEventListener('click', openSettings);
document.getElementById('settings-close').addEventListener('click', closeSettings);
document.getElementById('settings-save').addEventListener('click', saveSettingsFromUI);
document.getElementById('settings-reset').addEventListener('click', resetSettings);
document.getElementById('detail-close').addEventListener('click', closeDetail);

// 底部攻略入口
document.querySelectorAll('.guide-card').forEach(btn => {
  btn.addEventListener('click', () => openGuide(btn.dataset.guide));
});
document.getElementById('guide-modal-close').addEventListener('click', closeGuide);
document.getElementById('guide-modal').addEventListener('click', e => {
  if (e.target.id === 'guide-modal') closeGuide();
});
document.getElementById('add-region').addEventListener('click', () => {
  settings.regions.push({ name: '新地区', caption: '' });
  renderRegionList();
});
document.getElementById('refresh-btn').addEventListener('click', async () => {
  dataCache.clear();
  geoCache.clear();
  await probeBackend();
  await loadObservations();
  renderHome();
  const okCnt = obsStations.filter(s => s.local && s.obs.ok).length;
  toast(obsSummary?.ok ? `已刷新（${okCnt} 个点实测，其余海拔推算）` : '已刷新（实况不可用，用模型）');
});

// 背景图：URL
document.getElementById('set-bg-url-btn').addEventListener('click', () => {
  const url = document.getElementById('set-bg-url').value.trim();
  if (!url) { toast('请输入图片链接'); return; }
  settings.background = url;
  applyBackground();
  toast('背景已应用，记得保存');
});
// 背景图：上传
document.getElementById('set-bg-file').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    settings.background = reader.result;
    applyBackground();
    toast('背景已应用，记得保存');
  };
  reader.readAsDataURL(file);
});
// 背景图：清除
document.getElementById('set-bg-clear').addEventListener('click', () => {
  settings.background = '';
  applyBackground();
  toast('已清除背景，记得保存');
});

// 点击遮罩关闭弹窗
document.getElementById('settings').addEventListener('click', e => {
  if (e.target.id === 'settings') closeSettings();
});
document.getElementById('admin-btn').addEventListener('click', openAdmin);
document.getElementById('admin-close').addEventListener('click', closeAdmin);
document.getElementById('admin-cancel').addEventListener('click', closeAdmin);
document.getElementById('admin-submit').addEventListener('click', submitAdmin);
document.getElementById('admin-logout').addEventListener('click', logoutAdmin);
document.getElementById('admin').addEventListener('click', e => {
  if (e.target.id === 'admin') closeAdmin();
});
/* ===================== 分享转发 ===================== */
// 分享链接参数：t=标题 st=副标题 r=地区（名称~说明，用 | 分隔）
// 打开带参数链接时以链接内容为准，且不写入本地存储，避免污染访客自己的设置
function applyShareParams() {
  const q = new URLSearchParams(location.search);
  if (![...q.keys()].length) return false;
  const t = q.get('t');
  const st = q.get('st');
  if (t) settings.title = t.slice(0, 30);
  if (st) settings.subtitle = st.slice(0, 40);
  const bg = q.get('bg');
  if (bg && /^https?:\/\//.test(bg)) settings.background = bg;
  const r = q.get('r');
  if (r) {
    const list = r.split('|').map(seg => {
      const [name, caption] = seg.split('~');
      return name && name.trim() ? { name: name.trim(), caption: (caption || '').trim() } : null;
    }).filter(Boolean).slice(0, 8);
    if (list.length) settings.regions = list;
  }
  return true;
}

function buildShareUrl() {
  let u;
  try {
    u = new URL(location.href.split('#')[0]);
  } catch {
    return location.href;
  }
  const q = u.searchParams;
  // 清掉旧的文案参数，但要保留 sharecode 等访问凭证（线上链接必需）
  ['t', 'st', 'r', 'bg'].forEach(k => q.delete(k));
  // 只把「与默认不同」的内容写进链接，默认配置下链接保持简短
  if (settings.title !== DEFAULT_SETTINGS.title) q.set('t', settings.title);
  if (settings.subtitle !== DEFAULT_SETTINGS.subtitle) q.set('st', settings.subtitle);
  if (JSON.stringify(settings.regions) !== JSON.stringify(DEFAULT_SETTINGS.regions)) {
    q.set('r', settings.regions.map(x => `${x.name}~${x.caption || ''}`).join('|'));
  }
  // 背景图只带网络 URL（本地上传的是 dataURL，太长带不动）
  if (settings.background && /^https?:\/\//.test(settings.background) && settings.background.length < 600) {
    q.set('bg', settings.background);
  }
  const qs = q.toString();
  return `${u.origin}${u.pathname}${qs ? '?' + qs : ''}`;
}

function openShare() {
  const url = buildShareUrl();
  const input = document.getElementById('share-url');
  input.value = url;

  // 二维码（带失败兜底：加载不出来就隐藏，不影响复制链接）
  const qr = document.getElementById('share-qr');
  const box = qr.closest('.share-qr-box');
  box.classList.remove('hidden');
  qr.onerror = () => box.classList.add('hidden');
  qr.src = `https://api.qrserver.com/v1/create-qr-code/?size=352x352&margin=10&data=${encodeURIComponent(url)}`;

  // 移动端优先用系统分享（能直接选微信/QQ）
  document.getElementById('share-native').classList.toggle('hidden', !navigator.share);

  const sTitle = `${settings.title} · 天气预报`;
  document.getElementById('share-weibo').href =
    `https://service.weibo.com/share/share.php?url=${encodeURIComponent(url)}&title=${encodeURIComponent(sTitle)}`;
  document.getElementById('share-qq').href =
    `https://connect.qq.com/widget/shareqq/index.html?url=${encodeURIComponent(url)}&title=${encodeURIComponent(sTitle)}`;
  document.getElementById('share-mail').href =
    `mailto:?subject=${encodeURIComponent(sTitle)}&body=${encodeURIComponent('峨眉山天气看板：' + url)}`;

  document.getElementById('share').classList.remove('hidden');
}

function closeShare() {
  document.getElementById('share').classList.add('hidden');
}

async function copyShareUrl() {
  const url = document.getElementById('share-url').value;
  try {
    await navigator.clipboard.writeText(url);
    toast('链接已复制，去微信粘贴吧');
    return;
  } catch {
    // 非 https（如局域网 IP 访问）时 clipboard 不可用，降级到 execCommand
  }
  const input = document.getElementById('share-url');
  input.removeAttribute('readonly');
  input.select();
  input.setSelectionRange(0, 99999);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  input.setAttribute('readonly', '');
  toast(ok ? '链接已复制，去微信粘贴吧' : '复制失败，请长按链接手动复制');
}

async function nativeShare() {
  const url = document.getElementById('share-url').value;
  try {
    await navigator.share({ title: `${settings.title} · 天气预报`, text: '峨眉山实时天气看板', url });
  } catch {
    /* 用户取消，忽略 */
  }
}

document.getElementById('share-btn').addEventListener('click', openShare);
document.getElementById('share-close').addEventListener('click', closeShare);
document.getElementById('share-copy').addEventListener('click', copyShareUrl);
document.getElementById('share-native').addEventListener('click', nativeShare);
document.getElementById('share-url').addEventListener('click', e => e.target.select());
document.getElementById('share').addEventListener('click', e => {
  if (e.target.id === 'share') closeShare();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeDetail(); closeSettings(); closeAdmin(); closeShare(); }
});

/* ===================== 启动 ===================== */
applyShareParams();  // 若为分享链接，先按链接里的文案/地区覆盖
updateAdminUI();
renderHome();  // 先用模型快速渲染
// 先探测后端（后端在才有中国天气网真实测站），再拉实况
probeBackend().then(() => loadObservations()).then(() => {
  if (Object.keys(baseTempMap).length) {   // 拿到实况后清缓存重绘，应用校正
    dataCache.clear();
    renderHome();
    const okCnt = obsStations.filter(s => s.local && s.obs.ok).length;
    console.info(`[实况] 后端=${backendOk ? '已连接' : '未连接'} 实测点=${okCnt}/${obsStations.length}`);
  }
});
