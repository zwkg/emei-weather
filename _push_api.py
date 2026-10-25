"""用 GitHub API 把本地目录整体推成一次提交（绕过 git over HTTPS 的代理问题）。

用 Git Database API：先逐个建 blob，再建 tree，再建 commit，最后强制更新 ref。
新的 tree 不含旧路径 = 删除旧文件，正好用来清掉历史里带旧底图的样张。

用法：
    python _push_api.py 仓库目录 owner/repo 分支 [令牌]
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request

REPO = sys.argv[2] if len(sys.argv) > 2 else "zwkg/emei-weather"
BRANCH = sys.argv[3] if len(sys.argv) > 3 else "main"
TOKEN = sys.argv[4] if len(sys.argv) > 4 else os.environ.get("GH_TOKEN", "")
ROOT = os.path.abspath(sys.argv[1])

SKIP_DIRS = {".git", "__pycache__", "node_modules"}
SKIP_FILES = {"latest.path", ".DS_Store"}


def api(method, path, body=None, raw=False):
    url = "https://api.github.com" + path
    data = None
    if body is not None:
        data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "token " + TOKEN)
    req.add_header("Accept", "application/vnd.github+json")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                txt = r.read().decode()
                return txt if raw else json.loads(txt)
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:400]
            if e.code in (502, 503, 504) and attempt < 4:
                import time
                time.sleep(4 * (attempt + 1))
                continue
            raise SystemExit("HTTP %s %s\n%s" % (e.code, path, detail))


def collect():
    files = []
    for base, dirs, names in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for n in names:
            if n in SKIP_FILES or n.endswith(".pyc"):
                continue
            p = os.path.join(base, n)
            rel = os.path.relpath(p, ROOT).replace("\\", "/")
            files.append((rel, p))
    return files


def main():
    files = collect()
    print("待上传 %d 个文件" % len(files))

    entries = []
    for i, (rel, path) in enumerate(files, 1):
        with open(path, "rb") as f:
            b = f.read()
        blob = api("POST", "/repos/%s/git/blobs" % REPO,
                   {"content": base64.b64encode(b).decode(), "encoding": "base64"})
        mode = "100755" if os.access(path, os.X_OK) and rel.endswith(".sh") else "100644"
        entries.append({"path": rel, "mode": mode, "type": "blob", "sha": blob["sha"]})
        if i % 8 == 0 or i == len(files):
            print("  blob %d/%d" % (i, len(files)))

    tree = api("POST", "/repos/%s/git/trees" % REPO, {"tree": entries})
    print("tree:", tree["sha"])

    ref = api("GET", "/repos/%s/git/ref/heads/%s" % (REPO, BRANCH))
    parent = [ref["object"]["sha"]]

    commit = api("POST", "/repos/%s/git/commits" % REPO, {
        "message": sys.argv[5] if len(sys.argv) > 5 else "更新底图与内容",
        "tree": tree["sha"], "parents": parent})
    print("commit:", commit["sha"])

    api("PATCH", "/repos/%s/git/refs/heads/%s" % (REPO, BRANCH),
        {"sha": commit["sha"], "force": True})
    print("已推送到 %s/%s，commit %s" % (REPO, BRANCH, commit["sha"][:8]))


if __name__ == "__main__":
    main()
