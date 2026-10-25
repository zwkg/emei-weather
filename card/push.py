# -*- coding: utf-8 -*-
"""
推送到微信（Server 酱）。

环境变量：
    SERVERCHAN_KEY   必填，Server 酱 SendKey
    GITHUB_REPOSITORY  Actions 自动注入，格式 owner/repo
    IMG_REF           图片所在 commit（默认取 HEAD）
    CARD_OUT          出图目录
"""
import os
import sys
import json
import subprocess
import urllib.parse
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, ".."))
OUT = os.environ.get("CARD_OUT") or os.path.join(ROOT, "out")
KEY = (os.environ.get("SERVERCHAN_KEY") or "").strip()
REPO = (os.environ.get("GITHUB_REPOSITORY") or "").strip()


def git_sha():
    ref = (os.environ.get("IMG_REF") or "").strip()
    if ref:
        return ref
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True,
            stderr=subprocess.DEVNULL).strip()
    except Exception:
        return ""


def image_url(sha):
    """jsDelivr 走 CDN，国内可达性比 raw.githubusercontent 好；用 sha 定位避免缓存旧图。"""
    if not (REPO and sha):
        return ""
    return "https://cdn.jsdelivr.net/gh/%s@%s/out/latest.jpg" % (REPO, sha)


def read_summary():
    p = os.path.join(OUT, "latest.json")
    if not os.path.isfile(p):
        return {}
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def build_message(s):
    spots = s.get("spots") or []
    line = " · ".join("%s %.0f°" % (x["short"], x["temp"]) for x in spots)
    cal = s.get("cal") or {}
    term = cal.get("term") or ""
    holiday = cal.get("holiday") or {}
    nxt = cal.get("nextHoliday") or {}
    tail = []
    if term:
        tail.append("节气 %s" % term)
    if holiday:
        tail.append("%s 假期第 %s 天" % (holiday.get("name", ""), holiday.get("day", "")))
    elif nxt:
        tail.append("距%s %s 天" % (nxt.get("name", ""), nxt.get("days", "")))
    date = s.get("date") or ""
    title = "峨眉山天气 %s" % (date[5:].replace("-", "/") if date else "")
    if spots:
        title += " · 金顶 %.0f°" % spots[-1]["temp"]
    return title, line, " · ".join(tail)


def send(title, desp):
    if KEY.startswith("sctp"):
        uid = KEY[4:].split("t")[0]
        url = "https://%s.push.ft07.com/send/%s.send" % (uid, KEY)
    else:
        url = "https://sctapi.ftqq.com/%s.send" % KEY
    body = urllib.parse.urlencode({"title": title, "desp": desp}).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode("utf-8", "ignore")


def main():
    s = read_summary()
    title, line, extra = build_message(s)
    url = image_url(git_sha())

    parts = []
    if line:
        parts.append("**%s**" % line)
    if extra:
        parts.append(extra)
    if url:
        parts.append("![今日天气长图](%s)" % url)
    if REPO:
        parts.append("[图没显示？点这里看原图](https://github.com/%s/blob/main/out/latest.jpg)" % REPO)
    desp = "\n\n".join(parts) or "今日天气图已更新"

    if not KEY:
        print("未配置 SERVERCHAN_KEY，跳过推送")
        print("---- 预览 ----")
        print(title)
        print(desp)
        return 0
    try:
        res = send(title, desp)
        print("推送返回：", res[:200])
    except Exception as e:
        print("推送失败：", e)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
