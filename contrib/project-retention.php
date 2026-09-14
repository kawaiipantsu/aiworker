#!/usr/bin/php
<?php
// Timer processes explicit deletions; age-based deletion requires the admin switch.
require __DIR__ . "/../app/bootstrap.php";
$apply = in_array("--apply", $argv, true);
if (!q("SELECT GET_LOCK('aiworker_project_retention',0)")->fetchColumn()) {
    exit(0);
}
try {
    $enabled = setting("cancelled_cleanup_enabled", false);
    $days = max(1, min(3650, (int) setting("cancelled_retention_days", 30)));
    $rows = q(
        "SELECT id FROM jobs WHERE status='deleting' OR (?=1 AND status='cancelled' AND COALESCE(finished_at,updated_at)<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL ? DAY)) ORDER BY id",
        [(int) $enabled, $days],
    )->fetchAll();
    echo ($apply ? "Applying" : "Dry run") .
        ": " .
        count($rows) .
        " project(s) eligible.\n";
    if (!$apply) {
        exit();
    }
    foreach ($rows as $row) {
        try {
            db()->beginTransaction();
            $job = q("SELECT * FROM jobs WHERE id=? FOR UPDATE", [
                $row["id"],
            ])->fetch();
            if (
                !$job ||
                !in_array($job["status"], ["cancelled", "deleting"], true)
            ) {
                db()->rollBack();
                continue;
            }
            // Recheck eligibility after obtaining the lock, including any administrator changes.
            if ($job["status"] === "cancelled") {
                if (
                    !setting("cancelled_cleanup_enabled", false) ||
                    !q(
                        "SELECT id FROM jobs WHERE id=? AND COALESCE(finished_at,updated_at)<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL ? DAY)",
                        [
                            $job["id"],
                            max(
                                1,
                                (int) setting("cancelled_retention_days", 30),
                            ),
                        ],
                    )->fetchColumn()
                ) {
                    db()->rollBack();
                    continue;
                }
            }
            $reason =
                $job["status"] === "deleting"
                    ? "manual or retried deletion"
                    : "cancelled retention: $days days";
            if ($job["status"] === "cancelled") {
                q(
                    "UPDATE jobs SET status='deleting',control=NULL,summary='Automatic retention: deletion queued.' WHERE id=?",
                    [$job["id"]],
                );
                audit("job.delete_requested", (string) $job["id"], $reason);
                db()->commit();
                db()->beginTransaction();
                $job = q("SELECT * FROM jobs WHERE id=? FOR UPDATE", [
                    $row["id"],
                ])->fetch();
                if (!$job || $job["status"] !== "deleting") {
                    db()->rollBack();
                    continue;
                }
            }
            $process = proc_open(
                [
                    "/usr/bin/python3",
                    __DIR__ . "/remove-workspace.py",
                    $job["workspace"],
                    (string) $job["id"],
                    (string) $job["workspace_ready"],
                ],
                [0 => ["pipe", "r"], 1 => ["pipe", "w"], 2 => ["pipe", "w"]],
                $pipes,
            );
            if (!is_resource($process)) {
                throw new RuntimeException("Cannot start workspace cleanup");
            }
            fclose($pipes[0]);
            stream_get_contents($pipes[1]);
            fclose($pipes[1]);
            $error = stream_get_contents($pipes[2]);
            fclose($pipes[2]);
            if (proc_close($process) !== 0) {
                throw new RuntimeException(
                    "Workspace removal failed; check permissions. " .
                        substr($error, -600),
                );
            }
            audit(
                "job.deleted",
                (string) $job["id"],
                json_encode(["slug" => $job["slug"], "reason" => $reason]),
            );
            q("DELETE FROM jobs WHERE id=?", [$job["id"]]);
            db()->commit();
            echo "Deleted project #" . $job["id"] . "\n";
        } catch (Throwable $e) {
            if (db()->inTransaction()) {
                db()->rollBack();
            }
            audit(
                "job.delete_failed",
                (string) $row["id"],
                substr($e->getMessage(), 0, 800),
            );
            fwrite(
                STDERR,
                "Deletion failed for #" . $row["id"] . ": see audit log.\n",
            );
        }
    }
} finally {
    q("SELECT RELEASE_LOCK('aiworker_project_retention')");
}
