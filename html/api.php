<?php
declare(strict_types=1);
require __DIR__ . "/../app/bootstrap.php";
require __DIR__ . "/../app/workspace.php";
header("Cache-Control: no-store");
set_exception_handler(function (Throwable $e) {
    if ($e instanceof InvalidArgumentException) {
        fail($e->getMessage());
    }
    if ($e instanceof PDOException && ($e->errorInfo[1] ?? null) === 1062) {
        fail("This workspace is already assigned to a workload. Change the name or base directory, or include a unique ID.", 409);
    }
    error_log((string) $e);
    output(
        [
            "error" =>
                "Service temporarily unavailable. Check the application service and database connection.",
        ],
        503,
    );
});
session_boot();
$action = $_GET["action"] ?? "session";
$method = $_SERVER["REQUEST_METHOD"];
if ($method === "POST") {
    csrf();
    if (str_contains($_SERVER["CONTENT_TYPE"] ?? "", "application/json")) {
        $_POST =
            json_decode(
                file_get_contents("php://input"),
                true,
                32,
                JSON_THROW_ON_ERROR,
            ) ?? [];
    }
}
if ($action === "session") {
    if (!isset($_SESSION["uid"])) {
        output(["user" => null, "csrf" => $_SESSION["csrf"]]);
    }
    $u = user();
    output(["user" => $u, "csrf" => $_SESSION["csrf"]]);
}
if ($action === "login" && $method === "POST") {
    $name = bounded("username", 80);
    $ip = $_SERVER["REMOTE_ADDR"] ?? "unknown";
    $keys = [
        "login:ip:" . hash("sha256", $ip),
        "login:user:" . hash("sha256", strtolower($name)),
    ];
    foreach ($keys as $key) {
        $n = redis()->incr($key);
        if ($n === 1) {
            redis()->expire($key, 900);
        }
        if ($n > 15) {
            fail("Too many sign-in attempts. Try again in 15 minutes.", 429);
        }
    }
    $u = q("SELECT * FROM users WHERE username=?", [$name])->fetch();
    $valid = password_verify(
        (string) ($_POST["password"] ?? ""),
        $u["password_hash"] ??
            '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.',
    );
    if (!$u || !$u["active"] || !$valid) {
        audit("login.failed", $name);
        fail("Incorrect username or password.", 401);
    }
    session_regenerate_id(true);
    $_SESSION["uid"] = $u["id"];
    $_SESSION["version"] = $u["session_version"];
    $_SESSION["seen"] = time();
    $_SESSION["csrf"] = bin2hex(random_bytes(32));
    audit("login", $name);
    redis()->del($keys[1]);
    output(["ok" => true]);
}
$u = user();
require_once __DIR__ . "/../app/history-api.php";
history_api($action, $method, $u);
require_once __DIR__ . "/../app/lucky-api.php";
handle_lucky_action($action, $method, $u);
require_once __DIR__ . "/../app/suggestions-api.php";
suggestions_api($action, $method, $u);
if ($action === "logout" && $method === "POST") {
    audit("logout");
    $_SESSION = [];
    session_destroy();
    output(["ok" => true]);
}
if ($action === "catalog") {
    output([
        "projects_base" => $config["projects"],
        "lucky_model" => "gpt-5.6-terra",
        "models" => [
            "codex" => setting("models_codex", []),
            "claude" => setting("models_claude", []),
        ],
        "model_efforts" => setting("efforts_codex", []),
        "efforts" => [
            "codex" => ["low", "medium", "high", "xhigh"],
            "claude" => ["low", "medium", "high", "xhigh", "max"],
        ],
    ]);
}
if ($action === "health") {
    $heartbeat = redis()->get("worker:heartbeat");
    $queue = redis()->get("worker:queue");
    output([
        "worker" => $heartbeat ? json_decode($heartbeat, true) : null,
        "queue" => $queue === "ok",
        "database" => true,
        "redis" => true,
        "providers" => q("SELECT * FROM provider_state")->fetchAll(),
        "paused" => setting("paused", false),
        "parallel" => [
            "codex" => setting("parallel_codex", 1),
            "claude" => setting("parallel_claude", 1),
        ],
    ]);
}
if ($action === "jobs" && $method === "GET") {
    $where = [];
    $params = [];
    $view = $_GET["view"] ?? "active";
    if ($view === "active") {
        $where[] =
            "status NOT IN ('completed','cancelled','failed','deleting')";
    } elseif ($view === "completed") {
        $where[] = "status='completed'";
    } elseif ($view === "closed") {
        $where[] = "status IN ('cancelled','failed','deleting')";
    } elseif ($view !== "all") {
        fail("Unknown workload view.");
    }
    if (!empty($_GET["search"])) {
        $where[] = "(name LIKE ? OR slug LIKE ?)";
        $params[] = "%" . mb_substr($_GET["search"], 0, 160) . "%";
        $params[] = end($params);
    }
    foreach (["status", "provider"] as $f) {
        if (!empty($_GET[$f])) {
            $where[] = "$f=?";
            $params[] = $_GET[$f];
        }
    }
    $sql = $where ? " WHERE " . implode(" AND ", $where) : "";
    $page = max(1, (int) ($_GET["page"] ?? 1));
    $count = q("SELECT COUNT(*) FROM jobs" . $sql, $params)->fetchColumn();
    $jobs = q(
        "SELECT id,name,slug,workspace,provider,model,status,summary,created_at,updated_at,retry_at,agents,dynamic_work FROM jobs" .
            $sql .
            " ORDER BY id DESC LIMIT 50 OFFSET " .
            ($page - 1) * 50,
        $params,
    )->fetchAll();
    output([
        "jobs" => $jobs,
        "total" => $count,
        "page" => $page,
        "counts" => q(
            "SELECT status,COUNT(*) AS n FROM jobs GROUP BY status",
        )->fetchAll(),
    ]);
}
if ($action === "create" && $method === "POST") {
    $name = bounded("name", 160);
    $prompt = bounded("prompt", 100000);
    $provider = bounded("provider", 20);
    if (!in_array($provider, ["codex", "claude"], true)) {
        fail("Unknown provider.");
    }
    $model = bounded("model", 100);
    if (!in_array($model, setting("models_" . $provider, []), true)) {
        fail("Choose a configured model.");
    }
    $effort = bounded("effort", 20);
    if (
        !in_array(
            $effort,
            $provider === "codex"
                ? setting("efforts_codex", [])[$model] ?? [
                        "low",
                        "medium",
                        "high",
                        "xhigh",
                    ]
                : ["low", "medium", "high", "xhigh", "max"],
            true,
        )
    ) {
        fail("Unsupported thinking effort.");
    }
    $mode = bounded("mode", 40);
    if (!in_array($mode, ["auto", "bypass", "yolo"], true)) {
        fail("Unsupported mode.");
    }
    $agents = !empty($_POST["agents"]) ? 1 : 0;
    if ($effort === "ultra" && !$agents) {
        fail("Ultra thinking requires agents enabled.");
    }
    $dynamic = $provider === "claude" && !empty($_POST["dynamic_work"]) ? 1 : 0;
    $base = project_base(bounded("workspace_base", 512, false) ?: $config["projects"]);
    $unique = (string) ($_POST["include_unique_id"] ?? "1");
    if (!in_array($unique, ["0", "1"], true)) {
        fail("Invalid unique-ID option.");
    }
    $slug = project_folder($name, $unique === "1");
    $workspace = $base . "/" . $slug;
    if (q("SELECT id FROM jobs WHERE workspace=?", [$workspace])->fetchColumn()) {
        fail("This workspace already exists. Change the name or base directory, or include a unique ID.", 409);
    }
    $zip = null;
    $filename = null;
    $source = bounded("scaffold_source", 20, false) ?: "upload";
    $luckyId = bounded("lucky_id", 36, false);
    if (!in_array($source, ["none", "upload", "url", "kawaiipantsu", "generated"], true)) {
        fail("Choose a scaffolding source.");
    }
    if (
        $source === "upload" &&
        isset($_FILES["zip"]) &&
        $_FILES["zip"]["error"] !== UPLOAD_ERR_NO_FILE
    ) {
        $f = $_FILES["zip"];
        if ($f["error"] !== UPLOAD_ERR_OK || $f["size"] > 33554432) {
            fail("Upload failed. Maximum ZIP size is 32 MiB.");
        }
        validate_zip($f["tmp_name"]);
        $zip = file_get_contents($f["tmp_name"]);
        $filename = basename($f["name"]);
    } elseif ($source === "url" || $source === "kawaiipantsu") {
        require_once __DIR__ . "/../app/zip-source.php";
        $url = $source === "kawaiipantsu"
            ? "https://github.com/kawaiipantsu/ai-project-scaffold/releases/latest/download/scaffold.zip"
            : bounded("zip_url", 2048);
        session_write_close();
        $tmp = download_zip($url);
        try {
            $zip = file_get_contents($tmp);
            $filename = $source === "kawaiipantsu"
                ? "kawaiipantsu-scaffold.zip"
                : "imported-scaffold.zip";
        } finally {
            unlink($tmp);
        }
    } elseif ($source === "generated") {
        $draft = q(
            "SELECT scaffold FROM lucky_drafts WHERE id=? AND user_id=? AND status='ready'",
            [$luckyId, $u["id"]],
        )->fetch();
        if (!$draft || $draft["scaffold"] === null) {
            fail(
                "Generated scaffolding is no longer available. Generate another idea.",
            );
        }
        $zip = $draft["scaffold"];
        $filename = "generated-scaffold.zip";
        $tmp = tempnam(ROOT . "/var/php-uploads", "generated-");
        try {
            file_put_contents($tmp, $zip);
            validate_zip($tmp);
        } finally {
            unlink($tmp);
        }
    }
    db()->beginTransaction();
    if ($luckyId !== "") {
        $draft = q(
            "SELECT id FROM lucky_drafts WHERE id=? AND (user_id=? OR EXISTS (SELECT 1 FROM suggestions WHERE draft_id=lucky_drafts.id)) AND status='ready' FOR UPDATE",
            [$luckyId, $u["id"]],
        )->fetch();
        if (!$draft) {
            fail(
                "This draft was already created or aborted. Generate a new idea.",
                409,
            );
        }
        q("UPDATE lucky_drafts SET status='used' WHERE id=?", [$luckyId]);
    }
    q(
        "INSERT INTO jobs(name,slug,workspace,prompt,provider,model,mode,effort,agents,dynamic_work,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        [
            $name,
            $slug,
            $workspace,
            $prompt,
            $provider,
            $model,
            $mode,
            $effort,
            $agents,
            $dynamic,
            $u["id"],
        ],
    );
    $id = (int) db()->lastInsertId();
    if ($zip !== null) {
        q("INSERT INTO uploads(job_id,filename,data) VALUES(?,?,?)", [
            $id,
            $filename,
            $zip,
        ]);
    }
    audit("job.create", (string) $id, $name);
    db()->commit();
    output(["id" => $id, "slug" => $slug, "workspace" => $workspace], 201);
}
$id = (int) ($_GET["id"] ?? 0);
if (
    in_array($action, ["job", "events", "message", "answer", "control"], true)
) {
    $job = q("SELECT * FROM jobs WHERE id=?", [$id])->fetch();
    if (!$job) {
        fail("Workload not found.", 404);
    }
}
if ($action === "job") {
    output([
        "job" => $job,
        "questions" => q("SELECT * FROM questions WHERE job_id=? ORDER BY id", [
            $id,
        ])->fetchAll(),
        "messages" => q(
            "SELECT m.*,u.username FROM messages m JOIN users u ON u.id=m.user_id WHERE job_id=? ORDER BY id DESC LIMIT 50",
            [$id],
        )->fetchAll(),
    ]);
}
if ($action === "events") {
    session_write_close();
    output([
        "events" => q(
            "SELECT * FROM events WHERE job_id=? AND id>? ORDER BY id LIMIT 250",
            [$id, max(0, (int) ($_GET["after"] ?? 0))],
        )->fetchAll(),
    ]);
}
if ($action === "message" && $method === "POST") {
    $body = bounded("body", 16000);
    db()->beginTransaction();
    if (
        q("SELECT status FROM jobs WHERE id=? FOR UPDATE", [
            $id,
        ])->fetchColumn() === "deleting"
    ) {
        fail("This project is being deleted.", 409);
    }
    q("INSERT INTO messages(job_id,user_id,body) VALUES(?,?,?)", [
        $id,
        $u["id"],
        $body,
    ]);
    q(
        "UPDATE jobs SET status=IF(status IN ('completed','failed','cancelled','waiting_input'),'queued',status),queued_at=NULL,finished_at=NULL WHERE id=?",
        [$id],
    );
    audit("job.message", (string) $id);
    db()->commit();
    output(["ok" => true]);
}
if ($action === "answer" && $method === "POST") {
    $body = bounded("body", 16000);
    db()->beginTransaction();
    if (
        q("SELECT status FROM jobs WHERE id=? FOR UPDATE", [
            $id,
        ])->fetchColumn() === "deleting"
    ) {
        fail("This project is being deleted.", 409);
    }
    $s = q(
        "UPDATE questions SET answer=?,answered_by=?,answered_at=NOW(3) WHERE id=? AND job_id=? AND answer IS NULL",
        [$body, $u["id"], (int) ($_POST["question_id"] ?? 0), $id],
    );
    if (!$s->rowCount()) {
        db()->rollBack();
        fail("Question already answered or missing.");
    }
    q("INSERT INTO messages(job_id,user_id,body) VALUES(?,?,?)", [
        $id,
        $u["id"],
        "Answer to question #" . (int) $_POST["question_id"] . ": " . $body,
    ]);
    q(
        "UPDATE jobs SET status=IF(status='waiting_input','queued',status),queued_at=NULL WHERE id=?",
        [$id],
    );
    audit("job.answer", (string) $id);
    db()->commit();
    output(["ok" => true]);
}
if ($action === "control" && $method === "POST") {
    $cmd = bounded("command", 20);
    if (
        !in_array($cmd, ["pause", "resume", "cancel", "retry", "steer"], true)
    ) {
        fail("Unknown control.");
    }
    db()->beginTransaction();
    $current = q("SELECT status FROM jobs WHERE id=? FOR UPDATE", [
        $id,
    ])->fetchColumn();
    if ($current === "deleting") {
        fail("This project is being deleted.", 409);
    }
    if (in_array($cmd, ["resume", "retry"], true)) {
        if (in_array($current, ["running", "preparing"], true)) {
            fail("Stop the active worker first.", 409);
        }
        q(
            "UPDATE jobs SET status='queued',control=NULL,retry_at=NULL,queued_at=NULL,finished_at=NULL WHERE id=?",
            [$id],
        );
    } elseif (in_array($current, ["running", "preparing"], true)) {
        q("UPDATE jobs SET control=? WHERE id=?", [$cmd, $id]);
    } elseif ($cmd !== "steer") {
        q(
            "UPDATE jobs SET status=?,control=NULL,finished_at=IF(?='cancel',NOW(3),NULL) WHERE id=?",
            [$cmd === "pause" ? "paused" : "cancelled", $cmd, $id],
        );
    }
    audit("job." . $cmd, (string) $id);
    db()->commit();
    output(["ok" => true]);
}
if ($action === "password" && $method === "POST") {
    $current = q("SELECT password_hash FROM users WHERE id=?", [
        $u["id"],
    ])->fetchColumn();
    if (!password_verify((string) ($_POST["current"] ?? ""), $current)) {
        fail("Current password is incorrect.");
    }
    $password = bounded("password", 200);
    if (strlen($password) < 14) {
        fail("Use at least 14 characters.");
    }
    q(
        "UPDATE users SET password_hash=?,session_version=session_version+1 WHERE id=?",
        [password_hash($password, PASSWORD_ARGON2ID), $u["id"]],
    );
    $_SESSION["version"]++;
    audit("password.change");
    output(["ok" => true]);
}
admin($u);
if ($action === "admin") {
    output([
        "settings" => q("SELECT * FROM settings")->fetchAll(),
        "users" => q(
            "SELECT id,username,role,active,created_at FROM users",
        )->fetchAll(),
        "webhooks" => q(
            "SELECT id,name,enabled,created_at FROM webhooks",
        )->fetchAll(),
        "audit" => q(
            "SELECT a.*,u.username FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 150",
        )->fetchAll(),
        "deliveries" => q(
            "SELECT id,webhook_id,job_id,status,attempts,delivered_at,last_error FROM webhook_deliveries ORDER BY id DESC LIMIT 30",
        )->fetchAll(),
    ]);
}
if ($action === "settings" && $method === "POST") {
    foreach (["parallel_codex", "parallel_claude", "retry_seconds"] as $k) {
        $v = (int) ($_POST[$k] ?? 0);
        if ($v < 1 || $v > ($k === "retry_seconds" ? 86400 : 16)) {
            fail("Setting out of range: " . $k);
        }
    }
    db()->beginTransaction();
    foreach (
        [
            "parallel_codex",
            "parallel_claude",
            "retry_seconds",
            "paused",
            "models_codex",
            "models_claude",
        ]
        as $k
    ) {
        $v = $_POST[$k] ?? null;
        if (str_starts_with($k, "models_")) {
            if (!is_array($v) || !count($v) || count($v) > 30) {
                fail("Model list must contain 1–30 models.");
            }
            foreach ($v as $m) {
                if (
                    !is_string($m) ||
                    !preg_match('/^[a-zA-Z0-9_.:-]{1,100}$/', $m)
                ) {
                    fail("Invalid model identifier.");
                }
            }
        } elseif ($k === "paused") {
            $v = (bool) $v;
        } else {
            $v = (int) $v;
        }
        q(
            "INSERT INTO settings(`key`,value) VALUES(?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
            [$k, json_encode($v)],
        );
    }
    audit("settings.update");
    db()->commit();
    output(["ok" => true]);
}
if ($action === "user_save" && $method === "POST") {
    $uid = (int) ($_POST["id"] ?? 0);
    $name = bounded("username", 80);
    $role = bounded("role", 20);
    if (
        !preg_match('/^[A-Za-z0-9_.-]{3,80}$/', $name) ||
        !in_array($role, ["admin", "operator"], true)
    ) {
        fail("Invalid account details.");
    }
    $active = !empty($_POST["active"]) ? 1 : 0;
    if ($uid === $u["id"] && (!$active || $role !== "admin")) {
        fail("You cannot disable or demote your current account.");
    }
    $pw = bounded("password", 200, false);
    if (($uid === 0 || $pw !== "") && strlen($pw) < 14) {
        fail("Use a password of at least 14 characters.");
    }
    if ($uid) {
        q(
            "UPDATE users SET username=?,role=?,active=?,session_version=session_version+1 WHERE id=?",
            [$name, $role, $active, $uid],
        );
        if ($pw !== "") {
            q("UPDATE users SET password_hash=? WHERE id=?", [
                password_hash($pw, PASSWORD_ARGON2ID),
                $uid,
            ]);
        }
        if ($uid === $u["id"]) {
            $_SESSION["version"]++;
        }
    } else {
        q(
            "INSERT INTO users(username,password_hash,role,active) VALUES(?,?,?,?)",
            [$name, password_hash($pw, PASSWORD_ARGON2ID), $role, $active],
        );
    }
    audit("user.save", (string) $uid, $name);
    output(["ok" => true]);
}
if ($action === "webhook_save" && $method === "POST") {
    $wid = (int) ($_POST["id"] ?? 0);
    $name = bounded("name", 80);
    $url = bounded("url", 500, false);
    if (
        $url !== "" &&
        !preg_match(
            '~^https://discord\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]+$~D',
            $url,
        )
    ) {
        fail("Use an HTTPS discord.com/api/webhooks URL.");
    }
    $enabled = !empty($_POST["enabled"]) ? 1 : 0;
    if ($wid) {
        q("UPDATE webhooks SET name=?,enabled=? WHERE id=?", [
            $name,
            $enabled,
            $wid,
        ]);
        if ($url !== "") {
            q("UPDATE webhooks SET url=? WHERE id=?", [$url, $wid]);
        }
    } else {
        if ($url === "") {
            fail("Webhook URL required.");
        }
        q("INSERT INTO webhooks(name,url,enabled) VALUES(?,?,?)", [
            $name,
            $url,
            $enabled,
        ]);
    }
    audit("webhook.save", (string) $wid, $name);
    output(["ok" => true]);
}
if ($action === "webhook_delete" && $method === "POST") {
    q("DELETE FROM webhooks WHERE id=?", [(int) ($_POST["id"] ?? 0)]);
    audit("webhook.delete", (string) ($_POST["id"] ?? 0));
    output(["ok" => true]);
}
if ($action === "provider_reset" && $method === "POST") {
    $p = bounded("provider", 20);
    q(
        "UPDATE provider_state SET cooldown_until=NULL,reason=NULL WHERE provider=?",
        [$p],
    );
    q(
        "UPDATE jobs SET retry_at=NULL,queued_at=NULL WHERE provider=? AND status='rate_limited'",
        [$p],
    );
    audit("provider.retry", $p);
    output(["ok" => true]);
}
fail("Endpoint not found.", 404);
