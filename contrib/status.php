#!/usr/bin/php
<?php
require __DIR__ . "/../app/bootstrap.php";
try {
    $db = q("SELECT 1")->fetchColumn();
    $heartbeat = redis()->get("worker:heartbeat");
    $queue = redis()->get("worker:queue");
    echo json_encode(
        [
            "database" => (bool) $db,
            "redis" => true,
            "worker" => $heartbeat ? json_decode($heartbeat, true) : null,
            "beanstalk" => $queue,
            "jobs" => q(
                "SELECT provider,status,COUNT(*) AS count FROM jobs GROUP BY provider,status",
            )->fetchAll(),
            "providers" => q("SELECT * FROM provider_state")->fetchAll(),
        ],
        JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES,
    ) . "\n";
    exit($heartbeat && $queue === "ok" ? 0 : 1);
} catch (Throwable $e) {
    fwrite(STDERR, "Health check failed: " . $e->getMessage() . "\n");
    exit(1);
}
