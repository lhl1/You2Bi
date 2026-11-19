"""Deterministic spoken forms for Chinese VoxCPM2 input."""
from __future__ import annotations

import re
from datetime import date

_DIGITS = "零一二三四五六七八九"
_WIDTH = str.maketrans({chr(c + 0xFEE0): chr(c) for c in
                       map(ord, "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.%/$+-")})
_NUMBER = r"(?:[0-9]{1,3}(?:,[0-9]{3})+(?![0-9])|[0-9]+)(?:\.[0-9]+)?"
_SIGN = {"-": "负", "+": "正", "": ""}
_PERCENT = {"%": "百分之", "‰": "千分之", "": ""}
_UNITS = {
    "khz": "千赫兹", "mhz": "兆赫兹", "ghz": "吉赫兹", "hz": "赫兹",
    "fps": "帧每秒", "gb": "吉字节", "mb": "兆字节", "tb": "太字节",
    "km/h": "公里每小时", "km": "公里", "cm": "厘米", "mm": "毫米",
    "kg": "千克", "ms": "毫秒", "kw": "千瓦", "w": "瓦",
    "v": "伏", "db": "分贝", "°c": "摄氏度",
}
_UNIT_PATTERN = "|".join(re.escape(unit) for unit in sorted(_UNITS, key=len, reverse=True))
_TECH_TERMS = {"CPU": "中央处理器", "GPU": "图形处理器", "SSD": "固态硬盘"}
_TECH_PATTERN = re.compile(r"(?<![A-Za-z0-9-])(?:CPU|GPU|SSD)(?![A-Za-z0-9-])")


def _spell(value: str) -> str:
    return "".join(_DIGITS[int(d)] for d in value)


def _integer(value: str) -> str:
    if value == "0" or value.startswith("0") or len(value) > 16:
        return _spell(value)
    groups = [int(value[max(0, i-4):i]) for i in range(len(value), 0, -4)]
    result = ""
    gap = False
    for index in reversed(range(len(groups))):
        group = groups[index]
        if not group:
            gap = bool(result)
            continue
        if result and (gap or group < 1000):
            result += "零"
        digits = ""
        pending_zero = False
        for d, unit in zip(f"{group:04d}", ("千", "百", "十", "")):
            if d == "0":
                pending_zero |= bool(digits)
                continue
            if pending_zero:
                digits += "零"
                pending_zero = False
            digits += ("" if d == "1" and unit == "十" and not digits and not result else _DIGITS[int(d)]) + unit
        result += digits + ("", "万", "亿", "万亿")[index]
        gap = False
    return result


def _number(value: str) -> str:
    value = value.replace(",", "")
    left, dot, right = value.partition(".")
    return _integer(left) + ("点" + _spell(right) if dot else "")


def _date(match: re.Match) -> str:
    year, _, month, day = match.groups()
    try:
        date(int(year), int(month), int(day))
    except ValueError:
        return "到".join(map(_number, (year, month, day)))
    return _spell(year) + "年" + _integer(str(int(month))) + "月" + _integer(str(int(day))) + "日"


_PROTECTED = re.compile(r"https?://[^\s，。！？；]+|[\w.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", re.I)


def _normalize(text: str) -> str:
    text = text.translate(_WIDTH)
    text = _TECH_PATTERN.sub(lambda m: _TECH_TERMS[m[0]], text)
    text = re.sub(r"(?<![0-9])([0-9]{4})([-/])([0-9]{1,2})\2([0-9]{1,2})(?![0-9])", _date, text)
    text = re.sub(r"(?<![0-9])([0-9]{4})(?=\s*年)", lambda m: _spell(m[1]), text)
    text = re.sub(r"(?<![0-9])(0[1-9])(?=\s*[月日号])", lambda m: _integer(m[1][1]), text)
    text = re.sub(r"(?<![0-9:：])([01]?[0-9]|2[0-3])[:：]([0-5][0-9])(?:[:：]([0-5][0-9]))?(?![0-9]|[:：][0-9])",
                  lambda m: _integer(str(int(m[1]))) + "点" + _integer(str(int(m[2]))) + "分"
                  + (_integer(str(int(m[3]))) + "秒" if m[3] else ""), text)
    text = re.sub(rf"(?<![A-Za-z0-9.])([+-]?)({_NUMBER})([%‰]?)\s*[-~～–—]\s*([+-]?)({_NUMBER})([%‰]?)(?:\s*({_UNIT_PATTERN})(?![A-Za-z0-9]))?(?![0-9./])",
                  lambda m: _SIGN[m[1]] + _PERCENT[m[3] or m[6]] + _number(m[2])
                  + "到" + _SIGN[m[4]] + _PERCENT[m[6] or m[3]] + _number(m[5])
                  + (_UNITS[m[7].lower()] if m[7] else ""), text, flags=re.I)
    text = re.sub(rf"(?<![0-9.])([+-]?)({_NUMBER})\s*([%‰])",
                  lambda m: _SIGN[m[1]] + _PERCENT[m[3]] + _number(m[2]), text)
    text = re.sub(r"([$¥￥€£])\s*(" + _NUMBER + r")",
                  lambda m: _number(m[2]) + {"$":"美元","¥":"元","￥":"元","€":"欧元","£":"英镑"}[m[1]], text)
    text = re.sub(r"(?<![A-Za-z0-9.])v([0-9]+(?:\.[0-9]+)+)|(?<![0-9.])([0-9]+(?:\.[0-9]+){2,})(?![0-9.])",
                  lambda m: ("版本" if m[1] else "") + "点".join(_number(n) for n in (m[1] or m[2]).split(".")), text, flags=re.I)
    text = re.sub(r"(?<![A-Za-z0-9.])([0-9]+)/([0-9]+)(?![0-9./])",
                  lambda m: _integer(m[2]) + "分之" + _integer(m[1]), text)
    text = re.sub(rf"(?<![A-Za-z0-9.])({_NUMBER})\s*({_UNIT_PATTERN})(?![A-Za-z0-9])",
                  lambda m: _number(m[1]) + _UNITS[m[2].lower()], text, flags=re.I)
    text = re.sub(r"\b(PS|RTX|GTX|RX|USB|DDR|HDMI|Wi-Fi|Win)[ \t-]*([0-9]+(?:\.[0-9]+)*)(?![0-9])",
                  lambda m: m[1] + " " + "点".join(map(_spell, m[2].split("."))), text, flags=re.I | re.ASCII)
    text = re.sub(r"(?<![A-Za-z0-9])([0-9]{3,4})([pi])(?![A-Za-z0-9])",
                  lambda m: _spell(m[1]) + " " + m[2].upper(), text, flags=re.I)
    text = re.sub(r"(?<![第A-Za-z0-9.+-])(第\s*)?2(?=\s*(?:个|台|款|部|块|张|辆|次|天|周|个月|年|小时))",
                  lambda m: m[1] + "二" if m[1] else "两", text)
    return re.sub(r"(?<![0-9.+-])([+-]?)(" + _NUMBER + r")(?![0-9]|\.[0-9])",
                  lambda m: _SIGN[m[1]] + _number(m[2]), text)


def normalize_speech_text(text: str, language: str) -> str:
    if language.lower().split("-")[0].split("_")[0] != "zh":
        return text
    result, start = [], 0
    for match in _PROTECTED.finditer(text):
        result.extend((_normalize(text[start:match.start()]), match[0]))
        start = match.end()
    return "".join(result) + _normalize(text[start:])
