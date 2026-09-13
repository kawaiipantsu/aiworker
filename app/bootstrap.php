<?php
declare(strict_types=1);
const ROOT = __DIR__ . "/..";
$config = json_decode(
    file_get_contents(ROOT . "/etc/config.json"),
    true,
    512,
    JSON_THROW_ON_ERROR,
);
date_default_timezone_set("UTC");
function db(): PDO
{
    global $config;
    static $db;
    if (!$db) {
        $c = $config["db"];
        $db = new PDO(
            "mysql:host={$c["host"]};dbname={$c["database"]};charset=utf8mb4",
            $c["user"],
            $c["password"],
            [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_EMULATE_PREPARES => false,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            ],
        );
        $db->exec("SET time_zone='+00:00'");
    }
    return $db;
}
function q(string $sql, array $params = []): PDOStatement
{
    $s = db()->prepare($sql);
    $s->execute($params);
    return $s;
}
function redis(): Redis
{
    static $r;
    if (!$r) {
        $r = new Redis();
        $r->connect("127.0.0.1", 6379, 2);
        $r->select(5);
    }
    return $r;
}
function output(mixed $data, int $code = 200): never
{
    http_response_code($code);
    header("Content-Type: application/json; charset=utf-8");
    echo json_encode(
        $data,
        JSON_INVALID_UTF8_SUBSTITUTE | JSON_UNESCAPED_SLASHES,
    );
    exit();
}
function fail(string $message, int $code = 400): never
{
    output(["error" => $message], $code);
}
function audit(
    string $action,
    string $target = "",
    ?string $detail = null,
): void {
    q("INSERT INTO audit(user_id,action,target,ip,detail) VALUES(?,?,?,?,?)", [
        $_SESSION["uid"] ?? null,
        $action,
        $target,
        $_SERVER["REMOTE_ADDR"] ?? "local",
        $detail,
    ]);
}
function setting(string $key, mixed $default = null): mixed
{
    $v = q("SELECT value FROM settings WHERE `key`=?", [$key])->fetchColumn();
    return $v === false ? $default : json_decode($v, true);
}
function session_boot(): void
{
    ini_set("session.use_strict_mode", "1");
    ini_set("session.use_only_cookies", "1");
    ini_set("session.save_handler", "redis");
    ini_set(
        "session.save_path",
        "tcp://127.0.0.1:6379?database=5&prefix=aiworker_session:",
    );
    ini_set("redis.session.locking_enabled", "1");
    ini_set("session.gc_maxlifetime", "28800");
    session_name("aiworker_session");
    session_set_cookie_params([
        "lifetime" => 0,
        "path" => "/",
        "secure" => true,
        "httponly" => true,
        "samesite" => "Strict",
    ]);
    session_start();
    $_SESSION["csrf"] ??= bin2hex(random_bytes(32));
}
function user(): array
{
    $u = q(
        "SELECT id,username,role,active,session_version FROM users WHERE id=?",
        [$_SESSION["uid"] ?? 0],
    )->fetch();
    if (
        !$u ||
        !$u["active"] ||
        $u["session_version"] !== ($_SESSION["version"] ?? null) ||
        time() - ($_SESSION["seen"] ?? 0) > 28800
    ) {
        fail("Please sign in.", 401);
    }
    $_SESSION["seen"] = time();
    return $u;
}
function admin(array $u): void
{
    if ($u["role"] !== "admin") {
        fail("Administrator access required.", 403);
    }
}
function csrf(): void
{
    if (
        !hash_equals(
            $_SESSION["csrf"] ?? "",
            $_SERVER["HTTP_X_CSRF_TOKEN"] ?? "",
        )
    ) {
        fail("Invalid CSRF token. Reload the page.", 403);
    }
}
function bounded(string $key, int $max, bool $required = true): string
{
    $v = trim((string) ($_POST[$key] ?? ""));
    if (($required && $v === "") || mb_strlen($v) > $max) {
        fail("Invalid $key.");
    }
    return $v;
}
function validate_zip(string $file): void
{
    $z = new ZipArchive();
    if ($z->open($file) !== true) {
        throw new InvalidArgumentException("Invalid ZIP archive.");
    }
    $total = 0;
    if ($z->numFiles > 10000) {
        throw new InvalidArgumentException("ZIP contains too many entries.");
    }
    for ($i = 0; $i < $z->numFiles; $i++) {
        $s = $z->statIndex($i);
        $n = $s["name"];
        $z->getExternalAttributesIndex($i, $opsys, $attr);
        $type = ($attr >> 16) & 0170000;
        if (
            str_contains($n, "\\") ||
            str_contains($n, "\0") ||
            preg_match('~(^/|^[A-Za-z]:|(^|/)\.\.(/|$))~', $n) ||
            in_array($type, [0120000, 0060000, 0020000, 0010000], true)
        ) {
            throw new InvalidArgumentException(
                "ZIP contains an unsafe path or special file.",
            );
        }
        $total += $s["size"];
        if (
            $total > 268435456 ||
            ($s["size"] > 1048576 && $s["size"] / max(1, $s["comp_size"]) > 200)
        ) {
            throw new InvalidArgumentException(
                "ZIP expands beyond the allowed limits.",
            );
        }
    }
    $z->close();
}
