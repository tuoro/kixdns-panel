#!/usr/bin/env python3
"""确认一个 geosite.dat 能解析，并且带着要求的分类。

geosite.dat 是 v2ray 的 GeoSiteList protobuf：顶层是重复的字段 1（GeoSite），每个 GeoSite 的
字段 1 是分类名。这里只读分类名，不展开域名，所以不用依赖 protobuf 库。

Confirms a geosite.dat parses and carries the required categories. geosite.dat is v2ray's
GeoSiteList protobuf: repeated field 1 (GeoSite) at the top level, and each GeoSite's field 1
is its category name. Only the names are read, so no protobuf library is needed.

用法 / Usage: verify-geosite.py <geosite.dat> <分类> [<分类> ...]
"""

from __future__ import annotations

import sys


def read_varint(buffer: bytes, offset: int) -> tuple[int, int]:
    value = 0
    shift = 0
    while True:
        if offset >= len(buffer):
            raise ValueError("varint 在文件结尾处断开")
        byte = buffer[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if byte < 0x80:
            return value, offset
        shift += 7
        if shift > 63:
            raise ValueError("varint 过长")


def skip_field(buffer: bytes, offset: int, wire_type: int) -> int:
    if wire_type == 0:
        return read_varint(buffer, offset)[1]
    if wire_type == 1:
        return offset + 8
    if wire_type == 2:
        length, offset = read_varint(buffer, offset)
        return offset + length
    if wire_type == 5:
        return offset + 4
    raise ValueError(f"不认识的 protobuf 字段类型 {wire_type}")


def category_name(entry: bytes) -> str | None:
    offset = 0
    while offset < len(entry):
        key, offset = read_varint(entry, offset)
        field, wire_type = key >> 3, key & 7
        if field == 1 and wire_type == 2:
            length, offset = read_varint(entry, offset)
            if offset + length > len(entry):
                raise ValueError("分类名超出了条目长度")
            return entry[offset : offset + length].decode("utf-8")
        offset = skip_field(entry, offset, wire_type)
    return None


def categories(data: bytes) -> list[str]:
    names = []
    offset = 0
    while offset < len(data):
        key, offset = read_varint(data, offset)
        field, wire_type = key >> 3, key & 7
        if wire_type != 2:
            raise ValueError(f"顶层字段 {field} 不是长度前缀类型")
        length, offset = read_varint(data, offset)
        if offset + length > len(data):
            raise ValueError("条目超出了文件长度")
        if field == 1:
            name = category_name(data[offset : offset + length])
            if name:
                names.append(name)
        offset += length
    return names


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(f"用法：{argv[0]} <geosite.dat> <分类> [<分类> ...]", file=sys.stderr)
        return 2
    with open(argv[1], "rb") as handle:
        data = handle.read()
    try:
        found = {name.lower() for name in categories(data)}
    except (ValueError, UnicodeDecodeError) as error:
        print(f"geosite.dat 解析失败：{error}", file=sys.stderr)
        return 1
    missing = [name for name in argv[2:] if name.lower() not in found]
    if missing:
        print(f"geosite.dat 缺少分类：{'、'.join(missing)}", file=sys.stderr)
        return 1
    print(f"geosite.dat 共 {len(found)} 个分类，包含 {'、'.join(argv[2:])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
