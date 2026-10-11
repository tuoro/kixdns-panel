#!/usr/bin/env python3
"""验证增强 KixDNS 的 DNS、指标和结构化热加载契约。"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import secrets
import socket
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, TextIO, TypeVar


DOMAIN = "smoke.kixdns.test"
INITIAL_IP = "203.0.113.10"
RELOADED_IP = "203.0.113.11"
CANDIDATE_IP = "203.0.113.12"
T = TypeVar("T")


class SmokeFailure(RuntimeError):
    """运行契约不满足。"""


def reserve_dns_port() -> int:
    """选择一个可同时绑定 TCP 和 UDP 的本机端口。"""
    for _ in range(20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as tcp:
            tcp.bind(("127.0.0.1", 0))
            port = tcp.getsockname()[1]
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
                    udp.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SmokeFailure("无法分配 DNS 冒烟测试端口")


def render_config(port: int, address: str) -> bytes:
    config = {
        "version": "1.0",
        "settings": {
            "bind_udp": f"127.0.0.1:{port}",
            "bind_tcp": f"127.0.0.1:{port}",
            "default_upstream": "127.0.0.1:9",
            "upstream_timeout_ms": 500,
        },
        "pipelines": [
            {
                "id": "default",
                "rules": [
                    {
                        "name": "static-answer",
                        "matchers": [{"type": "domain_suffix", "value": DOMAIN}],
                        "actions": [{"type": "static_ip_response", "ip": address}],
                    }
                ],
            }
        ],
    }
    return (json.dumps(config, ensure_ascii=False, indent=2) + "\n").encode()


def sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def write_atomic(path: Path, content: bytes) -> None:
    candidate = path.with_name(f".{path.name}.new")
    with candidate.open("wb") as output:
        output.write(content)
        output.flush()
        os.fsync(output.fileno())
    os.replace(candidate, path)


def wait_for(operation: Callable[[], T], predicate: Callable[[T], bool], label: str) -> T:
    deadline = time.monotonic() + 12
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            value = operation()
            if predicate(value):
                return value
        except (OSError, ValueError, SmokeFailure) as error:
            last_error = error
        time.sleep(0.1)
    detail = f"：{last_error}" if last_error else ""
    raise SmokeFailure(f"等待{label}超时{detail}")


def unix_http(socket_path: Path, path: str, body: bytes | None = None, timeout: float = 2) -> bytes:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(timeout)
        client.connect(str(socket_path))
        if body is None:
            request = f"GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n".encode()
        else:
            request = (
                f"POST {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n"
                f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n"
            ).encode() + body
        client.sendall(request)
        response = bytearray()
        while b"\r\n\r\n" not in response:
            chunk = client.recv(4096)
            if not chunk:
                break
            response.extend(chunk)
        if b"\r\n\r\n" not in response:
            raise SmokeFailure(f"{path} 返回了不完整的 HTTP 响应")
        raw_headers, body = bytes(response).split(b"\r\n\r\n", 1)
        lines = raw_headers.decode("ascii").split("\r\n")
        fields = {
            key.lower(): value.strip()
            for key, value in (line.split(":", 1) for line in lines[1:] if ":" in line)
        }
        length = int(fields.get("content-length", len(body)))
        while len(body) < length:
            chunk = client.recv(min(4096, length - len(body)))
            if not chunk:
                break
            body += chunk
        if " 200 " not in lines[0] or len(body) != length:
            raise SmokeFailure(f"{path} HTTP 响应无效：{lines[0]}")
        return body


def get_json(socket_path: Path, path: str) -> dict[str, Any]:
    value = json.loads(unix_http(socket_path, path))
    if not isinstance(value, dict):
        raise SmokeFailure(f"{path} 没有返回 JSON 对象")
    return value


def post_json(socket_path: Path, path: str, value: dict[str, Any], timeout: float = 2) -> dict[str, Any]:
    result = json.loads(unix_http(socket_path, path, json.dumps(value).encode(), timeout))
    if not isinstance(result, dict):
        raise SmokeFailure(f"{path} 没有返回 JSON 对象")
    return result


def child_pids(parent: int) -> list[int]:
    """内核进程的子进程：草稿试跑结束后不应留下任何一个 / The kernel's children; a finished draft trial leaves none."""
    children = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
        except OSError:
            continue
        if int(fields[1]) == parent:
            children.append(int(entry.name))
    return children


def check_diagnostics(socket_path: Path, port: int, capabilities: list[str], live_ip: str, pid: int) -> None:
    """诊断能力：指定客户端 IP 的轨迹、用候选配置试跑；按健康端点声明的能力决定测哪些。
    Diagnostics: a trace with an assigned client IP and a trial on a candidate config, tested as the health endpoint declares."""
    if "diagnostics_trace_client_v1" in capabilities:
        trace = post_json(
            socket_path,
            "/v1/diagnostics/trace",
            {"domain": DOMAIN, "record_type": "A", "client_ip": "192.0.2.10"},
        )
        if trace.get("client_ip") != "192.0.2.10":
            raise SmokeFailure(f"诊断轨迹没有用指定的客户端 IP：{trace.get('client_ip')}")
        if not any(live_ip in answer for answer in trace.get("answers", [])):
            raise SmokeFailure(f"诊断轨迹的回答缺少 {live_ip}：{trace.get('answers')}")
        if "192.0.2.10" not in str(trace.get("trace", [{}])[0].get("detail", "")):
            raise SmokeFailure("诊断轨迹第一步没有写出指定的客户端 IP")
    if "diagnostics_trace_candidate_v1" in capabilities:
        candidate = json.loads(render_config(port, CANDIDATE_IP))
        trial = post_json(
            socket_path,
            "/v1/diagnostics/trace-candidate",
            {"domain": DOMAIN, "record_type": "A", "client_ip": "192.0.2.11", "config": candidate},
            timeout=15,
        )
        if trial.get("candidate") is not True or trial.get("client_ip") != "192.0.2.11":
            raise SmokeFailure(f"草稿试跑的结果不对：{trial}")
        if not any(CANDIDATE_IP in answer for answer in trial.get("answers", [])):
            raise SmokeFailure(f"草稿试跑没有用候选配置回答：{trial.get('answers')}")
        # 试跑不碰正在用的配置，子进程也已经收掉 / The trial leaves the live config alone and its child is gone
        query_a(port, live_ip)
        leftover = wait_for(lambda: child_pids(pid), lambda value: not value, "试跑子进程退出")
        if leftover:
            raise SmokeFailure(f"试跑后留下了子进程：{leftover}")


def encode_name(name: str) -> bytes:
    return b"".join(bytes((len(label),)) + label.encode("ascii") for label in name.split(".")) + b"\0"


def skip_name(packet: bytes, offset: int) -> int:
    while offset < len(packet):
        length = packet[offset]
        if length & 0xC0 == 0xC0:
            if offset + 2 > len(packet):
                break
            return offset + 2
        offset += 1
        if length == 0:
            return offset
        offset += length
    raise SmokeFailure("DNS 响应中的域名编码无效")


def parse_a_answers(packet: bytes, transaction_id: int) -> set[str]:
    if len(packet) < 12:
        raise SmokeFailure("DNS 响应过短")
    response_id, flags, questions, answers, _, _ = struct.unpack("!HHHHHH", packet[:12])
    if response_id != transaction_id or flags & 0x8000 == 0 or flags & 0x000F:
        raise SmokeFailure("DNS 响应 ID、QR 或 RCODE 无效")
    offset = 12
    for _ in range(questions):
        offset = skip_name(packet, offset) + 4
    addresses: set[str] = set()
    for _ in range(answers):
        offset = skip_name(packet, offset)
        if offset + 10 > len(packet):
            raise SmokeFailure("DNS Answer 头部不完整")
        record_type, record_class, _, length = struct.unpack("!HHIH", packet[offset : offset + 10])
        offset += 10
        data = packet[offset : offset + length]
        if len(data) != length:
            raise SmokeFailure("DNS Answer 数据不完整")
        if record_type == 1 and record_class == 1 and length == 4:
            addresses.add(str(ipaddress.ip_address(data)))
        offset += length
    return addresses


def query_a(port: int, expected: str) -> None:
    transaction_id = secrets.randbits(16)
    packet = struct.pack("!HHHHHH", transaction_id, 0x0100, 1, 0, 0, 0)
    packet += encode_name(DOMAIN) + struct.pack("!HH", 1, 1)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
        client.settimeout(2)
        client.sendto(packet, ("127.0.0.1", port))
        response, _ = client.recvfrom(65535)
    addresses = parse_a_answers(response, transaction_id)
    if expected not in addresses:
        raise SmokeFailure(f"DNS Answer 缺少 {expected}，实际为 {sorted(addresses)}")


def assert_fast_path_metric(socket_path: Path) -> None:
    metrics = unix_http(socket_path, "/v1/metrics").decode()
    prefix = (
        'kixdns_rule_matches_total{pipeline="default",rule="static-answer",phase="request"} '
    )
    values = [line.removeprefix(prefix) for line in metrics.splitlines() if line.startswith(prefix)]
    if not values or int(values[0]) < 1:
        raise SmokeFailure("编译静态快速路径没有导出规则命中计数")


def run_contract(binary: Path, directory: Path, log: TextIO) -> None:
    port = reserve_dns_port()
    config_path = directory / "pipeline.json"
    socket_path = directory / "admin.sock"
    initial = render_config(port, INITIAL_IP)
    config_path.write_bytes(initial)
    environment = {**os.environ, "RUST_LOG": "warn"}
    process = subprocess.Popen(
        [str(binary), "run", "--config", str(config_path), "--admin-socket", str(socket_path)],
        stdout=log,
        stderr=subprocess.STDOUT,
        env=environment,
    )
    try:
        health = wait_for(
            lambda: get_json(socket_path, "/v1/health"),
            lambda value: value.get("status") == "ok",
            "增强健康端点",
        )
        if health.get("protocol_version") != 1:
            raise SmokeFailure("健康端点控制协议版本不是 v1")

        active = get_json(socket_path, "/v1/config/active")
        if active.get("sha256") != sha256(initial) or not active.get("last_reload", {}).get("success"):
            raise SmokeFailure("初始结构化配置状态与磁盘配置不一致")
        query_a(port, INITIAL_IP)
        assert_fast_path_metric(socket_path)

        reloaded = render_config(port, RELOADED_IP)
        before_sequence = int(active.get("reload_sequence", 0))
        write_atomic(config_path, reloaded)
        expected_hash = sha256(reloaded)
        wait_for(
            lambda: get_json(socket_path, "/v1/config/active"),
            lambda value: (
                int(value.get("reload_sequence", 0)) > before_sequence
                and value.get("sha256") == expected_hash
                and value.get("last_reload", {}).get("success") is True
            ),
            "结构化热加载回执",
        )
        query_a(port, RELOADED_IP)
        check_diagnostics(socket_path, port, list(health.get("capabilities", [])), RELOADED_IP, process.pid)
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path, help="待验证的 KixDNS Enhanced 二进制")
    arguments = parser.parse_args()
    binary = arguments.binary.resolve()
    if sys.platform != "linux":
        raise SmokeFailure("DNS 运行契约测试仅支持 Linux")
    if not binary.is_file():
        raise SmokeFailure(f"KixDNS 二进制不存在：{binary}")

    with tempfile.TemporaryDirectory(prefix="kixdns-smoke-") as raw_directory:
        directory = Path(raw_directory)
        log_path = directory / "kixdns.log"
        try:
            with log_path.open("w+", encoding="utf-8") as log:
                run_contract(binary, directory, log)
        except Exception as error:
            detail = log_path.read_text(encoding="utf-8", errors="replace")[-8000:]
            raise SmokeFailure(f"{error}\nKixDNS 日志：\n{detail}") from error
    print("DNS、指标与结构化热加载运行契约验证通过")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SmokeFailure as error:
        print(f"运行契约验证失败：{error}", file=sys.stderr)
        raise SystemExit(1) from error
