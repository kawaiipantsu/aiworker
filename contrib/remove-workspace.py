#!/usr/bin/python3
"""Remove one direct project directory without following symbolic links."""
import os
import re
import shutil
import stat
import sys

workspace, job_id, ready = sys.argv[1:4]
base, slug = os.path.split(workspace)
if not os.path.isabs(workspace) or os.path.normpath(workspace) != workspace:
    raise ValueError('Invalid workspace path')
if not re.fullmatch(r'[a-z0-9][a-z0-9.-]*', slug):
    raise ValueError('Invalid project slug')
if not shutil.rmtree.avoids_symlink_attacks:
    raise RuntimeError('This platform lacks safe directory deletion')
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
parent = os.open('/', flags)
try:
    for component in base.split('/')[1:]:
        next_parent = os.open(component, flags, dir_fd=parent)
        os.close(parent)
        parent = next_parent
except FileNotFoundError:
    os.close(parent)
    sys.exit(0)
try:
    try:
        info = os.stat(slug, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        sys.exit(0)
    if ready != '1':
        # A failed creation must never delete a pre-existing unrelated directory.
        if not stat.S_ISDIR(info.st_mode):
            sys.exit(0)
        child = os.open(slug, flags, dir_fd=parent)
        try:
            try:
                owner = os.open('.aiworker-owner', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=child)
            except FileNotFoundError:
                sys.exit(0)
            with os.fdopen(owner) as handle:
                if handle.read(32) != job_id:
                    sys.exit(0)
        finally:
            os.close(child)
    if stat.S_ISLNK(info.st_mode):
        os.unlink(slug, dir_fd=parent)
    elif stat.S_ISDIR(info.st_mode):
        shutil.rmtree(slug, dir_fd=parent)
    else:
        raise ValueError('Workspace is not a directory')
finally:
    os.close(parent)
