#!/usr/bin/php
<?php
// Operator-only import of an existing authenticated Codex session.
require __DIR__ . "/../app/bootstrap.php";
require __DIR__ . "/../app/secrets.php";
if (PHP_SAPI !== "cli" || !isset($argv[1])) {
    exit("Usage: import-idea-login.php /private/path/to/auth.json\n");
}
$auth = json_decode(
    file_get_contents($argv[1]),
    true,
    512,
    JSON_THROW_ON_ERROR,
);
if (empty($auth["tokens"]["access_token"])) {
    throw new RuntimeException(
        "The file does not contain an OpenAI account session.",
    );
}
q(
    "UPDATE openai_connection SET mode='chatgpt',credential=?,label='Server OpenAI account',revision=revision+1,verified_at=NULL,last_error=NULL WHERE id=1",
    [seal_secret(json_encode($auth, JSON_THROW_ON_ERROR))],
);
audit("openai.login_imported", "idea-generator");
echo "OpenAI account imported into encrypted idea-generator storage. No tokens displayed.\n";
