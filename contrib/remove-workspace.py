#!/usr/bin/python3
"""Remove one direct project directory without following symbolic links."""
import os
import re
import shutil
import stat
import sys

slug = sys.argv[1]
if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', slug):
    raise ValueError('Invalid project slug')
if not shutil.rmtree.avoids_symlink_attacks:
    raise RuntimeError('This platform lacks safe directory deletion')
parent = os.open('/srv/projects', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    try:
        info = os.stat(slug, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        sys.exit(0)
    if stat.S_ISLNK(info.st_mode):
        os.unlink(slug, dir_fd=parent)
    elif stat.S_ISDIR(info.st_mode):
        shutil.rmtree(slug, dir_fd=parent)
    else:
        raise ValueError('Workspace is not a directory')
finally:
    os.close(parent)
