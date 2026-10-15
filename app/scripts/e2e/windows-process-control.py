#!/usr/bin/env python3
"""Reclaim explicitly owned test processes using pinned Win32 handles."""
import ctypes
import json
import os
import sys
from ctypes import wintypes

if sys.platform != "win32":
    raise RuntimeError("Windows process control requires its native host")

request = json.load(sys.stdin)
root = os.path.normcase(os.path.realpath(request["root"]))
if len(root) < 10 or not os.path.isdir(root) or not os.path.basename(root).startswith("omp-installed-"):
    raise RuntimeError("an existing unique test root is required")

kernel = ctypes.WinDLL("kernel32", use_last_error=True)
kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel.OpenProcess.restype = wintypes.HANDLE
kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
kernel.GetProcessTimes.restype = wintypes.BOOL
kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
kernel.QueryFullProcessImageNameW.restype = wintypes.BOOL
kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
kernel.TerminateProcess.restype = wintypes.BOOL
kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
kernel.WaitForSingleObject.restype = wintypes.DWORD
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
results = []
for record in request["processes"]:
    pid = record["pid"]
    expected_exe = os.path.normcase(os.path.realpath(record["exe"]))
    if not isinstance(pid, int) or pid <= 1 or pid in (os.getpid(), os.getppid()):
        raise RuntimeError("refusing a non-owned or observer pid")
    if os.path.commonpath([root, expected_exe]) != root or expected_exe == root:
        results.append({"pid": pid, "terminated": False, "refusedOutsideRoot": True,
                        "executable": expected_exe, "root": root})
        continue
    # QUERY_LIMITED_INFORMATION | TERMINATE | SYNCHRONIZE. From this point on
    # all observations and termination use this same handle, never a bare pid.
    handle = kernel.OpenProcess(0x1000 | 0x0001 | 0x00100000, False, pid)
    if not handle:
        results.append({"pid": pid, "terminated": False, "openError": ctypes.get_last_error()})
        continue
    try:
        created, exited, kernel_time, user_time = [wintypes.FILETIME() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel_time), ctypes.byref(user_time)):
            raise ctypes.WinError(ctypes.get_last_error())
        birth = str((created.dwHighDateTime << 32) | created.dwLowDateTime)
        path = ctypes.create_unicode_buffer(32768)
        length = wintypes.DWORD(len(path))
        if not kernel.QueryFullProcessImageNameW(handle, 0, path, ctypes.byref(length)):
            raise ctypes.WinError(ctypes.get_last_error())
        actual_exe = os.path.normcase(os.path.realpath(path.value))
        if birth != str(record["starttime"]) or actual_exe != expected_exe:
            results.append({"pid": pid, "terminated": False, "identityMismatch": True})
            continue
        if not kernel.TerminateProcess(handle, 1):
            raise ctypes.WinError(ctypes.get_last_error())
        results.append({"pid": pid, "terminated": True, "waitStatus": kernel.WaitForSingleObject(handle, 1000), "starttime": birth})
    finally:
        kernel.CloseHandle(handle)
print(json.dumps({"method": "pinned Win32 handle / exact FILETIME / exact owned executable", "results": results}))
