<?php
if (PHP_SAPI !== "cli") { http_response_code(404); exit(1); }
umask(0077);
require __DIR__ . "/../app/bootstrap.php";
db()->exec(file_get_contents(ROOT . "/app/schema.sql"));
q("INSERT IGNORE INTO openai_connection(id) VALUES(1)");
if (!q("SHOW COLUMNS FROM jobs LIKE 'rate_attempts'")->fetch()) {
    db()->exec(
        "ALTER TABLE jobs ADD COLUMN rate_attempts INT NOT NULL DEFAULT 0 AFTER attempts",
    );
}
foreach (
    [
        "parallel_codex" => 1,
        "parallel_claude" => 1,
        "retry_seconds" => 300,
        "models_codex" => ["gpt-6-astra", "gpt-5.6", "gpt-5.5"],
        "models_claude" => ["sonnet", "opus", "fable"],
        "paused" => false,
        "cancelled_cleanup_enabled" => false,
        "cancelled_retention_days" => 30,
    ]
    as $k => $v
) {
    q("INSERT IGNORE INTO settings(`key`,value) VALUES(?,?)", [
        $k,
        json_encode($v),
    ]);
}
foreach (["claude", "codex"] as $p) {
    q("INSERT IGNORE INTO provider_state(provider) VALUES(?)", [$p]);
}
$lock = fopen(ROOT . "/var/install.lock", "c");
if (!$lock || !flock($lock, LOCK_EX)) {
    throw new RuntimeException("Cannot lock installation.");
}
try {
    if (!q("SELECT id FROM users WHERE username='admin'")->fetchColumn()) {
        $file = ROOT . "/docs/ADMIN_CREDS.md";
        $handle = @fopen($file, "x");
        if (!$handle) {
            throw new RuntimeException("Cannot create private admin credentials; an existing file will not be overwritten.");
        }
        try {
            $pass = bin2hex(random_bytes(24));
            $text = "# AI Worker administrator\n\nURL: {$config['url']}\nUsername: admin\nPassword: $pass\n\nChange this password under Account after signing in.\n";
            if (fwrite($handle, $text) !== strlen($text) || !fflush($handle)) {
                throw new RuntimeException("Cannot save administrator credentials.");
            }
            q("INSERT INTO users(username,password_hash,role) VALUES(?,?,?)", [
                "admin", password_hash($pass, PASSWORD_ARGON2ID), "admin",
            ]);
        } catch (Throwable $error) {
            unlink($file);
            throw $error;
        } finally {
            fclose($handle);
        }
        echo "Database initialized. New administrator credentials saved privately to docs/ADMIN_CREDS.md.\n";
    } else {
        echo "Database initialized. Existing administrator and credentials file unchanged.\n";
    }
} finally {
    flock($lock, LOCK_UN);
    fclose($lock);
}
