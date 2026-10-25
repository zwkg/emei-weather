# 峨眉山天气长图 · 云端版

每天早上 7:00（北京时间）自动生成一张峨眉山天气长图，提交到仓库，并推送到微信。

## 目录

```
web/     看板服务（中国气象局自动站实测 + Open-Meteo 预报，Node 原生 http，无依赖）
card/    出图脚本（Playwright 渲染 HTML → JPEG）与微信推送
  bg/    天气底图：七种天气各一张，按当天金顶天气代码自动选
out/     每天产出的图：latest.jpg 一直是今天这张
.github/ 定时任务配置
```

## 天气底图怎么换

`card/bg/` 下按天气档位命名，缺哪张就自动回落到 `sun.jpg`：

| 文件 | 对应天气 | WMO code |
| --- | --- | --- |
| `sun.jpg` | 晴 | 0, 1 |
| `partly.jpg` | 晴间多云 | 2 |
| `cloud.jpg` | 阴 | 3 |
| `fog.jpg` | 雾 | 45, 48 |
| `rain.jpg` | 毛毛雨 / 雨 / 阵雨 | 51–67, 80–82 |
| `snow.jpg` | 雪 | 71–77, 85, 86 |
| `thunder.jpg` | 雷雨 | 95, 96, 99 |

雾天和雪天会自动多压一档暗（`.hero-bg.dim`），否则背景太亮文字会糊。

### 底图的来源与版权

`bg/_master_original.jpg` 是**纯 AI 文本生成**的金顶十方普贤场景（没有以任何摄影作品
为输入），其余六档天气由 `card/_weathers.py` 用代码在这张图上调色、叠云、画雨丝雪花
闪电合成而来。

这样做的原因：早先那版底图是用摄影作品做图生图改出来的，属于原作品的「改编作品」，
用于商业场景仍有版权关联。改成从零生成后，整条派生链与任何摄影作品无关。

合成脚本要点：

- **金色主体保护** `restore_gold()`：天气处理要去饱和、压暗、叠白雾，但画面里唯一的
  暖色就是金佛，一起洗掉就只剩灰糊一片，所以按掩膜把金色区域混回去。
- 改天气效果只需动 `card/_weathers.py`，重跑一次即可重新生成七档，不消耗任何生图额度。
- `_strip_wm.py` 用来去掉生图自带右下角的「AI生成 / WORKBUDDY」水印；当前底图是直接
  裁掉水印区解决的（佛像基座少一圈台阶，横幅底部本就渐隐，看不出差别）。

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
