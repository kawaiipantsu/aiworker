#!/usr/bin/php
<?php
// Dry-run by default. Never removes project workspaces, prompts, settings, questions or audit records.
require __DIR__ . "/../app/bootstrap.php";
$apply = in_array("--apply", $argv, true);
$days = 90;
foreach ($argv as $arg) {
    if (str_starts_with($arg, "--days=")) {
        $days = max(7, (int) substr($arg, 7));
    }
}
$count = q(
    "SELECT COUNT(*) FROM events e JOIN jobs j ON j.id=e.job_id WHERE j.status IN ('completed','cancelled','failed') AND e.created_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL ? DAY)",
    [$days],
)->fetchColumn();
echo ($apply ? "Applying" : "Dry run") .
    ": $count worker log events older than $days days eligible.\n";
if ($apply) {
    q(
        "DELETE e FROM events e JOIN jobs j ON j.id=e.job_id WHERE j.status IN ('completed','cancelled','failed') AND e.created_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL ? DAY)",
        [$days],
    );
    audit(
        "maintenance.cleanup",
        "events",
        "Retention: $days days; $count events",
    );
}
