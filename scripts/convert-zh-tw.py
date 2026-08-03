#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""将简体中文语言包批量转换为繁体中文（台湾用语，s2twp）。"""
import json
import os
from opencc import OpenCC

SRC = 'src/i18n/locales/zh'
DST = 'src/i18n/locales/zh-TW'
FILES = ['common.json', 'nav.json', 'settings.json', 'junkClean.json', 'modules.json', 'ui.json']

cc = OpenCC('s2twp')


def convert_value(v):
    """递归转换 JSON 中的字符串值，键名保持不变。"""
    if isinstance(v, str):
        return cc.convert(v)
    if isinstance(v, list):
        return [convert_value(i) for i in v]
    if isinstance(v, dict):
        return {k: convert_value(val) for k, val in v.items()}
    return v


os.makedirs(DST, exist_ok=True)
for name in FILES:
    with open(os.path.join(SRC, name), encoding='utf-8') as f:
        data = json.load(f)
    converted = convert_value(data)
    with open(os.path.join(DST, name), 'w', encoding='utf-8') as f:
        json.dump(converted, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(f'{name}: done')
