#!/usr/bin/env python3
"""Fail when tracked files reveal private network topology.

Detected: private/tailnet/public IPv4 addresses, IPv6 ULA/link-local, *.ts.net and *.local
hostnames, dyndns/tunnel names, MAC addresses, e-mail addresses, and any name listed in an
untracked local denylist. Real machine names never live in this file: put one regular expression
per line in the denylist (default ~/.config/private-topology/denylist.txt, or the file named by
PRIVATE_TOPOLOGY_DENYLIST). Without a denylist only the generic patterns run.

Escape hatches: a `topology-ok` marker on the line, or a glob per line in `.private-topology-allow`
(tracked, repo root) for paths that legitimately hold examples. RFC 5737 documentation addresses
(192.0.2.x, 198.51.100.x, 203.0.113.x), loopback and well-known public resolvers are always fine.

Usage: scripts/check_private_topology.py              scan tracked files
       scripts/check_private_topology.py --self-test  prove every pattern fires and the allowances hold

Exit codes: 0 clean, 1 topology found, 2 denylist required but missing (PRIVATE_TOPOLOGY_REQUIRE_DENYLIST=1).
"""

from __future__ import annotations

import io
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

VERSION = "2"

OCTET = r"(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])"
IPV4 = rf"(?<![0-9A-Za-z_.-]){OCTET}(\.{OCTET}){{3}}(?![0-9A-Za-z_-]|\.[0-9])"

RULES = (
    (
        "private-ipv4",
        rf"(?<![0-9A-Za-z_.-])(10(\.{OCTET}){{3}}|192\.168(\.{OCTET}){{2}}|172\.(1[6-9]|2[0-9]|3[01])(\.{OCTET}){{2}})(?![0-9A-Za-z_-]|\.[0-9])",
    ),
    (
        "tailnet-ipv4",
        rf"(?<![0-9A-Za-z_.-])100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])(\.{OCTET}){{2}}(?![0-9A-Za-z_-]|\.[0-9])",
    ),
    ("public-ipv4", IPV4),
    (
        "ipv6-private",
        # fe80::/10 needs a host part (a bare `fe80::` prefix is protocol vocabulary); fc00::/7 prefixes also count when
        # bare (`fd12::/64` is the owner's network). Compressed (`::`) and full forms.
        r"(?i)(?<![0-9a-f:])(?:"
        r"fe80(?::[0-9a-f]{1,4}){0,6}::[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}|fe80(?::[0-9a-f]{1,4}){7}"
        r"|f[cd][0-9a-f]{2}(?::[0-9a-f]{1,4}){0,6}::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|f[cd][0-9a-f]{2}(?::[0-9a-f]{1,4}){7}"
        r")(?![0-9a-f])",
    ),
    # The lookbehinds anchor each rule at the start of a token, so a long run of word characters (a base64 blob)
    # is tried once, not once per position.
    ("tailnet-hostname", r"(?i)(?<![a-z0-9-])[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net\b"),
    ("mdns-hostname", r"(?i)(?<![a-z0-9_-])[a-z0-9][a-z0-9-]*\.local\b(?!\.[a-z0-9])"),
    (
        "dyndns-hostname",
        r"(?i)(?<![a-z0-9_-])[a-z0-9-]+\.(duckdns\.org|dataplicity\.io|ngrok(-free)?\.(app|io|dev)|trycloudflare\.com|dynv6\.net|ddns\.net|no-ip\.(org|com|biz)|myfritz\.net)\b",
    ),
    ("mac-address", r"(?i)(?<![0-9a-f:-])([0-9a-f]{2}[:-]){5}[0-9a-f]{2}(?![0-9a-f:-])"),
    ("email", r"(?i)(?<![a-z0-9._%+-])[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}"),
)

# Values that are not topology even when a rule matches them.
BENIGN = re.compile(
    r"^(127\.[0-9.]+|0\.0\.0\.0|255\.255\.255\.255|1\.1\.1\.1|1\.0\.0\.1|8\.8\.8\.8|8\.8\.4\.4|9\.9\.9\.9|77\.88\.8\.8|77\.88\.8\.1"
    r"|192\.0\.2\.[0-9]+|198\.51\.100\.[0-9]+|203\.0\.113\.[0-9]+)$"
    r"|(^|[@.])(example\.(com|org|net)|users\.noreply\.github\.com|noreply\..*|localhost)$"
    r"|^noreply@|^(no-reply|git)@github\.com$"
    r"|^(aa:bb:cc:dd:ee:ff|00:00:00:00:00:00|ff:ff:ff:ff:ff:ff|11:22:33:44:55:66|01:23:45:67:89:ab|de:ad:be:ef:[0-9a-f:]+)$"
    r"|^((\.?env|threading|local|mocha|express)\.local)$"
    r"|^test@o0\.ingest\.sentry\.io$"
    r"|^[a-z0-9._%+-]*@[a-z0-9._-]+\.(service|timer|socket|target|path|mount|slice|scope)$",
    re.IGNORECASE,
)
NONPUBLIC = re.compile(r"^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)")

COMPILED_RULES = tuple((name, re.compile(pattern)) for name, pattern in RULES)

# Lockfiles list public package authors' addresses, not the owner's topology.
ALWAYS_EXCLUDED = (
    ".private-topology-allow",
    "scripts/check_private_topology.py",
    "scripts/test_check_private_topology.py",
)
LOCKFILE_GLOBS = (
    "**/pnpm-lock.yaml",
    "**/package-lock.json",
    "**/yarn.lock",
    "**/bun.lock",
    "**/Cargo.lock",
    "**/poetry.lock",
    "**/uv.lock",
    "**/go.sum",
)
MARKER = "topology-ok"


def _allow_pathspecs(root: Path) -> list[str]:
    specs = [f":(exclude){path}" for path in ALWAYS_EXCLUDED]
    specs += [f":(exclude,glob){glob}" for glob in LOCKFILE_GLOBS]
    allow_file = root / ".private-topology-allow"
    if allow_file.is_file():
        for raw in allow_file.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.rstrip("\r")
            if line and not line.startswith("#"):
                specs.append(f":(exclude,glob){line}")
    return specs


def _tracked_files(root: Path) -> list[str]:
    result = subprocess.run(
        ["git", "ls-files", "-z", "--", ".", *_allow_pathspecs(root)],
        cwd=root,
        check=True,
        capture_output=True,
    )
    return [p.decode("utf-8", errors="replace") for p in result.stdout.split(b"\0") if p]


def _read_text_lines(path: Path) -> list[str] | None:
    """Lines of a text file; None for unreadable, binary or non-regular files (like `git grep -I`).

    A symlink is scanned as its stored target string: the target file may be absent (CI) or outside the repository.
    """
    try:
        if path.is_symlink():
            return [os.readlink(path)]
        if not path.is_file():
            return None
        data = path.read_bytes()
    except OSError:
        return None
    if b"\0" in data[:8000]:
        return None
    return data.decode("utf-8", errors="replace").split("\n")


def _load_denylist(path: Path) -> re.Pattern[str] | None:
    patterns = [
        line
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    if not patterns:
        return None
    alt = "|".join(patterns)
    return re.compile(rf"(?<![A-Za-z0-9-])({alt})(?![A-Za-z0-9-])", re.IGNORECASE)


def _local_denylist() -> re.Pattern[str] | None:
    """The compiled denylist, None when absent; raises FileNotFoundError when it is required but missing."""
    default_deny = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "private-topology" / "denylist.txt"
    deny = Path(os.environ.get("PRIVATE_TOPOLOGY_DENYLIST") or default_deny)
    if deny.is_file():
        return _load_denylist(deny)
    if os.environ.get("PRIVATE_TOPOLOGY_REQUIRE_DENYLIST") == "1":
        raise FileNotFoundError(str(deny))
    return None


def scan(root: Path, out=sys.stdout, err=sys.stderr) -> int:
    """Print findings, return 0 clean / 1 found / 2 required denylist missing."""
    try:
        pattern = _local_denylist()
    except FileNotFoundError as missing:
        print(f"check-private-topology: denylist {missing} missing", file=err)
        return 2
    if pattern is None and os.environ.get("PRIVATE_TOPOLOGY_REQUIRE_DENYLIST") != "1":
        print("check-private-topology: no local denylist; generic patterns only", file=err)

    def shown(text: str) -> str:
        # A CI log or a terminal scrollback must not repeat a real name: hide whatever the denylist matches.
        return "<denylisted>" if pattern is not None and pattern.search(text) else text

    failed = False
    files = _tracked_files(root)
    contents = {name: lines for name in files if (lines := _read_text_lines(root / name)) is not None}

    for name, lines in contents.items():
        for number, text in enumerate(lines, start=1):
            if not text or MARKER in text:
                continue
            for rule, regex in COMPILED_RULES:
                for match in regex.finditer(text):
                    value = match.group(0)
                    if BENIGN.search(value):
                        continue
                    # public-ipv4 is a catch-all; private and tailnet addresses are reported by their own rules.
                    if rule == "public-ipv4" and NONPUBLIC.search(value):
                        continue
                    print(f"{shown(name)}:{number}: {rule} {shown(value)}", file=out)
                    failed = True

    if pattern is not None:
        for name, lines in contents.items():
            for number, text in enumerate(lines, start=1):
                if MARKER not in text and pattern.search(text):
                    print(f"{shown(name)}:{number}: denylisted-name (value hidden)", file=err)
                    failed = True
        for name in files:
            if pattern.search(name):
                print(f"{shown(name)}: denylisted-name in path (value hidden)", file=err)
                failed = True
    return 1 if failed else 0


def self_test() -> int:
    dot = "."
    bad = [
        f"a 192{dot}168{dot}1{dot}20", f"b 10{dot}0{dot}0{dot}5", f"c 172{dot}16{dot}4{dot}9", f"d 100{dot}101{dot}2{dot}3",
        f"e 93{dot}184{dot}216{dot}34", "f fd12:3456:789a::1", f"g box.tailnet-x{dot}ts{dot}net", f"h printer{dot}local",
        f"l myhome{dot}duckdns{dot}org", "i 3c:52:a1:09:7f:e4", f"j who@example-corp{dot}io", "k seedhost-alpha",
        "n AllowedIPs = fd12::/64", "o gw fe80::1%eth0",
    ]
    good = [
        f"ok 192{dot}0{dot}2{dot}7", f"ok 127{dot}0{dot}0{dot}1", f"v 1{dot}2{dot}3{dot}4{dot}5",
        f"m 192{dot}168{dot}1{dot}1 # topology-ok", f"x noreply@example{dot}com", f"u backup@nightly{dot}service",
        f"w user@host{dot}docker{dot}service",
    ]
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        subprocess.run(["git", "init", "-q", "."], cwd=root, check=True)
        (root / "bad.txt").write_text("\n".join(bad) + "\n", encoding="utf-8")
        (root / "good.txt").write_text("\n".join(good) + "\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        deny = root / "deny"
        deny.write_text("seedhost-alpha\n", encoding="utf-8")
        previous = os.environ.get("PRIVATE_TOPOLOGY_DENYLIST")
        os.environ["PRIVATE_TOPOLOGY_DENYLIST"] = str(deny)
        try:
            out, err = io.StringIO(), io.StringIO()
            scan(root, out, err)
        finally:
            if previous is None:
                del os.environ["PRIVATE_TOPOLOGY_DENYLIST"]
            else:
                os.environ["PRIVATE_TOPOLOGY_DENYLIST"] = previous
    combined = out.getvalue() + err.getvalue()
    kinds = (
        "private-ipv4", "tailnet-ipv4", "public-ipv4", "ipv6-private", "tailnet-hostname",
        "dyndns-hostname", "mdns-hostname", "mac-address", "email", "denylisted-name",
    )
    for kind in kinds:
        if not re.search(rf"bad\.txt:[0-9]+: {kind}", combined):
            print(f"self-test: {kind} did not fire", file=sys.stderr)
            return 1
    if "good.txt" in combined:
        print("self-test: benign line flagged", file=sys.stderr)
        return 1
    if "seedhost-alpha" in combined:
        print("self-test: denylisted value leaked into output", file=sys.stderr)
        return 1
    print("check-private-topology self-test OK")
    return 0


def main(argv: list[str]) -> int:
    if argv[1:] == ["--version"]:
        print(VERSION)
        return 0
    if argv[1:] == ["--self-test"]:
        return self_test()
    root = Path(subprocess.run(["git", "rev-parse", "--show-toplevel"], check=True, capture_output=True, text=True).stdout.strip())
    code = scan(root)
    if code == 0:
        print("check-private-topology: clean")
    elif code == 1:
        print(
            "check-private-topology: private topology found. Use a placeholder (<server-lan-ip>, <tailnet-host>), "
            "read the value from config/env, or add a topology-ok marker with a reason.",
            file=sys.stderr,
        )
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
