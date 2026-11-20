"""Unit tests for check_private_topology.py (stdlib unittest, no network)."""

from __future__ import annotations

import io
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_private_topology as topo  # noqa: E402

DOT = "."


def run_scan(files: dict[str, str], denylist: str | None = None, require_denylist: bool = False, symlinks: dict[str, str] | None = None) -> tuple[int, str]:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        subprocess.run(["git", "init", "-q", "."], cwd=root, check=True)
        for name, content in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        for name, target in (symlinks or {}).items():
            os.symlink(target, root / name)
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        env = {"PRIVATE_TOPOLOGY_DENYLIST": str(root / "missing-denylist"), "PRIVATE_TOPOLOGY_REQUIRE_DENYLIST": "1" if require_denylist else "0"}
        if denylist is not None:
            (root / "deny.txt").write_text(denylist, encoding="utf-8")
            env["PRIVATE_TOPOLOGY_DENYLIST"] = str(root / "deny.txt")
        saved = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        try:
            out, err = io.StringIO(), io.StringIO()
            code = topo.scan(root, out, err)
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        return code, out.getvalue() + err.getvalue()


class BenignValues(unittest.TestCase):
    def test_systemd_unit_instance_is_not_an_email(self) -> None:
        code, _ = run_scan({"a.txt": f"systemctl status getty@tty1{DOT}service backup@nightly{DOT}timer\n"})
        self.assertEqual(code, 0)

    def test_documentation_loopback_and_resolver_addresses_pass(self) -> None:
        text = "\n".join(f"{a}" for a in (f"192{DOT}0{DOT}2{DOT}7", f"198{DOT}51{DOT}100{DOT}1", f"203{DOT}0{DOT}113{DOT}9", f"127{DOT}0{DOT}0{DOT}1", f"1{DOT}1{DOT}1{DOT}1"))
        self.assertEqual(run_scan({"a.txt": text})[0], 0)

    def test_noreply_and_example_emails_pass(self) -> None:
        self.assertEqual(run_scan({"a.txt": f"noreply@github{DOT}com user@example{DOT}com 12345+bot@users{DOT}noreply{DOT}github{DOT}com\n"})[0], 0)

    def test_version_with_five_parts_is_not_an_address(self) -> None:
        self.assertEqual(run_scan({"a.txt": f"v 1{DOT}2{DOT}3{DOT}4{DOT}5\n"})[0], 0)


class Findings(unittest.TestCase):
    def test_real_email_is_flagged(self) -> None:
        code, out = run_scan({"a.txt": f"contact who@example-corp{DOT}io\n"})
        self.assertEqual(code, 1)
        self.assertIn("a.txt:1: email", out)

    def test_lan_and_tailnet_addresses_are_flagged_once_by_their_own_rule(self) -> None:
        code, out = run_scan({"a.txt": f"192{DOT}168{DOT}0{DOT}7\n100{DOT}101{DOT}2{DOT}3\n"})
        self.assertEqual(code, 1)
        self.assertIn("a.txt:1: private-ipv4", out)
        self.assertIn("a.txt:2: tailnet-ipv4", out)
        self.assertNotIn("public-ipv4", out)

    def test_public_address_mac_and_hostnames_are_flagged(self) -> None:
        text = f"93{DOT}184{DOT}216{DOT}34\n3c:52:a1:09:7f:e4\nbox{DOT}ts{DOT}net\nprinter{DOT}local\n"
        code, out = run_scan({"a.txt": text})
        self.assertEqual(code, 1)
        for kind in ("public-ipv4", "mac-address", "tailnet-hostname", "mdns-hostname"):
            self.assertIn(kind, out)


class Allowances(unittest.TestCase):
    def test_inline_marker_skips_the_line(self) -> None:
        self.assertEqual(run_scan({"a.txt": f"192{DOT}168{DOT}0{DOT}7 # topology-ok: vendor default\n"})[0], 0)

    def test_allow_file_glob_skips_matching_paths_only(self) -> None:
        files = {".private-topology-allow": "# parser vectors\ntests/**\n", "tests/v.txt": f"192{DOT}168{DOT}0{DOT}7\n", "src/v.txt": f"192{DOT}168{DOT}0{DOT}8\n"}
        code, out = run_scan(files)
        self.assertEqual(code, 1)
        self.assertIn("src/v.txt:1", out)
        self.assertNotIn("tests/v.txt", out)

    def test_lockfiles_are_skipped(self) -> None:
        self.assertEqual(run_scan({"package-lock.json": '"author": "a@real-corp.io"\n'.replace(".io", f"{DOT}io")})[0], 0)


class Denylist(unittest.TestCase):
    def test_denylisted_name_is_reported_without_its_value(self) -> None:
        code, out = run_scan({"a.txt": "ssh seedhost-alpha\n"}, denylist="# comment\nseedhost-alpha\n")
        self.assertEqual(code, 1)
        self.assertIn("a.txt:1: denylisted-name (value hidden)", out)
        self.assertNotIn("seedhost-alpha", out)

    def test_denylisted_name_in_path_is_reported(self) -> None:
        code, out = run_scan({"seedhost-alpha.txt": "clean\n"}, denylist="seedhost-alpha\n")
        self.assertEqual(code, 1)
        self.assertIn("denylisted-name in path", out)

    def test_name_inside_longer_word_is_not_matched(self) -> None:
        self.assertEqual(run_scan({"a.txt": "seedhost-alphabet\n"}, denylist="seedhost-alpha\n")[0], 0)

    def test_missing_denylist_exits_2_only_when_required(self) -> None:
        self.assertEqual(run_scan({"a.txt": "x\n"})[0], 0)
        self.assertEqual(run_scan({"a.txt": "x\n"}, require_denylist=True)[0], 2)


class SelfTest(unittest.TestCase):
    def test_self_test_passes(self) -> None:
        self.assertEqual(topo.self_test(), 0)


class Hardening(unittest.TestCase):
    def test_long_token_is_scanned_in_linear_time(self) -> None:
        blob = "a" * 400_000
        started = time.monotonic()
        code, _ = run_scan({"blob.txt": f"{blob}\n{blob}-{blob}\n"})
        self.assertEqual(code, 0)
        self.assertLess(time.monotonic() - started, 10)

    def test_compressed_ipv6_prefixes_are_flagged(self) -> None:
        for line in ("AllowedIPs = fd12::/64", "gw fe80::1%eth0", "net fc00::", "fd12:3456:789a:1:2:3:4:5"):
            code, out = run_scan({"w.conf": f"{line}\n"})
            self.assertEqual(code, 1, line)
            self.assertIn("ipv6-private", out)

    def test_ipv6_look_alikes_are_not_flagged(self) -> None:
        lines = "fe80 fd12: label\nfdab:cd\nif addr.startswith('fe80::'):\nservice _androidtvremote2._tcp.local. and _udp.local\n.claude/settings.local.json\n"
        self.assertEqual(run_scan({"a.txt": lines})[0], 0)

    def test_denylisted_names_never_reach_the_output(self) -> None:
        code, out = run_scan({"seedhost-alpha.txt": "x\n", "b.txt": f"seedhost-alpha{DOT}ts{DOT}net\n"}, denylist="seedhost-alpha\n")
        self.assertEqual(code, 1)
        self.assertNotIn("seedhost-alpha", out)
        self.assertIn("tailnet-hostname", out)

    def test_symlink_is_scanned_as_its_target_string(self) -> None:
        code, out = run_scan({}, symlinks={"config-link": f"/srv/192{DOT}168{DOT}1{DOT}20/config.yaml"})
        self.assertEqual(code, 1)
        self.assertIn("private-ipv4", out)


if __name__ == "__main__":
    unittest.main()
