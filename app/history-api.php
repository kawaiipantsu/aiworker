<?php
declare(strict_types=1);
function history_api(string $action, string $method, array $u): void
{
    if ($action === "retention" && $method === "POST") {
        admin($u);
        $days = filter_var($_POST["days"] ?? null, FILTER_VALIDATE_INT);
        if ($days === false || $days < 1 || $days > 3650) {
            fail("Retention must be between 1 and 3650 days.");
        }
        db()->beginTransaction();
        foreach (
            [
                "cancelled_retention_days" => $days,
                "cancelled_cleanup_enabled" => !empty($_POST["enabled"]),
            ]
            as $key => $value
        ) {
            q(
                "INSERT INTO settings(`key`,value) VALUES(?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
                [$key, json_encode($value)],
            );
        }
        audit(
            "retention.update",
            "cancelled",
            json_encode([
                "enabled" => !empty($_POST["enabled"]),
                "days" => $days,
            ]),
        );
        db()->commit();
        output(["ok" => true]);
    }
    if ($action === "job_delete" && $method === "POST") {
        admin($u);
        $id = (int) ($_GET["id"] ?? 0);
        db()->beginTransaction();
        $job = q("SELECT * FROM jobs WHERE id=? FOR UPDATE", [$id])->fetch();
        if (!$job) {
            fail("Workload not found.", 404);
        }
        if ($job["status"] !== "cancelled") {
            fail(
                "Only cancelled projects can be deleted. Cancel the workload and wait for its worker to stop first.",
                409,
            );
        }
        q(
            "UPDATE jobs SET status='deleting',control=NULL,summary='Deletion queued: workspace and workload history will be removed.' WHERE id=?",
            [$id],
        );
        audit("job.delete_requested", (string) $id, $job["slug"]);
        db()->commit();
        output(["ok" => true], 202);
    }
    if ($action !== "completed_export" || $method !== "GET") {
        return;
    }
    $format = $_GET["format"] ?? "csv";
    if (!in_array($format, ["csv", "pdf"], true)) {
        fail("Unknown export format.");
    }
    $search = mb_substr((string) ($_GET["search"] ?? ""), 0, 160);
    $provider = (string) ($_GET["provider"] ?? "");
    if (!in_array($provider, ["", "codex", "claude"], true)) {
        fail("Unknown provider.");
    }
    $where = "status='completed'";
    $args = [];
    if ($search !== "") {
        $where .= " AND (name LIKE ? OR slug LIKE ?)";
        $args[] = "%$search%";
        $args[] = "%$search%";
    }
    if ($provider !== "") {
        $where .= " AND provider=?";
        $args[] = $provider;
    }
    $rows = q(
        "SELECT id,name,slug,provider,model,created_at,started_at,finished_at,summary FROM jobs WHERE $where ORDER BY finished_at DESC,id DESC",
        $args,
    )->fetchAll();
    audit("jobs.export", $format, count($rows) . " completed projects");
    session_write_close();
    $filename = "aiworker-completed-" . gmdate("Y-m-d") . "." . $format;
    if ($format === "csv") {
        header("Content-Type: text/csv; charset=utf-8");
        header('Content-Disposition: attachment; filename="' . $filename . '"');
        $out = fopen("php://output", "wb");
        fwrite($out, "\xEF\xBB\xBF");
        fputcsv(
            $out,
            [
                "ID",
                "Project",
                "Slug",
                "Provider",
                "Model",
                "Created (UTC)",
                "Started (UTC)",
                "Completed (UTC)",
                "Summary",
                "Workspace",
            ],
            ",",
            '"',
            "",
            "\r\n",
        );
        foreach ($rows as $r) {
            $r["workspace"] = "/srv/projects/" . $r["slug"];
            $values = array_map(function ($v) {
                $v = (string) ($v ?? "");
                // Prevent spreadsheet formula execution, including leading whitespace/control characters.
                return preg_match('/^[\s\x00-\x20]*[=+@-]|^[\t\r\n]/u', $v)
                    ? "'" . $v
                    : $v;
            }, array_values($r));
            fputcsv($out, $values, ",", '"', "", "\r\n");
        }
        fclose($out);
        exit();
    }
    require __DIR__ . "/completed-report.php";
    completed_pdf($rows, $search, $provider, $filename);
}
