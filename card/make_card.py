# -*- coding: utf-8 -*-
"""
峨眉山每日天气长图 —— 生成可直接在微信转发的竖版图。

用法：
    python make_card.py            # 生成到 out/emei-YYYY-MM-DD.png
    python make_card.py --open     # 生成后自动打开

数据来源：本地看板 http://127.0.0.1:8080（实测优先、插值兜底，与网页完全同源）
"""
import os
import sys
import json
import time
import base64
import shutil
import subprocess
import urllib.request
import datetime
from playwright.sync_api import sync_playwright

BASE = os.path.dirname(os.path.abspath(__file__))


def _find_project():
    """定位看板项目目录：环境变量 > 仓库内 web/ > 本机默认路径。"""
    env = os.environ.get("CARD_PROJECT")
    if env and os.path.isfile(os.path.join(env, "server.js")):
        return env
    for cand in ("web", "../web", "..", "."):
        p = os.path.abspath(os.path.join(BASE, cand))
        if os.path.isfile(os.path.join(p, "server.js")):
            return p
    return r"C:\Users\EMTT\WorkBuddy\2026-10-23-16-34-10"


PROJECT = _find_project()
PORT = int(os.environ.get("CARD_PORT", "8080"))
TZ_NAME = os.environ.get("CARD_TZ", "Asia/Shanghai")
SRC = os.environ.get("CARD_SRC", "http://127.0.0.1:%d/" % PORT)
OUT_DIR = os.environ.get("CARD_OUT") or os.path.join(
    os.path.dirname(BASE) if os.path.basename(BASE) == "card" else BASE, "out")

# ============ 落款配置（改 config.json 即可，不用动代码） ============
CFG_PATH = os.path.join(BASE, "config.json")
CFG = {
    "shop_name": "峨眉山 · 见山民宿",
    "shop_tip": "数据每天 07:00 自动更新",
    "qr_image": "",
}
try:
    with open(CFG_PATH, encoding="utf-8") as _f:
        CFG.update(json.load(_f))
except Exception:
    with open(CFG_PATH, "w", encoding="utf-8") as _f:
        json.dump(CFG, _f, ensure_ascii=False, indent=2)

SHOP_NAME = CFG.get("shop_name") or ""
SHOP_TIP = CFG.get("shop_tip") or ""
QR_IMAGE = CFG.get("qr_image") or ""
# 配置里可能是本机绝对路径，换机器跑时回落到同目录的 qr.png
if not QR_IMAGE or not os.path.exists(QR_IMAGE):
    _fallback = os.path.join(BASE, "qr.png")
    QR_IMAGE = _fallback if os.path.exists(_fallback) else ""
WEEK = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


# ============ 天气图标（内联 SVG，不依赖 emoji 字体） ============
def icon_kind(code):
    if code == 0:
        return "sun"
    if code in (1, 2):
        return "partly"
    if code == 3:
        return "cloud"
    if code in (45, 48):
        return "fog"
    if code in (51, 53, 55, 56, 57):
        return "drizzle"
    if code in (61, 63, 65, 66, 67, 80, 81, 82):
        return "rain"
    if code in (71, 73, 75, 77, 85, 86):
        return "snow"
    if code in (95, 96, 99):
        return "thunder"
    return "cloud"


WMO_TEXT = {
    0: '晴', 1: '晴间多云', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
    51: '毛毛雨', 53: '毛毛雨', 55: '密毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨',
    61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
    80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '强阵雪',
    95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷阵雨',
}


def wmo_text(code):
    return WMO_TEXT.get(code, '多云')


CLOUD_HI = ('<g fill="#C7D3E1">'
            '<circle cx="24" cy="26" r="9.5"/>'
            '<circle cx="37" cy="22" r="12"/>'
            '<rect x="17" y="24" width="31" height="10.5" rx="5.25"/></g>')

ICONS = {
    "sun": ('<g stroke="#FFC46B" stroke-width="3.4" stroke-linecap="round">'
            '<line x1="32" y1="8" x2="32" y2="15"/><line x1="32" y1="49" x2="32" y2="56"/>'
            '<line x1="8" y1="32" x2="15" y2="32"/><line x1="49" y1="32" x2="56" y2="32"/>'
            '<line x1="15" y1="15" x2="20" y2="20"/><line x1="44" y1="44" x2="49" y2="49"/>'
            '<line x1="49" y1="15" x2="44" y2="20"/><line x1="20" y1="44" x2="15" y2="49"/></g>'
            '<circle cx="32" cy="32" r="11.5" fill="#FFC46B"/>'),
    "partly": ('<circle cx="22" cy="21" r="9.5" fill="#FFC46B"/>' + CLOUD_HI),
    "cloud": CLOUD_HI,
    "fog": (CLOUD_HI + '<g stroke="#B9C8D8" stroke-width="3.6" stroke-linecap="round" opacity="0.9">'
            '<line x1="15" y1="44" x2="49" y2="44"/><line x1="21" y1="54" x2="43" y2="54"/></g>'),
    "drizzle": (CLOUD_HI + '<g stroke="#8CBEEA" stroke-width="3.2" stroke-linecap="round">'
                '<line x1="27" y1="42" x2="25" y2="50"/><line x1="38" y1="42" x2="36" y2="50"/></g>'),
    "rain": (CLOUD_HI + '<g stroke="#8CBEEA" stroke-width="3.6" stroke-linecap="round">'
             '<line x1="24" y1="42" x2="20" y2="54"/><line x1="33" y1="42" x2="29" y2="54"/>'
             '<line x1="42" y1="42" x2="38" y2="54"/></g>'),
    "snow": (CLOUD_HI + '<g fill="#DCE7F5"><circle cx="24" cy="47" r="3.1"/><circle cx="33" cy="54" r="3.1"/>'
             '<circle cx="42" cy="47" r="3.1"/></g>'),
    "thunder": (CLOUD_HI + '<path d="M35 40l-10 13h6.5l-2 11 11-15h-6.5l3.5-9z" fill="#FFD166"/>'),
}


def svg_icon(code, size=72):
    body = ICONS.get(icon_kind(code), ICONS["cloud"])
    return ('<svg width="%d" height="%d" viewBox="0 0 64 64" '
            'xmlns="http://www.w3.org/2000/svg">%s</svg>' % (size, size, body))


def cloth_tip(diff):
    if diff >= 16:
        return "山顶比山下低 <b>%d 度</b>，很冷，羽绒服、帽子手套都带上" % diff
    if diff >= 12:
        return "山顶比山下低 <b>%d 度</b>，上山务必带件厚外套" % diff
    if diff >= 8:
        return "山顶比山下低 <b>%d 度</b>，建议带一件外套" % diff
    return "山顶和山下气温接近，一件薄外套就够（相差 <b>%d 度</b>）" % diff


# ============ 抓数据 ============
GRAB_JS = """
async () => {
  const names = settings.regions.map(r => r.name);
  const out = [];
  for (const n of names) {
    const d = await fetchForecast(n);
    const s = (obsStations || []).find(x => x.display === n) || {};
    const base = (typeof baseTempMap !== 'undefined' && baseTempMap[n] != null)
      ? baseTempMap[n] : d.current.temperature_2m;
    const days = [];
    for (let i = 0; i < 4; i++) {
      days.push({
        date: d.daily.time[i],
        max: d.daily.temperature_2m_max[i],
        min: d.daily.temperature_2m_min[i],
        code: d.daily.weather_code[i],
        pop: d.daily.precipitation_probability_max[i]
      });
    }
    out.push({
      name: n, short: n.replace(/^峨眉山/, ''), elev: s.elev ?? null,
      temp: base, code: d.current.weather_code,
      src: s.sourceShort || '', days: days,
      sunrise: (d.daily.sunrise && d.daily.sunrise[0] || '').slice(11, 16),
      sunset: (d.daily.sunset && d.daily.sunset[0] || '').slice(11, 16),
      uv: (d.daily.uv_index_max && d.daily.uv_index_max[0] != null) ? d.daily.uv_index_max[0] : null,
      updated: (d.current.time || '').slice(11, 16)
    });
  }
  return {
    spots: out,
    cal: (typeof WeatherCalendar !== 'undefined') ? WeatherCalendar.getDayInfo() : null
  };
}
"""


def grab(page):
    page.goto(SRC, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(13000)
    return page.evaluate(GRAB_JS)


# ============ 模板 ============
CSS = """
* { margin:0; padding:0; box-sizing:border-box; }
body {
  width:1080px;
  font-family:"Microsoft YaHei","PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Noto Sans SC","Source Han Sans SC",sans-serif;
  background:#0b1a22;
  color:#eef4f8;
  -webkit-font-smoothing:antialiased;
}
.wrap {
  position:relative; padding:64px 72px 56px;
  background:
    radial-gradient(760px 420px at 80% 2%, rgba(255,186,110,0.15), transparent 62%),
    radial-gradient(700px 520px at 4% 30%, rgba(84,196,182,0.12), transparent 66%),
    linear-gradient(168deg,#0a161d 0%,#0e2530 44%,#123239 76%,#0d2027 100%);
}
.rings { position:absolute; inset:0; overflow:hidden; pointer-events:none; }
.rings i { position:absolute; display:block; border-radius:50%; border:1px solid rgba(140,205,205,0.10); }
.rings i:nth-child(1){ width:900px; height:900px; left:-220px; top:-340px; }
.rings i:nth-child(2){ width:640px; height:640px; left:-90px; top:-190px; border-color:rgba(140,205,205,0.07); }
.rings i:nth-child(3){ width:1100px; height:1100px; right:-470px; bottom:-500px; border-color:rgba(255,186,110,0.07); }

.hd { display:flex; align-items:center; justify-content:space-between; position:relative; }
.hd-l { display:flex; align-items:center; gap:15px; font-size:28px; letter-spacing:3px; color:#B7CFD8; }
.dot { width:10px; height:10px; border-radius:50%; background:#5BD3B4; box-shadow:0 0 0 6px rgba(91,211,180,0.15); }
.hd-r { font-size:24px; color:#71919E; letter-spacing:1px; }

.hero { margin-top:52px; display:flex; align-items:center; gap:34px; position:relative; }
.hero-temp {
  font-size:196px; line-height:0.86; font-weight:400; letter-spacing:-8px;
  background:linear-gradient(176deg,#ffffff 24%,#9DD4CC 100%);
  -webkit-background-clip:text; background-clip:text; color:transparent;
  font-variant-numeric:tabular-nums;
}
.hero-temp span { font-size:92px; letter-spacing:0; }
.hero-ic { margin-bottom:16px; display:flex; }
.hero-place { margin-bottom:22px; }
.hero-place b { display:block; font-size:46px; font-weight:400; letter-spacing:6px; color:#E8F2F6; }
.hero-place em { display:block; margin-top:12px; font-size:26px; font-style:normal; color:#7FA9B4; letter-spacing:1px; }

.cmp { margin-top:44px; display:flex; align-items:center; gap:20px; font-size:30px; color:#9CBCC6; }
.cmp b { color:#ffffff; font-weight:400; font-variant-numeric:tabular-nums; }
.cmp .sep { width:32px; height:1px; background:rgba(255,255,255,0.2); }

.sun { margin-top:20px; display:flex; align-items:center; gap:14px; font-size:26px; color:#7FA9B4; letter-spacing:1px; }
.sun b { color:#BFD8DF; font-weight:400; font-variant-numeric:tabular-nums; }
.sun .bar { width:1px; height:16px; background:rgba(255,255,255,0.16); }

.fest { margin-top:18px; display:flex; align-items:center; gap:16px; font-size:25px; color:#8FB0BB; letter-spacing:1px; }
.fest-pill {
  padding:7px 22px; border-radius:999px; font-size:24px; letter-spacing:3px;
  background:rgba(255,186,110,0.22); border:1px solid rgba(255,186,110,0.46); color:#FFDCA8;
}
.fest-pill.is-today { background:rgba(255,186,110,0.36); color:#FFF0D8; }
.fest b { color:#BFD8DF; font-weight:400; }

.tip {
  margin-top:30px; padding:28px 32px; border-radius:16px; font-size:28px; line-height:1.55;
  background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.10);
  color:#D3E4EA; display:flex; align-items:center; gap:20px;
}
.tip b { color:#FFC983; font-weight:400; }
.tip svg { flex:none; }

.list { margin-top:48px; }
.row { display:flex; align-items:center; gap:28px; padding:27px 6px; border-bottom:1px solid rgba(255,255,255,0.075); }
.row:first-child { border-top:1px solid rgba(255,255,255,0.075); }
.row .ic { flex:none; width:72px; display:flex; align-items:center; justify-content:center; }
.row .info { flex:1; min-width:0; }
.row .nm { font-size:42px; letter-spacing:4px; color:#F2F8FA; }
.row .el { margin-top:9px; font-size:24px; color:#7FA9B4; letter-spacing:1px; }
.row .el span { color:#5E8291; font-size:21px; margin-left:10px; }
.row .tp { font-size:66px; letter-spacing:-2px; color:#ffffff; font-variant-numeric:tabular-nums; }
.row .tp i { font-style:normal; font-size:34px; color:#8FB3BD; }

.sec { margin-top:58px; display:flex; align-items:baseline; gap:18px; }
.sec h2 { font-size:32px; font-weight:400; letter-spacing:6px; color:#CFE2E8; }
.sec span { font-size:22px; color:#6f8f9c; letter-spacing:1px; }

.days { margin-top:26px; display:grid; grid-template-columns:repeat(3,1fr); gap:20px; }
.day { padding:30px 22px 28px; border-radius:18px; text-align:center;
  background:rgba(255,255,255,0.045); border:1px solid rgba(255,255,255,0.085); }
.day .dl { font-size:26px; color:#9CBCC6; letter-spacing:2px; }
.day .dd { margin-top:8px; font-size:21px; color:#61818E; }
.day .di { margin:16px 0 12px; display:flex; justify-content:center; }
.day .dt { font-size:38px; color:#ffffff; font-variant-numeric:tabular-nums; }
.day .dt i { font-style:normal; font-size:26px; color:#84A6B2; }
.day .dp { margin-top:12px; font-size:21px; color:#6f8f9c; }

.ft { margin-top:52px; padding:30px 36px; border-radius:22px;
  background:rgba(255,255,255,0.07); border:1px solid rgba(255,255,255,0.14);
  display:flex; align-items:center; justify-content:space-between; gap:30px; }
.ft-l { min-width:0; }
.ft-n { font-size:44px; letter-spacing:3px; color:#FFFFFF; }
.ft-s { margin-top:14px; font-size:25px; color:#9CBCC6; letter-spacing:1px; }
.ft-q { width:158px; height:158px; border-radius:16px; flex:none; background:#fff; padding:9px; }
.ft-q img { width:100%; height:100%; display:block; border-radius:8px; }
.src { margin-top:28px; font-size:19px; color:#4E6C79; letter-spacing:0.5px; }
"""

TIP_ICON = ('<svg width="36" height="36" viewBox="0 0 24 24" fill="none" '
            'stroke="#FFC46B" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
            '<path d="M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z"/>'
            '<path d="M9.5 19h5"/></svg>')


def build_html(data, cal=None):
    top = data[-1]
    low = data[0]
    t_top, t_low = round(top["temp"]), round(low["temp"])
    diff = t_low - t_top

    now = datetime.datetime.now()
    today = now.date()
    start = 1 if now.hour >= 18 else 0        # 晚上出图就从明天起算

    rows = ""
    for s in data:
        el = ("海拔 %dm" % s["elev"]) if s["elev"] else ""
        rows += ('<div class="row"><div class="ic">%s</div>'
                 '<div class="info"><div class="nm">%s</div>'
                 '<div class="el">%s<span>%s</span></div></div>'
                 '<div class="tp">%d<i>°</i></div></div>'
                 ) % (svg_icon(s["code"], 72), s["short"], el,
                      ("· " + s["src"]) if s["src"] else "", round(s["temp"]))

    days = ""
    used = top["days"][start:start + 3]
    labels = ["明天", "后天", "大后天"] if start else ["今天", "明天", "后天"]
    for i, d in enumerate(used):
        dt = datetime.date.fromisoformat(d["date"])
        days += ('<div class="day"><div class="dl">%s</div><div class="dd">%d/%d %s</div>'
                 '<div class="di">%s</div>'
                 '<div class="dt">%d<i>°</i> <i>/ %d°</i></div>'
                 '<div class="dp">降水 %d%%</div></div>'
                 ) % (labels[i] if i < len(labels) else "", dt.month, dt.day,
                      WEEK[dt.weekday()], svg_icon(d["code"], 66),
                      round(d["max"]), round(d["min"]),
                      round(d["pop"]) if d["pop"] is not None else 0)

    qr = ""
    if QR_IMAGE and os.path.exists(QR_IMAGE):
        with open(QR_IMAGE, "rb") as _qf:
            _b64 = base64.b64encode(_qf.read()).decode("ascii")
        _mime = "image/png" if QR_IMAGE.lower().endswith(".png") else "image/jpeg"
        qr = '<div class="ft-q"><img src="data:%s;base64,%s"></div>' % (_mime, _b64)

    uvw = ""
    if top["uv"] is not None:
        u = top["uv"]
        uvw = "最弱" if u < 3 else "弱" if u < 5 else "中等" if u < 7 else "强" if u < 10 else "很强"
    sun_html = ""
    if top["sunrise"]:
        sun_html = ('<div class="sun"><span>日出 <b>%s</b></span><span class="bar"></span>'
                    '<span>日落 <b>%s</b></span>' % (top["sunrise"], top["sunset"]))
        if uvw:
            sun_html += '<span class="bar"></span><span>紫外线 %s</span>' % uvw
        sun_html += '</div>'

    hero_desc = wmo_text(top["code"])
    if top["elev"]:
        hero_desc += " · 海拔 %dm" % top["elev"]

    fest_html = ""
    if cal:
        pill = ""
        if cal.get("term"):
            is_today = cal.get("termIn") == 0
            pill = '<span class="fest-pill%s">%s%s</span>' % (
                " is-today" if is_today else "",
                cal["term"],
                "（今天）" if is_today else "",
            )
        right = ""
        if cal.get("holiday"):
            h = cal["holiday"]
            right = "%s 假期第 <b>%d/%d</b> 天" % (h["name"], h["day"], h["total"])
        elif cal.get("nextHoliday"):
            n = cal["nextHoliday"]
            right = "距%s <b>%d</b> 天" % (n["name"], n["days"])
        if pill or right:
            fest_html = '<div class="fest">%s<span>%s</span></div>' % (pill, right)

    return """<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>%s</style></head><body><div class="wrap">
<div class="rings"><i></i><i></i><i></i></div>

<div class="hd">
  <div class="hd-l"><span class="dot"></span>峨眉山 · 山景实况</div>
  <div class="hd-r">%d月%d日 %s · %s 更新</div>
</div>

<div class="hero">
  <div class="hero-temp">%d<span>°</span></div>
  <div class="hero-ic">%s</div>
  <div class="hero-place"><b>%s</b><em>%s</em></div>
</div>

<div class="cmp">
  <span>山下 %s <b>%d°</b></span><span class="sep"></span>
  <span>山上 <b>%d°</b></span><span class="sep"></span>
  <span>相差 <b>%d</b> 度</span>
</div>
%s
%s

<div class="tip">%s<span>%s</span></div>

<div class="list">%s</div>

<div class="sec"><h2>未来三天</h2><span>金顶预报</span></div>
<div class="days">%s</div>

<div class="ft">
  <div class="ft-l"><div class="ft-n">%s</div><div class="ft-s">%s</div></div>
  %s
</div>
<div class="src">实况：中国气象局自动站 · 预报：Open-Meteo 数值模式 · 图为自动生成，仅供参考</div>
</div></body></html>""" % (
        CSS, today.month, today.day, WEEK[today.weekday()], top["updated"] or "07:00",
        t_top, svg_icon(top["code"], 104), top["short"], hero_desc,
        low["short"], t_low, t_top, diff, sun_html, fest_html,
        TIP_ICON, cloth_tip(diff),
        rows, days, SHOP_NAME, SHOP_TIP, qr
    )


def health_ok():
    try:
        r = urllib.request.urlopen("http://127.0.0.1:%d/api/health" % PORT, timeout=3)
        return json.loads(r.read().decode()).get("service") == "weather-dashboard"
    except Exception:
        return False


def ensure_server():
    """看板服务没起来就自己拉一个，跑完再关掉。"""
    if health_ok():
        return None
    node = shutil.which("node") or "node"
    env = dict(os.environ, PORT=str(PORT))
    proc = subprocess.Popen(
        [node, "server.js"], cwd=PROJECT, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    for _ in range(40):
        time.sleep(0.5)
        if health_ok():
            return proc
    return proc


def main():
    started = ensure_server()
    if started:
        print("已自动拉起看板服务")
    try:
        build()
    finally:
        if started:
            started.terminate()


def launch_opts():
    """本机优先用 Edge（不额外下浏览器），云端走 playwright 自带 Chromium。"""
    opts = {"headless": True}
    exe = os.environ.get("CARD_BROWSER")
    if not exe:
        for cand in (r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                     r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"):
            if os.path.exists(cand):
                exe = cand
                break
    if exe:
        opts["executable_path"] = exe
    if sys.platform.startswith("linux"):
        opts["args"] = ["--no-sandbox", "--disable-dev-shm-usage"]
    return opts


def build():
    with sync_playwright() as p:
        b = p.chromium.launch(**launch_opts())
        page = b.new_page(viewport={"width": 1080, "height": 1500},
                          timezone_id=TZ_NAME)
        res = grab(page)
        data = res["spots"]
        cal = res.get("cal")
        print("抓到 %d 个点位：" % len(data))
        for s in data:
            print("  %s %sm %d° [%s]" % (s["short"], s["elev"], round(s["temp"]), s["src"] or "-"))
        if cal:
            print("节气/假期：", cal.get("term"), "|", cal.get("holiday") or cal.get("nextHoliday"))

        html = build_html(data, cal)
        page2 = b.new_page(viewport={"width": 1080, "height": 1500},
                           device_scale_factor=2, timezone_id=TZ_NAME)
        page2.set_content(html, wait_until="load")
        page2.wait_for_timeout(900)

        os.makedirs(OUT_DIR, exist_ok=True)
        raw = os.path.join(OUT_DIR, "_raw.png")
        page2.screenshot(path=raw, full_page=True)
        b.close()

    # 转成 JPEG：微信发图更小更快，2160 宽足够清晰
    stamp = datetime.date.today().isoformat()
    out = os.path.join(OUT_DIR, "emei-%s.jpg" % stamp)
    latest = os.path.join(OUT_DIR, "latest.jpg")
    size = (0, 0)
    try:
        from PIL import Image
        im = Image.open(raw).convert("RGB")
        im.save(out, "JPEG", quality=92, optimize=True, progressive=True)
        im.save(latest, "JPEG", quality=92, optimize=True, progressive=True)
        size = im.size
        os.remove(raw)
    except Exception as e:
        print("PIL 不可用，已输出 PNG：", e)
        ext = os.path.splitext(raw)[1] or ".png"
        out = os.path.join(OUT_DIR, "emei-%s%s" % (stamp, ext))
        latest = os.path.join(OUT_DIR, "latest%s" % ext)
        shutil.move(raw, out)
        shutil.copyfile(out, latest)
        print("尺寸未知（未装 Pillow）")

    print("已生成：", out)
    if size[0]:
        print("尺寸：%dx%d  %.0f KB" % (size[0], size[1], os.path.getsize(out) / 1024))
    else:
        print("文件大小：%.0f KB" % (os.path.getsize(out) / 1024))

    # 供后续步骤（推送/上传）读取
    with open(os.path.join(OUT_DIR, "latest.path"), "w", encoding="utf-8") as f:
        f.write(os.path.abspath(latest) + "\n")
        f.write(os.path.abspath(out) + "\n")

    summary = {
        "date": stamp,
        "week": WEEK[datetime.date.today().weekday()],
        "spots": [{"short": s["short"], "elev": s["elev"],
                   "temp": round(s["temp"]), "src": s.get("src") or ""} for s in data],
        "cal": cal,
    }
    with open(os.path.join(OUT_DIR, "latest.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)

    if "--open" in sys.argv and hasattr(os, "startfile"):
        os.startfile(out)


if __name__ == "__main__":
    main()
