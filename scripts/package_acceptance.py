#!/usr/bin/env python3
"""在真实安装包上验证面板、systemd 与 KixDNS Enhanced 的完整链路。"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, TypeVar

from dns_smoke import (
    DOMAIN,
    INITIAL_IP,
    RELOADED_IP,
    SmokeFailure,
    query_a,
    render_config,
)


USERNAME = "acceptance-admin"
PASSWORD = "KixDNS-Acceptance-2026"
T = TypeVar("T")


class AcceptanceFailure(RuntimeError):
    """安装包没有满足黑盒验收契约。"""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AcceptanceFailure(message)


def wait_for(operation: Callable[[], T], predicate: Callable[[T], bool], label: str) -> T:
    deadline = time.monotonic() + 30
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            value = operation()
            if predicate(value):
                return value
        except (AcceptanceFailure, OSError, SmokeFailure, urllib.error.URLError) as error:
            last_error = error
        time.sleep(0.25)
    detail = f"：{last_error}" if last_error else ""
    raise AcceptanceFailure(f"等待{label}超时{detail}")


def reserve_dns_port() -> int:
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
    raise AcceptanceFailure("无法分配安装验收 DNS 端口")


def prepare_config(path: Path) -> int:
    port = reserve_dns_port()
    content = json.loads(render_config(port, INITIAL_IP))
    content["settings"]["statistics_enabled"] = True
    content["settings"]["statistics_anonymize_client_ip"] = False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    path.chmod(0o644)
    return port


class PanelClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookies)
        )
        self.csrf_token: str | None = None

    def request(
        self,
        path: str,
        *,
        method: str = "GET",
        payload: object | None = None,
        csrf: bool = False,
        timeout: float = 5,
    ) -> dict[str, Any]:
        data = None
        headers = {"Accept": "application/json"}
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode()
            headers["Content-Type"] = "application/json"
        if csrf:
            require(self.csrf_token is not None, "写操作缺少 CSRF Token")
            headers["X-CSRF-Token"] = self.csrf_token or ""
        request = urllib.request.Request(
            f"{self.base_url}{path}", data=data, headers=headers, method=method
        )
        try:
            with self.opener.open(request, timeout=timeout) as response:
                require(response.status == 200, f"{path} 返回 HTTP {response.status}")
                value = json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise AcceptanceFailure(f"{path} 返回 HTTP {error.code}：{detail}") from error
        require(isinstance(value, dict), f"{path} 没有返回 JSON 对象")
        return value

    def authenticate(self, mode: str) -> None:
        status = self.request("/api/v1/setup")
        setup_required = status.get("required") is True
        if mode == "setup-stopped":
            require(setup_required, "首次安装没有进入初始化状态")
            path = "/api/v1/setup"
        else:
            require(not setup_required, "覆盖安装后管理员数据没有保留")
            path = "/api/v1/auth/login"
        response = self.request(
            path,
            method="POST",
            payload={"username": USERNAME, "password": PASSWORD},
        )
        token = response.get("csrf_token")
        require(isinstance(token, str) and len(token) >= 32, "认证响应缺少 CSRF Token")
        self.csrf_token = token


def wait_for_panel(client: PanelClient) -> None:
    health = wait_for(
        lambda: client.request("/api/v1/health"),
        lambda value: value.get("status") == "ok",
        "面板健康端点",
    )
    require(isinstance(health.get("version"), str), "面板健康端点缺少版本")


def verify_runtime(client: PanelClient, dns_port: int, expected_ip: str) -> None:
    wait_for(
        lambda: query_a(dns_port, expected_ip) or True,
        bool,
        "KixDNS DNS 监听就绪",
    )
    overview = wait_for(
        lambda: client.request("/api/v1/overview"),
        lambda value: value.get("health", {}).get("status") == "ok",
        "面板到增强控制协议",
    )
    require(overview["health"].get("protocol_version") == 1, "控制协议版本不是 v1")
    require(overview["active_config"].get("last_reload", {}).get("success") is True,
            "当前配置没有成功加载")
    require(isinstance(overview.get("metrics", {}).get("requests_total"), int),
            "概览缺少内部请求指标")


def exercise_panel(client: PanelClient, dns_port: int) -> None:
    document = client.request("/api/v1/config")
    require(document.get("runtime", {}).get("status") == "active", "配置运行状态不是 active")
    expected_sha256 = document.get("sha256")
    require(isinstance(expected_sha256, str), "配置响应缺少 SHA-256")

    replacement = json.loads(render_config(dns_port, RELOADED_IP))
    replacement["settings"]["statistics_enabled"] = True
    replacement["settings"]["statistics_anonymize_client_ip"] = False
    saved = client.request(
        "/api/v1/config",
        method="PUT",
        csrf=True,
        payload={
            "content": replacement,
            "expected_sha256": expected_sha256,
            "message": "安装包黑盒验收",
        },
    )
    require(saved.get("active_config", {}).get("sha256") == saved.get("sha256"),
            "配置保存后热加载回执不一致")
    query_a(dns_port, RELOADED_IP)

    diagnostic = client.request(
        "/api/v1/diagnostics/dns",
        method="POST",
        csrf=True,
        payload={"domain": DOMAIN, "record_type": "A"},
    )
    response_code = "".join(
        character for character in str(diagnostic.get("response_code", "")).lower()
        if character.isalnum()
    )
    require(response_code == "noerror", f"面板 DNS 诊断失败：{diagnostic}")
    require(any(RELOADED_IP in answer for answer in diagnostic.get("answers", [])),
            "面板 DNS 诊断没有返回预期地址")

    stats = client.request("/api/v1/stats/top?window=3600&limit=10")
    require(stats.get("enabled") is True and stats.get("requests_observed", 0) >= 1,
            "查询排行没有记录真实 DNS 请求")

    cache = client.request("/api/v1/cache/flush", method="POST", csrf=True)
    require(cache.get("protocol_version") == 1, "缓存清理没有走增强控制协议")

    restarted = client.request("/api/v1/service/restart", method="POST", csrf=True)
    require(restarted.get("active_state") == "active", "面板无法通过受限 helper 重启 KixDNS")
    verify_runtime(client, dns_port, RELOADED_IP)

    logs = client.request("/api/v1/logs?limit=20")
    # systemd 自己的「Started kixdns.service」也算一条，只看非空证明不了读到了
    # KixDNS 的输出；要有 SYSLOG_IDENTIFIER 是 kixdns 的行才算。
    # systemd's own "Started kixdns.service" line counts as an entry, so a
    # non-empty list proves nothing about KixDNS's output; require a line whose
    # SYSLOG_IDENTIFIER is kixdns.
    require(any(entry.get("source") == "kixdns" for entry in logs.get("entries", [])),
            "面板没有读取到 KixDNS 进程自己写入 journal 的日志")
    require(logs.get("notice") is None, f"日志页对 KixDNS unit 给出了提示：{logs.get('notice')}")
    audit = client.request("/api/v1/audit?limit=50")
    actions = {event.get("action") for event in audit.get("events", [])}
    require(
        {"config.save", "diagnostic.dns", "cache.flush", "service.restart"} <= actions,
        "真实操作没有完整写入审计日志",
    )


def require_bundled_kernel(kernel: dict[str, Any]) -> None:
    """完整包自带的内核已经作为当前内核记进本机库存：fork 发布的日期版本，带着完整的来源身份。"""
    active = kernel.get("active")
    require(isinstance(active, dict), "完整包 KixDNS 没有导入本地版本库存")
    require(active.get("active") is True, "完整包 KixDNS 没有记为当前内核")
    require(active.get("source") == "fork", "完整包 KixDNS 不是 fork 发布版")
    require(isinstance(active.get("source_id"), int), "完整包没有记录内核包编号")
    require(
        re.fullmatch(r"\d{4}\.\d{2}\.\d{2}(\.\d+)?", str(active.get("release_tag"))) is not None,
        "完整包没有记录内核的日期版本",
    )
    require(active.get("patchset") is None, "fork 发布版不该带补丁集")
    require(active.get("control_protocol") == 1, "完整包控制协议身份缺失")


def require_builtin_geosite(client: PanelClient) -> str:
    """全新安装的首次启动导入了安装包里的 GeoSite：来源是它的下载链接，文件就是包里那份；KixDNS
    还没启动，写进配置的是一个待应用版本。返回导入后的文件路径。"""
    builtin = client.request("/api/v1/config/geo-data/builtin")
    require(isinstance(builtin, dict), "完整包没有带内置 GeoSite")
    require(
        str(builtin.get("url", "")).startswith("https://github.com/Loyalsoldier/v2ray-rules-dat/"),
        "内置 GeoSite 的来源不是 Loyalsoldier",
    )
    # 标记是导入的最后一步才删的：它不在了，文件和配置都已经写好
    marker = Path("/var/lib/kixdns-panel/geo/.import-builtin-geosite")
    wait_for(marker.exists, lambda exists: not exists, "首次启动导入内置 GeoSite")
    manifest = client.request("/api/v1/config/geo-data")
    require(len(manifest.get("geosite", [])) == 1, "首次启动没有导入内置 GeoSite")
    imported = manifest["geosite"][0]
    require(imported.get("sha256") == builtin.get("sha256"), "导入的 GeoSite 不是安装包里那份")
    require(imported.get("url") == builtin.get("url"), "导入的 GeoSite 没有记下下载链接")
    document = client.request("/api/v1/config")
    require(document.get("pending") is not None, "KixDNS 没启动时导入的 GeoSite 没有存成待应用版本")
    require(
        document.get("content", {}).get("settings", {}).get("geosite_data_paths") == [imported["path"]],
        "待应用的配置没有带上导入的 GeoSite",
    )
    return imported["path"]


def require_builtin_geosite_applied(client: PanelClient, path: str) -> None:
    """KixDNS 启动后，面板在后台应用待应用版本（启动时一次，之后每 5 秒）：等它不再待应用，
    必须已经生效，运行的配置带着导入的 GeoSite。"""
    document = wait_for(
        lambda: client.request("/api/v1/config"),
        lambda value: value.get("runtime", {}).get("status") != "pending",
        "KixDNS 启动后应用导入的 GeoSite",
    )
    runtime = document.get("runtime", {})
    require(
        runtime.get("status") == "active",
        f"导入的 GeoSite 没有生效：{runtime.get('status')}，{runtime.get('pending_error')}",
    )
    require(
        document.get("content", {}).get("settings", {}).get("geosite_data_paths") == [path],
        "运行的配置没有带上导入的 GeoSite",
    )


def verify_installation(base_url: str, dns_port: int, mode: str) -> None:
    client = PanelClient(base_url)
    wait_for_panel(client)
    client.authenticate(mode)
    if mode == "setup-stopped":
        service = client.request("/api/v1/service")
        require(service.get("active_state") == "inactive", "首次安装后 KixDNS 没有保持停止")
        # 内核卡片要等面板向 GitHub 查最新构建，响应慢时 5 秒不够；只放宽这一个调用，其余请求仍快速失败。
        # The kernel card waits on the panel's GitHub query for the newest build, which can exceed 5 s;
        # only this call is relaxed.
        require_bundled_kernel(client.request("/api/v1/kixdns/kernel", timeout=30))
        geosite_path = require_builtin_geosite(client)
        started = client.request("/api/v1/service/start", method="POST", csrf=True)
        require(started.get("active_state") == "active", "面板无法启动首次安装的 KixDNS")
        verify_runtime(client, dns_port, INITIAL_IP)
        require_builtin_geosite_applied(client, geosite_path)
        exercise_panel(client, dns_port)
        live = client.request("/api/v1/overview")
        require(live.get("live") is True, "运行概览没有标记为实时数据")
        stopped = client.request("/api/v1/service/stop", method="POST", csrf=True)
        require(stopped.get("active_state") == "inactive", "面板无法停止 KixDNS")
        require(
            subprocess.run(
                ["systemctl", "is-enabled", "--quiet", "kixdns.service"], check=False
            ).returncode != 0,
            "面板停止 KixDNS 后没有禁用开机启动",
        )
        snapshot = wait_for(
            lambda: client.request("/api/v1/overview"),
            lambda value: value.get("live") is False and value.get("service_active") is False,
            "KixDNS 停止后的概览快照",
        )
        require(snapshot.get("metrics") == live.get("metrics"), "停止后概览没有保留最后运行数据")
        restarted = client.request("/api/v1/service/start", method="POST", csrf=True)
        require(restarted.get("active_state") == "active", "快照验收后无法恢复 KixDNS")
        require(
            subprocess.run(
                ["systemctl", "is-enabled", "--quiet", "kixdns.service"], check=False
            ).returncode == 0,
            "面板启动 KixDNS 后没有启用开机启动",
        )
        return
    expected_ip = INITIAL_IP if mode == "setup" else RELOADED_IP
    verify_runtime(client, dns_port, expected_ip)
    if mode == "setup":
        exercise_panel(client, dns_port)
    else:
        service = client.request("/api/v1/service")
        require(service.get("active_state") == "active", "覆盖安装后 KixDNS 没有运行")
        versions = client.request("/api/v1/config/versions")
        require(len(versions.get("versions", [])) >= 2, "覆盖安装后配置历史没有保留")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    prepare = subparsers.add_parser("prepare", help="生成隔离的 DNS 测试配置")
    prepare.add_argument("--config", type=Path, required=True)
    verify = subparsers.add_parser("verify", help="验证已安装的真实服务")
    verify.add_argument("--base-url", default="http://127.0.0.1:5738")
    verify.add_argument("--dns-port", type=int, required=True)
    verify.add_argument("--mode", choices=("setup-stopped", "login"), required=True)
    dns = subparsers.add_parser("dns", help="等待 KixDNS 按验收配置应答，不经过面板")
    dns.add_argument("--dns-port", type=int, required=True)
    arguments = parser.parse_args()

    if sys.platform != "linux":
        raise AcceptanceFailure("安装包黑盒验收仅支持 Linux")
    if arguments.command == "prepare":
        print(prepare_config(arguments.config))
    elif arguments.command == "dns":
        # 迁移验收里原来的 KixDNS 不归面板管，只能直接查 DNS 证明它在跑。
        # In the migration check the original KixDNS is not the panel's, so only a direct query proves it runs.
        wait_for(lambda: query_a(arguments.dns_port, INITIAL_IP) or True, bool, "KixDNS DNS 应答")
        print(f"KixDNS 在端口 {arguments.dns_port} 正常应答")
    else:
        verify_installation(arguments.base_url, arguments.dns_port, arguments.mode)
        print(f"安装包黑盒验收通过：{arguments.mode}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AcceptanceFailure as error:
        print(f"安装包黑盒验收失败：{error}", file=sys.stderr)
        raise SystemExit(1) from error
