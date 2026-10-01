"""Bounded regular-file export protocol, independently checked by the host.

This module never executes a payload. The same framing is used by the trusted
container exporter and the host validator, but both compute their own hashes.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import struct
import tempfile
import uuid

MAX_HEADER = 8192
MAX_FILES = 4096
MAX_BYTES = 64 * 1024 * 1024
MAX_ENTRIES = 8192
MAX_DEPTH = 24


class ExportRejected(ValueError):
    pass


def safe_path(value: object) -> str:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > 2048:
        raise ExportRejected("invalid path")
    parts = value.split("/")
    if len(parts) > MAX_DEPTH or any(p in ("", ".", "..") for p in parts):
        raise ExportRejected("absolute, traversal, empty, or deep path")
    if any(ord(c) < 32 or c in "\\:" for c in value):
        raise ExportRejected("unsafe path character")
    if any(len(p.encode("utf-8")) > 255 for p in parts):
        raise ExportRejected("overlong component")
    return value


def _identity(st):
    return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_nlink)


def _snapshot(root: Path, max_files=MAX_FILES, max_bytes=MAX_BYTES):
    """Open every component with NOFOLLOW; reject links and any special entry."""
    result = []
    total = 0
    entries = 0
    seen = set()
    def walk(directory_fd, prefix="", depth=0):
        nonlocal total, entries
        if depth > MAX_DEPTH:
            raise ExportRejected("directory depth limit")
        for name in sorted(os.listdir(directory_fd)):
            entries += 1
            if entries > MAX_ENTRIES:
                raise ExportRejected("entry limit")
            rel = safe_path(prefix + name)
            folded = rel.casefold()
            if folded in seen:
                raise ExportRejected("case-colliding path")
            seen.add(folded)
            info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
                try:
                    walk(child, rel + "/", depth + 1)
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                if len(result) >= max_files or total + info.st_size > max_bytes:
                    raise ExportRejected("file count or byte limit")
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
                try:
                    before = os.fstat(fd)
                    if _identity(before) != _identity(info) or not stat.S_ISREG(before.st_mode):
                        raise ExportRejected("file changed before read")
                    digest = hashlib.sha256()
                    size = 0
                    while chunk := os.read(fd, 65536):
                        size += len(chunk)
                        if size > info.st_size or total + size > max_bytes:
                            raise ExportRejected("file grew during read")
                        digest.update(chunk)
                    if size != info.st_size or _identity(os.fstat(fd)) != _identity(before):
                        raise ExportRejected("file changed during read")
                finally:
                    os.close(fd)
                total += size
                result.append({"path": rel, "size": size, "sha256": digest.hexdigest(), "identity": _identity(info)})
            else:
                raise ExportRejected("links and special files are forbidden")
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        walk(root_fd)
    finally:
        os.close(root_fd)
    return result


def _open_relative(root_fd, path):
    parts = safe_path(path).split("/")
    current = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            os.close(current)
            current = following
        return os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=current)
    finally:
        os.close(current)


def write_header(stream, header):
    data = json.dumps(header, separators=(",", ":")).encode()
    if len(data) > MAX_HEADER:
        raise ExportRejected("header limit")
    stream.write(struct.pack("!I", len(data)))
    stream.write(data)


def export_tree(root, stream, max_files=MAX_FILES, max_bytes=MAX_BYTES):
    """Called only after payload UID has been quiesced; detects later changes."""
    root = Path(root)
    snapshot = _snapshot(root, max_files, max_bytes)
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for entry in snapshot:
            fd = _open_relative(root_fd, entry["path"])
            try:
                if _identity(os.fstat(fd)) != entry["identity"]:
                    raise ExportRejected("file changed before export")
                write_header(stream, {"type": "file", **{k: entry[k] for k in ("path", "size", "sha256")}})
                remaining = entry["size"]
                digest = hashlib.sha256()
                while remaining:
                    chunk = os.read(fd, min(65536, remaining))
                    if not chunk:
                        raise ExportRejected("truncated file")
                    digest.update(chunk)
                    stream.write(chunk)
                    remaining -= len(chunk)
                if os.read(fd, 1) or digest.hexdigest() != entry["sha256"] or _identity(os.fstat(fd)) != entry["identity"]:
                    raise ExportRejected("file changed during export")
            finally:
                os.close(fd)
        if snapshot != _snapshot(root, max_files, max_bytes):
            raise ExportRejected("workspace changed during export")
        write_header(stream, {"type": "end", "count": len(snapshot), "bytes": sum(e["size"] for e in snapshot)})
        stream.flush()
    finally:
        os.close(root_fd)


def _exact(stream, size):
    result = bytearray()
    while len(result) < size:
        data = stream.read(size - len(result))
        if not data:
            raise ExportRejected("truncated export")
        result.extend(data)
    return bytes(result)


def validate_export(stream, destination: Path, max_files=MAX_FILES, max_bytes=MAX_BYTES):
    """Destination must be an empty, host-created directory, never payload owned."""
    if any(destination.iterdir()):
        raise ExportRejected("staging must be empty")
    manifest = []
    seen = set()
    path_kinds = {}
    total = 0
    while True:
        length = struct.unpack("!I", _exact(stream, 4))[0]
        if not 0 < length <= MAX_HEADER:
            raise ExportRejected("header limit")
        try:
            header = json.loads(_exact(stream, length))
        except (ValueError, UnicodeError) as exc:
            raise ExportRejected("invalid JSON header") from exc
        if not isinstance(header, dict):
            raise ExportRejected("header must be object")
        if header.get("type") == "end":
            if header != {"type": "end", "count": len(manifest), "bytes": total} or stream.read(1):
                raise ExportRejected("end manifest mismatch or trailing data")
            return manifest
        if set(header) != {"type", "path", "size", "sha256"} or header["type"] != "file":
            raise ExportRejected("unsupported record")
        path = safe_path(header["path"])
        folded = path.casefold()
        if folded in seen:
            raise ExportRejected("duplicate or case-colliding path")
        seen.add(folded)
        parts = path.split("/")
        for index in range(1, len(parts)):
            parent = "/".join(parts[:index]).casefold()
            if path_kinds.get(parent) == "file":
                raise ExportRejected("file-directory collision")
            path_kinds[parent] = "directory"
        if folded in path_kinds:
            raise ExportRejected("file-directory collision")
        path_kinds[folded] = "file"
        size = header["size"]
        if type(size) is not int or size < 0 or len(manifest) >= max_files or total + size > max_bytes:
            raise ExportRejected("file count or byte limit")
        claimed = header["sha256"]
        if not isinstance(claimed, str) or len(claimed) != 64 or any(c not in "0123456789abcdef" for c in claimed):
            raise ExportRejected("invalid hash")
        target = destination.joinpath(*parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        with target.open("xb") as output:
            remaining = size
            while remaining:
                chunk = _exact(stream, min(remaining, 65536))
                output.write(chunk)
                digest.update(chunk)
                remaining -= len(chunk)
            output.flush()
            os.fsync(output.fileno())
        if digest.hexdigest() != claimed:
            raise ExportRejected("host checksum mismatch")
        total += size
        manifest.append({k: header[k] for k in ("path", "size", "sha256")})


def commit_export(stream, revisions: Path, max_files=MAX_FILES, max_bytes=MAX_BYTES):
    """Publish only complete validated bytes; failures leave current.json unchanged."""
    revisions.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".staging-", dir=revisions))
    pointer_tmp = revisions / (".pointer-" + uuid.uuid4().hex)
    try:
        manifest = validate_export(stream, staging, max_files, max_bytes)
        revision_id = uuid.uuid4().hex
        final = revisions / revision_id
        os.replace(staging, final)
        pointer = {"revision": revision_id, "files": manifest}
        with pointer_tmp.open("x") as output:
            json.dump(pointer, output, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(pointer_tmp, revisions / "current.json")
        return pointer
    finally:
        if staging.exists():
            shutil.rmtree(staging)
        pointer_tmp.unlink(missing_ok=True)
