/*!
 * 二十四节气 + 法定节假日
 * 节气用太阳视黄经实时算（Meeus 简化算法，1900-2100 误差 < 1 分钟）
 * 节假日：2026 年按国办发明电〔2025〕7 号；2027 年只含固定公历节日，待国务院公布后补充
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WeatherCalendar = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TERMS = ['小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨',
    '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑',
    '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至'];
  var LON = [285, 300, 315, 330, 345, 0, 15, 30, 45, 60, 75, 90,
    105, 120, 135, 150, 165, 180, 195, 210, 225, 240, 255, 270];

  var HOLIDAYS = [
    { name: '元旦', start: '2026-01-01', end: '2026-01-03', days: 3 },
    { name: '春节', start: '2026-02-15', end: '2026-02-23', days: 9 },
    { name: '清明节', start: '2026-04-04', end: '2026-04-06', days: 3 },
    { name: '劳动节', start: '2026-05-01', end: '2026-05-05', days: 5 },
    { name: '端午节', start: '2026-06-19', end: '2026-06-21', days: 3 },
    { name: '中秋节', start: '2026-09-25', end: '2026-09-27', days: 3 },
    { name: '国庆节', start: '2026-10-01', end: '2026-10-07', days: 7 },
    { name: '元旦', start: '2027-01-01', end: '2027-01-03', days: 3 },
    { name: '清明节', start: '2027-04-04', end: '2027-04-06', days: 3 },
    { name: '劳动节', start: '2027-05-01', end: '2027-05-03', days: 3 },
    { name: '国庆节', start: '2027-10-01', end: '2027-10-07', days: 7 },
    { name: '元旦', start: '2028-01-01', end: '2028-01-03', days: 3 }
  ];

  // ---------- 天文计算 ----------
  function jdFromYMD(y, m, d) {
    var a = Math.floor((14 - m) / 12);
    var yy = y + 4800 - a;
    var mm = m + 12 * a - 3;
    return d + Math.floor((153 * mm + 2) / 5) + 365 * yy
      + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
  }

  function sunLongitude(jd) {
    var T = (jd - 2451545.0) / 36525.0;
    var L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
    var M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * Math.PI / 180;
    var C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M)
      + (0.019993 - 0.000101 * T) * Math.sin(2 * M)
      + 0.000289 * Math.sin(3 * M);
    var omega = (125.04 - 1934.136 * T) * Math.PI / 180;
    var lam = L0 + C - 0.00569 - 0.00478 * Math.sin(omega);
    return ((lam % 360) + 360) % 360;
  }

  function f(jd, lon) {
    return ((sunLongitude(jd) - lon + 180) % 360 + 360) % 360 - 180;
  }

  function jdToBJDate(jd) {
    var z = Math.floor(jd + 0.5 + 8 / 24);
    var a = z;
    if (z >= 2299161) {
      var alpha = Math.floor((z - 1867216.25) / 36524.25);
      a = z + 1 + alpha - Math.floor(alpha / 4);
    }
    var b = a + 1524;
    var c = Math.floor((b - 122.1) / 365.25);
    var dd = Math.floor(365.25 * c);
    var e = Math.floor((b - dd) / 30.6001);
    var day = b - dd - Math.floor(30.6001 * e);
    var month = e < 14 ? e - 1 : e - 13;
    var year = month > 2 ? c - 4716 : c - 4715;
    return { y: year, m: month, d: day };
  }

  var termCache = {};
  function termDates(year) {
    if (termCache[year]) return termCache[year];
    var jd0 = jdFromYMD(year, 1, 1);
    var jd1 = jdFromYMD(year + 1, 1, 1) + 1;
    var out = [];
    for (var i = 0; i < 24; i++) {
      var lon = LON[i];
      var prevJD = jd0, prevF = f(jd0, lon), lo = null, hi = null;
      for (var jd = jd0 + 1; jd <= jd1; jd += 1) {
        var cur = f(jd, lon);
        if (prevF <= 0 && cur > 0) { lo = prevJD; hi = jd; break; }
        prevJD = jd; prevF = cur;
      }
      if (lo === null) { out.push(null); continue; }
      for (var k = 0; k < 42; k++) {
        var mid = (lo + hi) / 2;
        if (f(mid, lon) > 0) hi = mid; else lo = mid;
      }
      out.push({ name: TERMS[i], date: jdToBJDate((lo + hi) / 2) });
    }
    termCache[year] = out;
    return out;
  }

  // ---------- 日期工具 ----------
  function ymd(s) { var p = s.split('-'); return { y: +p[0], m: +p[1], d: +p[2] }; }
  function diffDays(a, b) {
    return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
  }
  function fmtShort(d) { return (d.m) + '/' + (d.d); }

  /**
   * @param {Date} [dateObj] 默认今天
   * @returns {{term:string, termDate:string, termIn:number, nextTerm:string,
   *            nextTermIn:number, holiday:?{name:string,day:number,total:number},
   *            nextHoliday:?{name:string, date:string, days:number}}}
   */
  function getDayInfo(dateObj) {
    var now = dateObj || new Date();
    var today = { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };

    // 节气：取今天及前后一年内的全部节点，找最近一个「已到」的和「下一个」
    var list = [];
    for (var y = today.y - 1; y <= today.y + 1; y++) {
      var arr = termDates(y);
      for (var i = 0; i < arr.length; i++) {
        if (arr[i]) list.push(arr[i]);
      }
    }
    var prevTerm = null, prevGap = null, nextTerm = null, nextGap = null;
    for (var n2 = 0; n2 < list.length; n2++) {
      var g = diffDays(today, list[n2].date);
      if (g <= 0) {
        if (prevGap === null || g > prevGap) { prevTerm = list[n2]; prevGap = g; }
      } else {
        if (nextGap === null || g < nextGap) { nextTerm = list[n2]; nextGap = g; }
      }
    }

    // 节假日
    var inHoliday = null;
    for (var h = 0; h < HOLIDAYS.length; h++) {
      var it = HOLIDAYS[h];
      var s = ymd(it.start), e = ymd(it.end);
      if (diffDays(today, s) <= 0 && diffDays(today, e) >= 0) {
        inHoliday = {
          name: it.name,
          day: diffDays(s, today) + 1,
          total: diffDays(s, e) + 1
        };
        break;
      }
    }
    var nextHoliday = null;
    for (var m = 0; m < HOLIDAYS.length; m++) {
      var n = HOLIDAYS[m];
      var ns = ymd(n.start);
      var gap = diffDays(today, ns);
      if (gap > 0) {
        nextHoliday = { name: n.name, date: fmtShort(ns), days: gap, total: diffDays(ns, ymd(n.end)) + 1 };
        break;
      }
    }

    // 元旦倒计时（距明年 1 月 1 日）
    var daysToNewYear = diffDays(today, { y: today.y + 1, m: 1, d: 1 });
    // 今天是否正好是某个节气（不再把「已过的节气」当成当前节气）
    var termIsToday = prevTerm ? (diffDays(prevTerm.date, today) === 0) : false;
    // 是否正处于「元旦」法定假期内（此时不再单独显示倒计时，避免重复）
    var inNewYearHoliday = !!(inHoliday && inHoliday.name === '元旦');

    return {
      term: prevTerm ? prevTerm.name : '',
      termDate: prevTerm ? fmtShort(prevTerm.date) : '',
      termIn: prevTerm ? diffDays(prevTerm.date, today) : null,
      termIsToday: termIsToday,
      nextTerm: nextTerm ? nextTerm.name : '',
      nextTermIn: nextTerm ? diffDays(today, nextTerm.date) : null,
      holiday: inHoliday,
      nextHoliday: nextHoliday,
      daysToNewYear: daysToNewYear,
      inNewYearHoliday: inNewYearHoliday
    };
  }

  /* 一行可读文案，图里和网页都用它 */
  function summary(dateObj) {
    var i = getDayInfo(dateObj);
    var parts = [];
    if (i.holiday) {
      parts.push(i.holiday.name + ' 假期第 ' + i.holiday.day + '/' + i.holiday.total + ' 天');
    }
    // 节气：今天显示节气名，否则显示「距下一个节气」倒计时
    if (i.termIsToday) {
      parts.push(i.term + '（今天）');
    } else if (i.nextTerm) {
      parts.push('距' + i.nextTerm + ' ' + i.nextTermIn + ' 天');
    }
    // 距离元旦倒计时（元旦假期期间不单独显示）
    if (!i.inNewYearHoliday && i.daysToNewYear != null) {
      parts.push('距元旦 ' + i.daysToNewYear + ' 天');
    }
    return parts.join(' · ');
  }

  return {
    TERMS: TERMS,
    termDates: termDates,
    getDayInfo: getDayInfo,
    summary: summary
  };
});
