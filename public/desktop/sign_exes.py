# -*- coding: utf-8 -*-
"""Authenticode-sign the built OMM-ZEN executables.

Uses signtool.exe when the Windows SDK is installed (also the only path for
EV tokens / HSMs), otherwise falls back to PowerShell's
Set-AuthenticodeSignature (works with a .pfx or a certificate in the store).

Examples:
    # .pfx file (password via prompt-free env or --password)
    python desktop/sign_exes.py --pfx cert.pfx --password *** --all

    # certificate already installed (thumbprint from certmgr / Get-ChildItem)
    python desktop/sign_exes.py --thumbprint ABC123... --all

    # one file, custom timestamp service
    python desktop/sign_exes.py --pfx cert.pfx --dist dist/OMM-Planner.exe
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
DEFAULT_TS = "http://timestamp.digicert.com"


def find_signtool() -> str | None:
    found = shutil.which("signtool")
    if found:
        return found
    for base in (
        os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
        os.environ.get("ProgramFiles", r"C:\Program Files"),
    ):
        kits = Path(base) / "Windows Kits" / "10" / "bin"
        if kits.is_dir():
            exes = sorted(kits.glob("*/x64/signtool.exe"), reverse=True)
            if exes:
                return str(exes[0])
    return None


def sign_with_signtool(signtool: str, exe: Path, args: argparse.Namespace) -> None:
    cmd = [signtool, "sign", "/fd", "SHA256", "/tr", args.timestamp, "/td", "SHA256"]
    if args.pfx:
        cmd += ["/f", args.pfx]
        if args.password:
            cmd += ["/p", args.password]
    else:
        cmd += ["/sha1", args.thumbprint, "/s", "My"]
        if args.machine_store:
            cmd += ["/sm"]
    cmd.append(str(exe))
    subprocess.run(cmd, check=True)


def sign_with_powershell(exe: Path, args: argparse.Namespace) -> None:
    if args.pfx:
        # Set-AuthenticodeSignature cannot use a certificate object loaded
        # straight from a PFX (the key container is not persisted), so import it
        # into the user store for the duration of the signing call.
        script = (
            "$ErrorActionPreference = 'Stop'; "
            "$pw = ConvertTo-SecureString $env:OMM_SIGN_PW -AsPlainText -Force; "
            "$sig = Import-PfxCertificate -FilePath $env:OMM_SIGN_PFX "
            "-CertStoreLocation Cert:\\CurrentUser\\My -Password $pw; "
            "try { "
            "  Set-AuthenticodeSignature -FilePath $env:OMM_SIGN_FILE "
            "  -Certificate $sig -TimestampServer $env:OMM_SIGN_TS "
            "  -HashAlgorithm SHA256 | Out-Null "
            "} finally { "
            "  Remove-Item ('Cert:\\CurrentUser\\My\\' + $sig.Thumbprint) "
            "  -Force -ErrorAction SilentlyContinue "
            "}"
        )
        env = dict(os.environ)
        env["OMM_SIGN_FILE"] = str(exe)
        env["OMM_SIGN_TS"] = args.timestamp
        env["OMM_SIGN_PFX"] = str(Path(args.pfx).resolve())
        env["OMM_SIGN_PW"] = args.password or ""
    else:
        store = "LocalMachine" if args.machine_store else "CurrentUser"
        script = (
            "$ErrorActionPreference = 'Stop'; "
            "$sig = Get-ChildItem Cert:\\%s\\My | "
            "Where-Object Thumbprint -eq $env:OMM_SIGN_THUMB | Select-Object -First 1; "
            "if (-not $sig) { throw 'signing certificate not found' }; "
            "Set-AuthenticodeSignature -FilePath $env:OMM_SIGN_FILE "
            "-Certificate $sig -TimestampServer $env:OMM_SIGN_TS "
            "-HashAlgorithm SHA256 | Out-Null"
        ) % store
        env = dict(os.environ)
        env["OMM_SIGN_FILE"] = str(exe)
        env["OMM_SIGN_TS"] = args.timestamp
        env["OMM_SIGN_THUMB"] = args.thumbprint
    subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
        check=True,
        env=env,
    )


def verify(exe: Path) -> str:
    script = (
        "$r = Get-AuthenticodeSignature -FilePath $env:OMM_SIGN_FILE; "
        "Write-Output ($r.Status.ToString() + ' | ' + $r.SignerCertificate.Subject)"
    )
    env = dict(os.environ)
    env["OMM_SIGN_FILE"] = str(exe)
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command", script],
        capture_output=True,
        text=True,
        env=env,
    )
    return (out.stdout or out.stderr).strip()


def main() -> None:
    parser = argparse.ArgumentParser(description="Sign OMM-ZEN executables")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--pfx", help="PFX/P12 certificate file")
    group.add_argument("--thumbprint", help="thumbprint of a cert in the Windows store")
    parser.add_argument("--password", default=os.environ.get("OMM_SIGN_PASSWORD"),
                        help="PFX password (or set OMM_SIGN_PASSWORD)")
    parser.add_argument("--machine-store", action="store_true",
                        help="look in LocalMachine\\My instead of CurrentUser\\My")
    parser.add_argument("--timestamp", default=DEFAULT_TS, help="RFC3161 timestamp URL")
    parser.add_argument("--all", action="store_true", help="sign every dist/*.exe")
    parser.add_argument("files", nargs="*", help="specific .exe files")
    parser.add_argument("--signtool", default=None, help="path to signtool.exe")
    args = parser.parse_args()

    targets = [Path(f) for f in args.files]
    if args.all or not targets:
        targets = sorted(DIST.glob("*.exe"))
    if not targets:
        sys.exit("no .exe found in %s" % DIST)
    missing = [str(t) for t in targets if not t.is_file()]
    if missing:
        sys.exit("missing file(s): %s" % ", ".join(missing))

    signtool = args.signtool or find_signtool()
    if signtool:
        print("using signtool:", signtool)
    else:
        print("signtool not found, using PowerShell Set-AuthenticodeSignature "
              "(PFX/store certificates only)")

    failed = []
    for exe in targets:
        print("signing %s ..." % exe.name, flush=True)
        try:
            if signtool:
                sign_with_signtool(signtool, exe, args)
            else:
                sign_with_powershell(exe, args)
        except subprocess.CalledProcessError as exc:
            failed.append(exe.name)
            print("  FAILED (%s)" % exc, file=sys.stderr)
            continue
        print("  %s" % verify(exe), flush=True)

    if failed:
        sys.exit("failed: %s" % ", ".join(failed))
    print("done: %d file(s) signed" % len(targets))


if __name__ == "__main__":
    main()
