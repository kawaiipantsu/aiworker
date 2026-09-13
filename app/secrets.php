<?php
declare(strict_types=1);
function seal_secret(string $value): string
{
    $key = file_get_contents(ROOT . "/etc/secrets.key");
    if (strlen($key) !== 32) {
        throw new RuntimeException("Credential encryption key is unavailable.");
    }
    $nonce = random_bytes(12);
    $tag = "";
    $encrypted = openssl_encrypt(
        $value,
        "aes-256-gcm",
        $key,
        OPENSSL_RAW_DATA,
        $nonce,
        $tag,
        "aiworker-openai-v1",
    );
    if ($encrypted === false) {
        throw new RuntimeException("Credential encryption failed.");
    }
    return base64_encode($nonce . $tag . $encrypted);
}
function connection_metadata(): array
{
    $row = q(
        "SELECT mode,label,verified_at,last_error,updated_at FROM openai_connection WHERE id=1",
    )->fetch();
    return ($row ?: [
            "mode" => "none",
            "label" => null,
            "verified_at" => null,
            "last_error" => null,
            "updated_at" => null,
        ]) + ["model" => "gpt-5.6-terra"];
}
function uuid(): string
{
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    $h = bin2hex($b);
    return substr($h, 0, 8) .
        "-" .
        substr($h, 8, 4) .
        "-" .
        substr($h, 12, 4) .
        "-" .
        substr($h, 16, 4) .
        "-" .
        substr($h, 20);
}
