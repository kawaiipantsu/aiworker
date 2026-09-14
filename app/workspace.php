<?php
declare(strict_types=1);
function project_folder(string $name, bool $unique = true): string
{
    $name = strtolower(trim($name));
    $fqdn = rtrim($name, '.');
    $label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
    if (strlen($fqdn) <= 160 && preg_match('/^(?:' . $label . '\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/D', $fqdn)) {
        $slug = $fqdn;
    } else {
        $slug = trim(preg_replace('/[^a-z0-9]+/', '-', strtolower(iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $name))), '-');
        $slug = substr($slug ?: 'project', 0, 130);
    }
    return $slug . ($unique ? '-' . bin2hex(random_bytes(4)) : '');
}
function project_base(string $base): string
{
    $base = rtrim(trim($base), '/');
    if ($base === '' || $base[0] !== '/' || strlen($base) > 512 || preg_match('/[\x00-\x1f\x7f]/', $base)) {
        throw new InvalidArgumentException('Use an absolute workspace base directory, up to 512 characters.');
    }
    foreach (explode('/', substr($base, 1)) as $part) {
        if ($part === '' || $part === '.' || $part === '..') {
            throw new InvalidArgumentException('Use a workspace base directory without empty or dot segments.');
        }
    }
    // The isolated web process cannot inspect project directories. The worker
    // checks existence, canonical paths, permissions and filesystem collisions.
    return $base;
}
