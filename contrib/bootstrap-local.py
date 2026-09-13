#!/usr/bin/env python3
"""Provision a fresh local MariaDB installation without printing credentials."""
import argparse
import grp
import json
import os
from pathlib import Path
import secrets
import subprocess
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True, help='Public HTTPS origin, e.g. https://aiworker.example.com')
    args = parser.parse_args()
    url = urlsplit(args.url)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ('', '/'):
        parser.error('--url must be an HTTPS origin without credentials, query, or path')
    if os.geteuid() != 0:
        parser.error('Run as root after creating the accounts and directories in INSTALL.md')
    os.umask(0o077)
    app_gid = grp.getgrnam('aiworker-app').gr_gid
    key_gid = grp.getgrnam('aiworker-credentials').gr_gid
    for name in ('etc/config.json', 'etc/secrets.key', 'docs/ADMIN_CREDS.md'):
        if os.path.lexists(ROOT / name):
            parser.error('Private installation files already exist; bootstrap will not overwrite them')
    for name in ('etc', 'docs', 'var'):
        if not (ROOT / name).is_dir():
            parser.error('Create installation directories using INSTALL.md first')

    def sql(query):
        result = subprocess.run(['mariadb', '--protocol=socket', '--batch', '--skip-column-names'],
                                input=query, text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError('Local MariaDB provisioning failed. Check socket root access and service status; database errors are suppressed to protect credentials.')
        return result.stdout.strip()

    if sql("SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='aiworker';") != '0':
        parser.error('Database aiworker already exists; bootstrap is for a fresh database only')
    if sql("SELECT COUNT(*) FROM mysql.user WHERE User='aiworker';") != '0':
        parser.error('MariaDB account aiworker already exists; refusing to change it')
    config = json.loads((ROOT / 'etc/config.example.json').read_text())
    config['url'] = args.url.rstrip('/')
    config['db']['password'] = secrets.token_hex(32)

    def private_file(name, data, gid):
        fd = os.open(ROOT / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
            os.fchown(handle.fileno(), 0, gid)
            os.fchmod(handle.fileno(), 0o640)

    private_file('etc/config.json', (json.dumps(config, indent=2) + '\n').encode(), app_gid)
    private_file('etc/secrets.key', secrets.token_bytes(32), key_gid)
    # Password is random hexadecimal, never shell-expanded or passed in argv.
    sql("CREATE DATABASE aiworker CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n"
        "CREATE USER 'aiworker'@'127.0.0.1' IDENTIFIED BY '" + config['db']['password'] + "';\n"
        "GRANT ALL PRIVILEGES ON aiworker.* TO 'aiworker'@'127.0.0.1';\n")
    result = subprocess.run(['php', str(ROOT / 'contrib/install.php')], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('Schema seeding failed. Private files are retained; resolve the database/PHP issue and rerun php contrib/install.php. No credentials were printed.')
    print('Local database, schema, defaults, and encryption key created. Read docs/ADMIN_CREDS.md privately as root.')


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as error:
        raise SystemExit(str(error)) from None
    except (OSError, KeyError):
        # Never echo subprocess output, configuration values, or raw DB exceptions.
        raise SystemExit('Bootstrap did not complete. Check local services, required groups, and file permissions. Private files, if created, were retained for recovery.') from None
