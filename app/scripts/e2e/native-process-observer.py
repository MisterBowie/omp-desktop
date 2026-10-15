#!/usr/bin/env python3
"""Read process identity/parent/executable metadata, never argv or environment."""
import ctypes
import json
import os
import sys

import psutil

if psutil.__version__ != "7.2.2":
    raise RuntimeError("install the pinned e2e/requirements.txt observer")


def windows_birth(pid):
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.GetProcessTimes.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return None
    try:
        created, exited, kernel_time, user_time = [wintypes.FILETIME() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                                      ctypes.byref(kernel_time), ctypes.byref(user_time)):
            return None
        return str((created.dwHighDateTime << 32) | created.dwLowDateTime)
    finally:
        kernel.CloseHandle(handle)


rows = []
for process in psutil.process_iter(["pid", "ppid", "create_time", "exe", "status"], ad_value=None):
    try:
        info = process.info
        birth = windows_birth(process.pid) if os.name == "nt" else repr(info["create_time"]) if info["create_time"] is not None else None
        try:
            group = os.getpgid(process.pid) if os.name != "nt" else process.pid
        except (ProcessLookupError, PermissionError):
            group = 0
        state = "Z" if info["status"] == psutil.STATUS_ZOMBIE else "X" if info["status"] == psutil.STATUS_DEAD else "R"
        executable = info["exe"] or ""
        if os.name == "nt" and executable:
            executable = os.path.realpath(executable)
        rows.append({"pid": process.pid, "ppid": info["ppid"] or 0, "pgid": group,
                     "starttime": birth or "", "state": state, "exe": executable})
    except psutil.NoSuchProcess:
        continue
print(json.dumps({"observer": "psutil/7.2.2", "platform": sys.platform, "rows": rows}))
