# 峨眉山天气长图 · 云端版

每天早上 7:00（北京时间）自动生成一张峨眉山天气长图，提交到仓库，并推送到微信。

## 目录

```
web/     看板服务（中国气象局自动站实测 + Open-Meteo 预报，Node 原生 http，无依赖）
card/    出图脚本（Playwright 渲染 HTML → JPEG）与微信推送
out/     每天产出的图：latest.jpg 一直是今天这张
.github/ 定时任务配置
```

## 本地跑

```bash
python card/make_card.py --open     # 会自动拉起 web/server.js
```

Windows 上优先用本机 Edge，不用额外下 Chromium。

## 云端跑

每天 UTC 23:00 触发（等于北京时间次日 07:00），也可以在 Actions 页面点 Run workflow 手动跑。

需要的配置：

| 项 | 说明 |
| --- | --- |
| 仓库可见性 | **必须公开**，否则 jsDelivr 图床拿不到图 |
| Secret `SERVERCHAN_KEY` | Server 酱 SendKey，没有就跳过推送（照样出图） |

## 几个坑

- 北京时间：job 里固定 `TZ=Asia/Shanghai`，否则 runner 是 UTC，日期会差一天。
- 中文字体：ubuntu 上没有中文字体，必须装 `fonts-noto-cjk`，否则截图全变方块。
- 图床缓存：jsDelivr 按 branch 引用有 12 小时缓存，所以推送用的是 commit sha 而不是 `main`。
- GitHub 会在仓库连续 60 天没有活动后自动暂停定时任务，每月点一次 Run workflow 即可续上。
