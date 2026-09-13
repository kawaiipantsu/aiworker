#!/usr/bin/php
<?php
umask(0077);
require __DIR__ . "/../app/bootstrap.php";
if (PHP_SAPI !== "cli") {
    exit(1);
}
$username = $argv[1] ?? "admin";
$user = q("SELECT id FROM users WHERE username=?", [$username])->fetch();
if (!$user) {
    exit("User not found.\n");
}
$password = bin2hex(random_bytes(16));
q(
    "UPDATE users SET password_hash=?,session_version=session_version+1,active=1 WHERE id=?",
    [password_hash($password, PASSWORD_ARGON2ID), $user["id"]],
);
$file =
    ROOT .
    "/docs/" .
    ($username === "admin" ? "ADMIN_CREDS" : "RESET_CREDS") .
    ".md";
file_put_contents(
    $file,
    "# AI Worker account\n\nURL: {$config["url"]}\nUsername: $username\nPassword: $password\n",
);
chmod($file, 0600);
audit("password.reset", (string) $user["id"]);
echo "Password reset and sessions revoked. Credentials saved to $file\n";
