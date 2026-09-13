#!/usr/bin/php
<?php
require __DIR__ . "/../app/bootstrap.php";
$id = (int) getenv("AIWORKER_JOB_ID");
if (!$id || PHP_SAPI !== "cli") {
    exit("AIWORKER_JOB_ID required.\n");
}
$action = $argv[1] ?? "help";
$body = trim(implode(" ", array_slice($argv, 2)));
if ($action === "status") {
    if (!$body) {
        exit("Usage: workload status MESSAGE\n");
    }
    q("UPDATE jobs SET summary=? WHERE id=?", [mb_substr($body, 0, 3000), $id]);
    q("INSERT INTO events(job_id,kind,body) VALUES(?,?,?)", [
        $id,
        "progress",
        $body,
    ]);
    echo "Status updated.\n";
} elseif ($action === "inbox") {
    db()->beginTransaction();
    $messages = q(
        "SELECT id,body FROM messages WHERE job_id=? AND delivered_at IS NULL ORDER BY id FOR UPDATE",
        [$id],
    )->fetchAll();
    foreach ($messages as $m) {
        q("UPDATE messages SET delivered_at=NOW(3) WHERE id=?", [$m["id"]]);
    }
    db()->commit();
    echo json_encode($messages, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) .
        "\n";
} elseif ($action === "ask") {
    if (!$body) {
        exit("Usage: workload ask QUESTION\n");
    }
    q("INSERT INTO questions(job_id,question) VALUES(?,?)", [$id, $body]);
    $qid = (int) db()->lastInsertId();
    q("INSERT INTO events(job_id,kind,body) VALUES(?,?,?)", [
        $id,
        "question",
        $body,
    ]);
    echo "Question $qid posted. Waiting for the website answer…\n";
    while (true) {
        $a = q("SELECT answer FROM questions WHERE id=?", [
            $qid,
        ])->fetchColumn();
        if ($a !== null && $a !== false) {
            echo $a . "\n";
            exit();
        }
        $j = q("SELECT status,control FROM jobs WHERE id=?", [$id])->fetch();
        if (
            !$j ||
            $j["control"] ||
            in_array($j["status"], ["paused", "cancelled", "failed"], true)
        ) {
            exit(2);
        }
        sleep(2);
    }
} else {
    echo "workload status MESSAGE | inbox | ask QUESTION\n";
}
