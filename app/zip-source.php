<?php
declare(strict_types=1);
function public_ip(string $ip): bool
{
    if (
        !filter_var(
            $ip,
            FILTER_VALIDATE_IP,
            FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE,
        )
    ) {
        return false;
    }
    if (str_contains($ip, ":")) {
        $packed = inet_pton($ip);
        // Allow global-unicast IPv6 only; reject mapped IPv4, NAT64, ULA and transition ranges.
        if ((ord($packed[0]) & 0xe0) !== 0x20) {
            return false;
        }
        $hex = bin2hex($packed);
        if (
            str_starts_with($hex, "20010000") ||
            str_starts_with($hex, "20010db8") ||
            str_starts_with($hex, "2002")
        ) {
            return false;
        }
    } else {
        $n = (int) sprintf("%u", ip2long($ip));
        foreach (
            [
                ["100.64.0.0", 10],
                ["192.0.0.0", 24],
                ["192.0.2.0", 24],
                ["198.18.0.0", 15],
                ["198.51.100.0", 24],
                ["203.0.113.0", 24],
                ["224.0.0.0", 4],
                ["240.0.0.0", 4],
            ]
            as [$base, $bits]
        ) {
            $mask = (0xffffffff << (32 - $bits)) & 0xffffffff;
            if (($n & $mask) == ((int) sprintf("%u", ip2long($base)) & $mask)) {
                return false;
            }
        }
    }
    return true;
}
function zip_url_target(string $url): array
{
    if (strlen($url) > 2048 || preg_match('/[\x00-\x20\x7f]/', $url)) {
        throw new InvalidArgumentException("Invalid ZIP URL.");
    }
    $p = parse_url($url);
    if (
        !$p ||
        !in_array($p["scheme"] ?? "", ["http", "https"], true) ||
        isset($p["user"]) ||
        isset($p["pass"]) ||
        isset($p["fragment"])
    ) {
        throw new InvalidArgumentException(
            "Use a public HTTP or HTTPS ZIP URL without embedded credentials or fragments.",
        );
    }
    $host = strtolower(trim($p["host"] ?? "", "[]"));
    $port = $p["port"] ?? ($p["scheme"] === "https" ? 443 : 80);
    if (
        $port !== ($p["scheme"] === "https" ? 443 : 80) ||
        $host === "" ||
        preg_match("/[^a-z0-9.:-]/", $host)
    ) {
        throw new InvalidArgumentException(
            "ZIP URLs must use standard HTTP/HTTPS ports.",
        );
    }
    if (filter_var($host, FILTER_VALIDATE_IP)) {
        $ips = [$host];
    } else {
        if (
            !str_contains($host, ".") ||
            preg_match('/\.(localhost|local|internal|home|lan)$/', $host)
        ) {
            throw new InvalidArgumentException(
                "ZIP URL must point to a public host.",
            );
        }
        $records = dns_get_record($host, DNS_A | DNS_AAAA);
        $ips = [];
        foreach ($records ?: [] as $r) {
            if (isset($r["ip"])) {
                $ips[] = $r["ip"];
            }
            if (isset($r["ipv6"])) {
                $ips[] = $r["ipv6"];
            }
        }
    }
    if (!$ips) {
        throw new InvalidArgumentException("ZIP host could not be resolved.");
    }
    foreach ($ips as $ip) {
        if (!public_ip($ip)) {
            throw new InvalidArgumentException(
                "ZIP URLs cannot access private or reserved network addresses.",
            );
        }
    }
    return [$p, $host, $port, $ips[0]];
}
function redirect_zip_url(string $base, string $location): string
{
    if (preg_match("~^https?://~i", $location)) {
        return $location;
    }
    $p = parse_url($base);
    $origin = $p["scheme"] . "://" . $p["host"];
    if (str_starts_with($location, "//")) {
        return $p["scheme"] . ":" . $location;
    }
    if (str_starts_with($location, "/")) {
        return $origin . $location;
    }
    if (str_starts_with($location, "?")) {
        return $origin . ($p["path"] ?? "/") . $location;
    }
    return $origin .
        preg_replace('~/[^/]*$~', "/", $p["path"] ?? "/") .
        $location;
}
function download_zip(string $url): string
{
    $file = tempnam(ROOT . "/var/php-uploads", "import-");
    $deadline = microtime(true) + 25;
    try {
        for ($redirect = 0; $redirect <= 4; $redirect++) {
            [$p, $host, $port, $ip] = zip_url_target($url);
            $remaining = (int) ceil($deadline - microtime(true));
            if ($remaining < 1) {
                throw new InvalidArgumentException("ZIP download timed out.");
            }
            $out = fopen($file, "wb");
            $size = 0;
            $location = null;
            $tooLarge = false;
            $curl = curl_init($url);
            curl_setopt_array($curl, [
                CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
                CURLOPT_PROXY => "",
                CURLOPT_CONNECTTIMEOUT => min(5, $remaining),
                CURLOPT_TIMEOUT => $remaining,
                CURLOPT_SSL_VERIFYPEER => true,
                CURLOPT_SSL_VERIFYHOST => 2,
                CURLOPT_USERAGENT => "AIWorker-Scaffold/1.0",
                CURLOPT_RESOLVE => [
                    (str_contains($host, ":") ? "[" . $host . "]" : $host) .
                    ":" .
                    $port .
                    ":" .
                    (str_contains($ip, ":") ? "[" . $ip . "]" : $ip),
                ],
                CURLOPT_WRITEFUNCTION => function ($ch, $chunk) use (
                    $out,
                    &$size,
                    &$tooLarge,
                ) {
                    $size += strlen($chunk);
                    if ($size > 33554432) {
                        $tooLarge = true;
                        return 0;
                    }
                    return fwrite($out, $chunk);
                },
                CURLOPT_HEADERFUNCTION => function ($ch, $header) use (
                    &$location,
                    &$tooLarge,
                ) {
                    if (stripos($header, "Location:") === 0) {
                        $location = trim(substr($header, 9));
                    }
                    if (
                        stripos($header, "Content-Length:") === 0 &&
                        (int) trim(substr($header, 15)) > 33554432
                    ) {
                        $tooLarge = true;
                        return 0;
                    }
                    return strlen($header);
                },
            ]);
            $ok = curl_exec($curl);
            $status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
            curl_close($curl);
            fclose($out);
            if ($tooLarge) {
                throw new InvalidArgumentException(
                    "Remote ZIP exceeds 32 MiB.",
                );
            }
            if ($ok === false) {
                throw new InvalidArgumentException(
                    "Could not download the ZIP. Check the public URL and try again.",
                );
            }
            if (
                in_array($status, [301, 302, 303, 307, 308], true) &&
                $location !== null
            ) {
                $next = redirect_zip_url($url, $location);
                if (
                    $p["scheme"] === "https" &&
                    str_starts_with($next, "http:")
                ) {
                    throw new InvalidArgumentException(
                        "HTTPS ZIP redirects must remain HTTPS.",
                    );
                }
                $url = $next;
                continue;
            }
            if ($status !== 200) {
                throw new InvalidArgumentException(
                    "ZIP server returned HTTP " . $status . ".",
                );
            }
            validate_zip($file);
            return $file;
        }
        throw new InvalidArgumentException("ZIP URL has too many redirects.");
    } catch (Throwable $e) {
        @unlink($file);
        throw $e;
    }
}
